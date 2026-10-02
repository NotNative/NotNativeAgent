// SPDX-License-Identifier: Apache-2.0
import { redactText } from './redaction.js';
import { sanitizeTelemetry } from './forensic-telemetry-sanitize.js';

export function supportConfiguration(config) {
  if (!config || typeof config !== 'object') return { status: 'unavailable' };
  const profiles = config.providerProfiles && typeof config.providerProfiles === 'object' ? Object.values(config.providerProfiles) : [];
  return sanitizeTelemetry({
    version: config.version, persistence: config.persistence, provenance: config.provenance,
    workspaceRoot: config.workspaceRoot, routes: config.routes, limits: config.limits,
    providers: profiles.filter((profile) => profile && typeof profile === 'object').map((profile) => ({
      id: profile.id, endpoint: redactText(profile.endpoint ?? ''), model: profile.model, trustZone: profile.trustZone,
      toolCallMode: profile.toolCallMode, credential: profile.credential || profile.credentialEnv ? '[reference configured]' : '[none]',
    })),
    memory: { ...config.memory, enabled: config.memory?.enabled === true },
    mcp: (config.mcpServers ?? []).map((server) => ({ id: server.id, transport: server.transport, enabled: server.enabled })),
  });
}
