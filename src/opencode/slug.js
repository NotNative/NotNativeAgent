// SPDX-License-Identifier: Apache-2.0
// Façade-owned cosmetic slug generation for OpenCode Session.shape. Slugs are
// display-only decorations on the wire; NNA session identity stays internal.
const ADJECTIVES = ['tidy', 'quiet', 'brave', 'swift', 'clever', 'amber', 'crisp', 'lively', 'bold', 'steady'];
const NOUNS = ['meadow', 'harbor', 'summit', 'meadowlark', 'signal', 'ledger', 'orbit', 'canvas', 'beacon', 'grove'];

export default function slugifyTitle(title, random = Math.random) {
  const base = slugify(title);
  if (base) return base;
  const adjective = pick(ADJECTIVES, random);
  const noun = pick(NOUNS, random);
  return `${adjective}-${noun}`;
}

function slugify(title) {
  if (typeof title !== 'string') return '';
  const cleaned = title.toLowerCase().match(/[a-z0-9][a-z0-9-]{0,38}/gu);
  return cleaned ? cleaned.join('-').slice(0, 48) : '';
}

function pick(values, random) {
  return values[Math.floor(random() * values.length)];
}
