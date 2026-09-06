// SPDX-License-Identifier: Apache-2.0
import { createMenuOverlay } from './surface-engine.js';

export function webSearchOverlay(status, options = {}) {
  status = status ?? {}; const config = status.config ?? {};
  const profiles = config.profiles ?? []; const primary = profiles[0];
  const lines = [
    `Status     ${config.enabled ? 'Enabled' : 'Not configured'}`,
    `Profiles   ${profiles.length}`,
    `Primary    ${primary ? `${primary.display_name} · ${primary.endpoint}` : '--'}`,
  ];
  for (const [index, profile] of profiles.slice(1).entries()) {
    lines.push(`Fallback ${index + 1} ${profile.display_name} · ${profile.endpoint}`);
  }
  if (status.test) lines.push(`Validation ${status.test.ok
    ? `Passed for ${status.test.profile_id ?? 'primary'} (${status.test.results} results)`
    : `Failed for ${status.test.profile_id ?? 'primary'} (${status.test.error})`}`);
  if (options.message) lines.push('', options.message);
  lines.push('', config.enabled
    ? 'WebSearch tries these profiles in order after failure, degradation, or zero results.'
    : 'Connect a SearXNG service, or let NNA deploy one locally with Docker.');
  const items = profileActions(profiles, config.enabled);
  return createMenuOverlay('websearch', 'WebSearch profiles · SearXNG', lines, items, {
    activeId: options.selectedId ?? items[0]?.id,
  });
}

function profileActions(profiles, enabled) {
  const items = [
    { id: 'action:configure', label: enabled ? 'Change primary endpoint' : 'Connect primary SearXNG', detail: 'Validate and preserve configured fallbacks', section: 'Profiles' },
    { id: 'action:add', label: 'Add fallback profile', detail: 'Name and validate another SearXNG endpoint', section: 'Profiles' },
  ];
  for (const [index, profile] of profiles.entries()) {
    items.push({ id: `test:${profile.id}`, label: `Validate · ${profile.display_name}`, detail: profile.endpoint, section: 'Profile actions' });
    if (index > 0) items.push({ id: `promote:${profile.id}`, label: `Make primary · ${profile.display_name}`, detail: 'Move this profile to the front of the fallback chain', section: 'Profile actions' });
    if (!profile.managed) items.push({ id: `remove-profile:${profile.id}`, label: `Remove · ${profile.display_name}`, detail: 'Remove this saved endpoint profile', section: 'Profile actions' });
  }
  const hasManaged = profiles.some((profile) => profile.managed);
  items.push({ id: 'deploy', label: hasManaged ? 'Redeploy local SearXNG' : 'Deploy SearXNG locally', detail: 'Use Docker to create and validate an NNA-managed service', section: 'Managed local service' });
  if (hasManaged) items.push(
    { id: 'start', label: 'Start local service', detail: 'Start the preserved NNA-managed deployment', section: 'Managed local service' },
    { id: 'stop', label: 'Stop local service', detail: 'Stop without deleting its container or data', section: 'Managed local service' },
  );
  if (enabled || profiles.length > 0) items.push({
    id: 'disable', label: 'Disable WebSearch', detail: 'Remove all saved profiles; preserve any local deployment', section: 'Configuration',
  });
  items.push({ id: 'remove', label: 'Remove local deployment', detail: 'Stop and delete NNA-managed containers and deployment data', section: 'Managed local service' });
  return items;
}
