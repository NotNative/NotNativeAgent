// SPDX-License-Identifier: Apache-2.0
/** Bounded credential-free Git identity profiles used for catalog clones. */
import { readMergedSettings } from '../settings-store.ts';

const MAX_PROFILES = 32;
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const ABSOLUTE_SAFE_PATH = /^(?:[A-Za-z]:|)\/(?:[A-Za-z0-9._ -]+\/)*[A-Za-z0-9._ -]+$/u;

export interface GitIdentityProfile {
  id: string;
  name: string;
  sshKeyPath: string;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !/\p{Control}/u.test(value);
}

function identityProfile(raw: unknown): GitIdentityProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!boundedText(record.id, 64) || !PROFILE_ID.test(record.id)) return null;
  if (!boundedText(record.name, 120) || record.name.trim() !== record.name || record.name === '') return null;
  const path = record.sshKeyPath;
  if (!boundedText(path, 512) || path.includes('\\') || !ABSOLUTE_SAFE_PATH.test(path)
    || path.split('/').some((segment) => segment.length === 0
      || segment === '.' || segment === '..')) return null;
  return { id: record.id, name: record.name, sshKeyPath: path };
}

export function readGitIdentityProfiles(): GitIdentityProfile[] {
  const configured = readMergedSettings('web').gitIdentityProfiles;
  if (!Array.isArray(configured)) return [];
  const profiles: GitIdentityProfile[] = [];
  for (const raw of configured) {
    const profile = identityProfile(raw);
    if (profile && !profiles.some((existing) => existing.id === profile.id)) profiles.push(profile);
    if (profiles.length >= MAX_PROFILES) break;
  }
  return profiles;
}

export function gitIdentitySummaries(): Array<{ id: string; name: string }> {
  return readGitIdentityProfiles().map(({ id, name }) => ({ id, name }));
}

export function resolveGitIdentityProfile(identityId: string | null | undefined): GitIdentityProfile | null {
  if (identityId !== undefined && identityId !== null) {
    if (!boundedText(identityId, 64)) return null;
    return readGitIdentityProfiles().find((profile) => profile.id === identityId) ?? null;
  }
  return null;
}

export function gitSshArgument(profile: GitIdentityProfile): string {
  return `core.sshCommand=ssh -i ${JSON.stringify(profile.sshKeyPath)} -o IdentitiesOnly=yes`;
}

export function gitCloneArguments(profile: GitIdentityProfile | null): string[] {
  return profile === null ? [] : ['-c', gitSshArgument(profile)];
}

export function gitIdentityCacheToken(profile: GitIdentityProfile): string {
  return `${profile.id}\n${profile.sshKeyPath}`;
}
