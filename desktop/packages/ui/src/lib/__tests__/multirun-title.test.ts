// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  buildFusionSessionTitle,
  buildMultiRunSessionTitle,
  buildWorktreeName,
  normalizeGroupSlug,
  parseMultiRunSessionTitle,
  toModelSlug,
} from '../multirun/title.ts';

describe('multi-run identities', () => {
  it('normalizes group names to the documented slug rules', () => {
    expect(normalizeGroupSlug('  Rework -- UI!!  ')).toBe('rework-ui');
    expect(normalizeGroupSlug('ab'.repeat(25))).toHaveLength(50);
    expect(normalizeGroupSlug('a')).toHaveLength(1);
    expect(normalizeGroupSlug('-missing')).toBe('missing');
    expect(normalizeGroupSlug('g 1')).toBe('g-1');
    expect(normalizeGroupSlug('g1')).toBe('');
    expect(normalizeGroupSlug('g12')).toBe('');
    expect(normalizeGroupSlug('')).toBe('');
  });

  it('builds titles with optional run groups and duplicate indexes', () => {
    expect(buildMultiRunSessionTitle({
      groupSlug: 'rework', providerID: 'anthropic', modelID: 'claude-sonnet-4-5',
    })).toBe('rework/anthropic/claude-sonnet-4-5');
    expect(buildMultiRunSessionTitle({
      groupSlug: 'rework', runGroup: 'g2', providerID: 'openai', modelID: 'gpt-5.2', index: 2,
    })).toBe('g2/rework/openai/gpt-5.2/2');
    expect(buildFusionSessionTitle({
      groupSlug: 'rework', runGroup: 'g1', providerID: 'openai', modelID: 'gpt-5.2',
    })).toBe('g1/rework/openai/gpt-5.2/fusion');
  });

  it('slugs provider/model for git-safe worktree names while preserving raw titles', () => {
    expect(toModelSlug('Anthropic', 'Claude 4!')).toBe('anthropic-claude-4');
    const parts = { groupSlug: 'rework', runGroup: 'g2', providerID: 'Anthropic', modelID: 'Claude 4', index: 2 };
    expect(buildWorktreeName(parts)).toBe('g2/rework/anthropic-claude-4/2');
    expect(parseMultiRunSessionTitle(buildMultiRunSessionTitle(parts))).toEqual({ ...parts, fusion: false });
  });

  it('round-trips plain model identifiers without inventing a duplicate index', () => {
    expect(parseMultiRunSessionTitle('rework/openai/2')).toEqual({
      groupSlug: 'rework', providerID: 'openai', modelID: '2', fusion: false,
    });
  });

  it('classifies fusion titles as the only title-backed fusion link', () => {
    const parts = { groupSlug: 'rework', runGroup: 'g2', providerID: 'openai', modelID: 'gpt-5.2' };
    const fusionTitle = buildFusionSessionTitle(parts);
    expect(parseMultiRunSessionTitle(fusionTitle)).toEqual({ ...parts, fusion: true });
    expect(() => parseMultiRunSessionTitle(`${fusionTitle}/2`)).toThrow(TypeError);
  });

  it('rejects malformed identities instead of creating unusable titles', () => {
    expect(() => buildMultiRunSessionTitle({
      groupSlug: '-bad', providerID: 'openai', modelID: 'gpt',
    })).toThrow(TypeError);
    expect(() => buildMultiRunSessionTitle({
      groupSlug: 'rework', providerID: 'provider/with/slash', modelID: 'gpt',
    })).toThrow(TypeError);
    expect(() => buildMultiRunSessionTitle({
      groupSlug: 'rework', providerID: 'openai', index: 1,
      modelID: 'gpt',
    })).toThrow(TypeError);
    expect(() => parseMultiRunSessionTitle('rework/openai')).toThrow(TypeError);
    expect(() => parseMultiRunSessionTitle('g/bad/provider/model')).toThrow(TypeError);
    expect(() => parseMultiRunSessionTitle('g2/rework/openai/model/x')).toThrow(TypeError);
    expect(() => parseMultiRunSessionTitle('g1/openai/model')).toThrow(TypeError);
    expect(() => buildMultiRunSessionTitle({
      groupSlug: 'g1', providerID: 'openai', modelID: 'gpt',
    })).toThrow(TypeError);
  });

  it('distinguishes raw fusion model IDs from fusion runs and rejects unsafe identities', () => {
    expect(buildMultiRunSessionTitle({
      groupSlug: 'rework', providerID: 'provider', modelID: 'fusion',
    })).toBe('rework/provider/fusion');
    expect(parseMultiRunSessionTitle('rework/provider/fusion')).toEqual({
      groupSlug: 'rework', providerID: 'provider', modelID: 'fusion', fusion: false,
    });
    const fusionOfFusion = buildFusionSessionTitle({
      groupSlug: 'rework', providerID: 'provider', modelID: 'fusion',
    });
    expect(fusionOfFusion).toBe('rework/provider/fusion/fusion');
    expect(parseMultiRunSessionTitle(fusionOfFusion)).toEqual({
      groupSlug: 'rework', providerID: 'provider', modelID: 'fusion', fusion: true,
    });
    expect(() => buildWorktreeName({
      groupSlug: 'rework', providerID: 'モデル', modelID: 'ソネット',
    })).toThrow(TypeError);
  });
});
