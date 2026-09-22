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

/** Render one source line's inline segments into React nodes (no HTML strings). */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > cursor) nodes.push(<span key={key++}>{text.slice(cursor, at)}</span>);
    const token = match[0];
    cursor = at + token.length;
    if (token.startsWith('**')) {
      nodes.push(<strong key={key++} className="font-semibold text-neutral-100">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key++} className="rounded bg-neutral-800/90 px-1 py-0.5 font-mono text-[0.85em] text-amber-200">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key++} className="italic text-neutral-300">{token.slice(1, -1)}</em>);
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
export function renderMarkdown(source: string): ReactNode[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  return markdownBlocks(source).map((block, index) => <MarkdownBlockView key={index} block={block} />);
}

export function MarkdownBlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case 'p': return <p className="whitespace-pre-wrap break-words text-sm leading-6 text-neutral-200">{renderInline(block.text)}</p>;
    case 'code':
      return (
        <pre className="max-h-72 overflow-auto rounded-lg border border-white/10 bg-neutral-950/80 p-2.5 text-[11.5px] leading-5" data-code-lang={block.lang ?? 'plain'}>
          <code className="font-mono text-emerald-200/90">{block.text}</code>
        </pre>
      );
    case 'ul':
      return <ul className="ml-4 list-disc space-y-0.5 text-sm leading-6 text-neutral-200">{(block.items ?? []).map((item, at) => <li key={at}>{renderInline(item)}</li>)}</ul>;
    case 'ol':
      return <ol className="ml-4 list-decimal space-y-0.5 text-sm leading-6 text-neutral-200">{(block.items ?? []).map((item, at) => <li key={at}>{renderInline(item)}</li>)}</ol>;
    case 'h1': return <h3 className="mt-1 text-base font-semibold text-neutral-100">{renderInline(block.text)}</h3>;
    case 'h2': return <h4 className="mt-1 text-sm font-semibold text-neutral-100">{renderInline(block.text)}</h4>;
    case 'h3': case 'h4': return <h5 className="text-[13px] font-semibold uppercase tracking-wide text-neutral-300">{renderInline(block.text)}</h5>;
    case 'quote': return <blockquote className="border-l-2 border-white/15 pl-3 text-[13px] leading-6 text-neutral-400">{renderInline(block.text)}</blockquote>;
    case 'hr': return <hr className="border-white/10" />;
    default: return null;
  }
}
