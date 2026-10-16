// SPDX-License-Identifier: Apache-2.0
/**
 * Hardened markdown-lite for transcript bodies (doc 05 §Markdown pipeline,
 * SECTION-3 §3.2 "markdown hardening" row, v1): a dependency-free pass toward
 * the OC sanitized react-markdown pipeline. Rules: NO raw HTML ever reaches
 * the DOM (no dangerouslySetInnerHTML), links are scheme-restricted to
 * http(s) (javascript:/data: collapse to inert text), and only the doc-05
 * copy-relevant inline set renders (bold/italic/inline-code/links) plus
 * fences, headings, lists, blockquotes, hr. Unknown syntax stays literal text.
 */
import { type ReactNode } from 'react';
import type { PreparedMarkdownImage } from './markdown-image-assets.ts';

const FENCE = /^```([\w-]*)\s*$/u;
const HEADING = /^(#{1,4})\s+(.*)$/u;
const LIST_ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/u;
const QUOTE = /^>\s?(.*)$/u;
const HR = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const INLINE = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\*[^*\n]+\*)|(\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/gu;

/** Scheme-restricted anchor: non-http(s) targets render as inert text. */
function safeHref(target: string): string | null {
  try {
    const url = new URL(target);
    return url.protocol === 'http:' || url.protocol === 'https:' ? target : null;
  } catch {
    return null;
  }
}

type PreparedImages = Map<string, PreparedMarkdownImage>;

const IMAGE = /^!\[([^\]]*)\]\((?:"([^"]*)"|'([^']*)'|([^\s)]+))\)$/u;

function isSafeHttpImageSource(source: string): boolean {
  try { return /^https?:$/u.test(new URL(source).protocol); } catch { return false; }
}

function isDataImageSource(source: string): boolean {
  return /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/u.test(source)
    && base64ToBytes(source.slice(source.indexOf(',') + 1)) <= 10 * 1024 * 1024;
}

function base64ToBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function preparedSourceForImage(source: string, images?: PreparedImages): string | null {
  if (isSafeHttpImageSource(source) || isDataImageSource(source)) return source;
  const prepared = images?.get(source);
  return prepared?.state === 'ready' ? prepared.src : null;
}

function imageFor(target: string, label: string, images?: PreparedImages, key = 0): ReactNode | null {
  const src = preparedSourceForImage(target, images);
  if (src === null) return null;
  return <img key={key} src={src} alt={label} className="max-h-96 max-w-full rounded-lg border border-border/50" loading="lazy" decoding="async" />;
}

/** Render one source line's inline segments into React nodes (no HTML strings). */
function renderInline(text: string, images?: PreparedImages): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > cursor) nodes.push(<span key={key++}>{text.slice(cursor, at)}</span>);
    const token = match[0];
    cursor = at + token.length;
    if (token.startsWith('**')) {
      nodes.push(<strong key={key++} className="font-semibold text-foreground">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key++} className="rounded bg-muted/90 px-1 py-0.5 font-mono text-[0.85em] text-amber-200">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key++} className="italic text-muted-foreground">{token.slice(1, -1)}</em>);
    } else {
      const label = token.slice(1, token.indexOf(']'));
      const target = token.slice(token.indexOf('(') + 1, -1);
      const href = safeHref(target);
      if (href === null) nodes.push(<span key={key++}>{label}</span>);
      else {
        nodes.push(
          <a key={key++} href={href} target="_blank" rel="noreferrer noopener nofollow" className="text-sky-400 underline decoration-sky-700 hover:text-sky-300">{label}</a>,
        );
      }
    }
  }
  const image = IMAGE.exec(text);
  if (image !== null) {
    const label = image[1] ?? image[2] ?? image[3] ?? '';
    const target = image[4] ?? image[5] ?? '';
    const preparedImage = imageFor(target, label, images, key);
    if (preparedImage !== null) return [preparedImage];
  }
  if (cursor < text.length) nodes.push(<span key={key++}>{text.slice(cursor)}</span>);
  return nodes;
}

interface Block {
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'ul' | 'ol' | 'quote' | 'code' | 'hr';
  text: string;
  lang?: string;
  items?: string[];
  ordered?: boolean;
}

/** Group raw lines into typed blocks; fences span until the closing fence. */
export function markdownBlocks(source: string): Block[] {
  const lines = source.split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { bucket: string[]; ordered: boolean } | null = null;
  const flushParagraph = (): void => {
    if (paragraph.length > 0) { blocks.push({ kind: 'p', text: paragraph.join('\n') }); paragraph = []; }
  };
  const flushList = (): void => {
    if (list && list.bucket.length > 0) blocks.push({ kind: list.ordered ? 'ol' : 'ul', text: '', items: list.bucket });
    list = null;
  };
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    const fence = FENCE.exec(line.trim());
    if (fence) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !/^```\s*$/u.test(lines[at]!.trim())) { body.push(lines[at]!); at += 1; }
      blocks.push({ kind: 'code', text: body.join('\n'), lang: fence[1] || undefined });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      blocks.push({ kind: `h${heading[1]!.length}` as 'h1' | 'h2' | 'h3' | 'h4', text: heading[2] ?? '' });
      continue;
    }
    if (HR.test(line.trim())) { flushParagraph(); flushList(); blocks.push({ kind: 'hr', text: '' }); continue; }
    const quote = QUOTE.exec(line);
    if (quote) { flushParagraph(); flushList(); blocks.push({ kind: 'quote', text: quote[1] ?? '' }); continue; }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const ordered = /\d/u.test(item[2]!.slice(0, 1));
      if (!list || list.ordered !== ordered) { flushList(); list = { bucket: [], ordered }; }
      list.bucket.push(item[3] ?? '');
      continue;
    }
    if (line.trim() === '') { flushParagraph(); flushList(); continue; }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** The renderer: blocks → styled React nodes. Never throws, never injects HTML. */
export function renderMarkdown(source: string, images?: PreparedImages): ReactNode[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  return markdownBlocks(source).map((block, index) => <MarkdownBlockView key={index} block={block} images={images} />);
}

export function MarkdownBlockView({ block, images }: { block: Block; images?: PreparedImages }): ReactNode {
  switch (block.kind) {
    case 'p': return <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{renderInline(block.text, images)}</p>;
    case 'code':
      return (
        <pre className="max-h-72 overflow-auto rounded-lg border border-border/40 p-2.5 text-[11.5px] leading-5" style={{ backgroundColor: 'var(--syntax-background)', color: 'var(--syntax-foreground)' }} data-code-lang={block.lang ?? 'plain'}>
          <code className="font-mono">{block.text}</code>
        </pre>
      );
    case 'ul':
      return <ul className="ml-4 list-disc space-y-0.5 text-sm leading-6 text-foreground">{(block.items ?? []).map((item, at) => <li key={at}>{renderInline(item, images)}</li>)}</ul>;
    case 'ol':
      return <ol className="ml-4 list-decimal space-y-0.5 text-sm leading-6 text-foreground">{(block.items ?? []).map((item, at) => <li key={at}>{renderInline(item, images)}</li>)}</ol>;
    case 'h1': return <h3 className="mt-1 text-base font-semibold text-foreground">{renderInline(block.text, images)}</h3>;
    case 'h2': return <h4 className="mt-1 text-sm font-semibold text-foreground">{renderInline(block.text, images)}</h4>;
    case 'h3': case 'h4': return <h5 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{renderInline(block.text, images)}</h5>;
    case 'quote': return <blockquote className="border-l-2 border-border/60 pl-3 text-[13px] leading-6 text-muted-foreground">{renderInline(block.text, images)}</blockquote>;
    case 'hr': return <hr className="border-border/50" />;
    default: return null;
  }
}
