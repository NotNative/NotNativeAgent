// SPDX-License-Identifier: Apache-2.0
/** §G.6 authoritative image-destination extraction from assistant markdown. */

const CODE_MARKERS = ["\u0060", "~"];

type Range = { start: number; end: number };
type Image = { destination: string; end: number };

export function collectMarkdownImageDestinations(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const codeRanges = collectCodeRanges(normalized);
  const labels = collectReferenceDefinitions(normalized, codeRanges);
  const destinations: string[] = [];
  const seen = new Set<string>();
  scanImages(normalized, labels, true, destinations, seen, codeRanges);
  scanImages(normalized, labels, false, destinations, seen, codeRanges);
  return destinations;
}

function collectReferenceDefinitions(text: string, codeRanges: readonly Range[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const range of lineRanges(text)) {
    if (codeRanges.some((code) => range.start >= code.start && range.end <= code.end)) continue;
    const line = text.slice(range.start, range.end);
    const definition = line.match(/^[ \t]{0,3}\[([^\[\]\n]+)\]:[ \t]+(.*)$/u);
    if (definition === null || definition[1] === undefined || definition[2] === undefined) continue;
    const destination = readDestination(definition[2], true);
    if (destination !== null) labels.set(normalizeLabel(definition[1]), destination);
  }
  return labels;
}

function scanImages(
  text: string,
  labels: Map<string, string>,
  referencesOnly: boolean,
  destinations: string[],
  seen: Set<string>,
  codeRanges: readonly Range[],
): void {
  let index = 0;
  while (index < text.length) {
    const codeRange = codeRanges.find((range) => index >= range.start && index < range.end);
    if (codeRange !== undefined) {
      index = codeRange.end;
      continue;
    }
    if (text[index] === "\\" && text[index + 1] !== undefined) {
      index += 2;
      continue;
    }
    if (text.slice(index, index + 2) === "![") {
      const image = parseImage(text, index, labels, referencesOnly);
      if (image === null) {
        index += 2;
      } else {
        if (!seen.has(image.destination)) {
          seen.add(image.destination);
          destinations.push(image.destination);
        }
        index = image.end;
      }
      continue;
    }
    index += 1;
  }
}

function collectCodeRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const lines: Array<{ start: number; end: number }> = [];
  let position = 0;
  const parts = text.split("\n");
  for (const line of parts) {
    lines.push({ start: position, end: position + line.length });
    if (position >= text.length) break;
    position += line.length + 1;
  }

  let fence: { marker: string; length: number } | null = null;
  let fencedStart = 0;
  let inlineCode: { marker: string; length: number; start: number } | null = null;
  for (const line of lines) {
    const content = text.slice(line.start, line.end);
    const markerMatch = content.match(/^[ \t]{0,3}([`~]{3,})[ \t]*(?:\S.*)?$/u);
    if (fence === null) {
      if (markerMatch === null) continue;
      const marker = markerMatch[1]?.[0] ?? "\u0060";
      fence = { marker, length: markerMatch[1]?.length ?? 3 };
      fencedStart = line.start;
      inlineCode = null;
      continue;
    }
    const closing = content.match(new RegExp(`^[ \t]{0,3}${escapeRegExp(fence.marker)}{${fence.length},}[ \t]*$`));
    if (closing !== null) {
      ranges.push({ start: fencedStart, end: line.end });
      fence = null;
      inlineCode = null;
      continue;
    }
  }
  if (fence !== null && lines.length > 0) {
    ranges.push({ start: fencedStart, end: lines[lines.length - 1]!.end });
  }

  for (const line of lines) {
    const fenced = ranges.some((range) => line.start >= range.start && line.end <= range.end);
    if (!fenced) {
      const inline = collectInlineCodeRanges(text, line, inlineCode);
      ranges.push(...inline.ranges);
      inlineCode = inline.open;
    }
  }
  return ranges;
}

function lineRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let position = 0;
  for (const line of text.split("\n")) {
    ranges.push({ start: position, end: position + line.length });
    if (position >= text.length) break;
    position += line.length + 1;
  }
  return ranges;
}

function collectInlineCodeRanges(text: string, line: { start: number; end: number }, state: InlineCodeOpen | null): {
  ranges: Range[];
  open: InlineCodeOpen | null;
} {
  const ranges: Range[] = [];
  let open = state;
  let index = line.start;
  while (index < line.end) {
    if (text[index] === "\\" && text[index + 1] !== undefined) {
      index += 2;
      continue;
    }
    const marker = text[index];
    if (marker !== "\u0060" && marker !== "~") {
      index += 1;
      continue;
    }
    let length = 1;
    while (text[index + length] === marker) length += 1;
    if (open !== null && open.marker === marker && open.length === length) {
      ranges.push({ start: open.start, end: index + length });
      open = null;
    } else if (open === null) {
      open = { marker, length, start: index };
    }
    index += length;
  }
  if (open !== null) ranges.push({ start: open.start, end: line.end });
  return { ranges, open };
}

type InlineCodeOpen = { marker: string; length: number; start: number };

function parseImage(
  text: string,
  start: number,
  labels: Map<string, string>,
  referencesOnly: boolean,
): Image | null {
  const labelEnd = findMatching(text, start + 2, "]", "[");
  if (labelEnd < 0) return null;
  const alt = text.slice(start + 2, labelEnd);
  let pointer = skipWhitespace(text, labelEnd + 1);
  if (text[pointer] !== "(" && text[pointer] !== "[") return null;
  const closing = text[pointer] === "(" ? ")" : "]";
  const destinationEnd = findMatching(text, pointer + 1, closing, text[pointer] === "(" ? "(" : "[");
  if (destinationEnd < 0) return null;
  if (text[pointer] === "[") {
    if (!referencesOnly) return null;
    const requested = text.slice(pointer + 1, destinationEnd).trim();
    const destination = labels.get(normalizeLabel(requested === "" ? alt : requested));
    return destination === undefined ? null : { destination, end: destinationEnd + 1 };
  }
  if (referencesOnly) return null;
  const destination = readDestination(text.slice(pointer + 1, destinationEnd), false);
  return destination === null ? null : { destination, end: destinationEnd + 1 };
}

function findMatching(text: string, start: number, closing: string, opening: string): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      if (text[index + 1] !== undefined) index += 1;
      continue;
    }
    if (text[index] === opening) depth += 1;
    if (text[index] === closing) {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function readDestination(content: string, allowSpaces: boolean): string | null {
  const trimmed = content.trim();
  const angle = trimmed.match(/^<([^<>]+)>(?:[ \t]+(?:("(?:\\.|[^\\"])*"|'(?:\\.|[^\\'])*"|[ \t]))?\s*)?$/u);
  if (angle !== null && angle[1] !== undefined) return angle[1];
  const contentWithoutTitle = trimmed.match(/^(.*?)[ \t]+(?:'(?:\\.|[^\\'])*"|"(?:\\.|[^\\"])*"|[ \t]+)$/us);
  if (contentWithoutTitle === null) {
    if (allowSpaces && trimmed !== "") return trimmed;
    return trimmed === "" ? null : trimmed;
  }
  const destination = contentWithoutTitle[1];
  if (destination === undefined) return null;
  if (allowSpaces) return destination;
  return /^[^\s]+$/u.test(destination) ? destination : null;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normalizeLabel(label: string): string { return label.replace(/[ \t\n]+/gu, " ").trim().toLowerCase(); }
function skipWhitespace(text: string, index: number): number {
  while (text[index] === " " || text[index] === "\t" || text[index] === "\n") index += 1;
  return index;
}
