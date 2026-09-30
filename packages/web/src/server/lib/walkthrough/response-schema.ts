// SPDX-License-Identifier: Apache-2.0
/** Provider-neutral strict JSON Schema for the bounded walkthrough response. */
const stop = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' },
    hunks: { type: 'array', minItems: 1, maxItems: 14, items: { type: 'string' } },
    importance: { type: 'string', enum: ['critical', 'normal', 'context'] },
    prose: { type: 'string' },
  },
  required: ['title', 'hunks', 'importance', 'prose'],
};
const chapter = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 24 },
    icon: { type: 'string', enum: ['bug', 'wrench', 'path', 'flask', 'doc', 'gear'] },
    blurb: { type: 'string' },
    stops: { type: 'array', minItems: 1, maxItems: 16, items: stop },
  },
  required: ['title', 'icon', 'blurb', 'stops'],
};

export const WALKTHROUGH_RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' },
    focus: { type: 'string' },
    chapters: { type: 'array', minItems: 1, maxItems: 6, items: chapter },
  },
  required: ['title', 'focus', 'chapters'],
} as const;
