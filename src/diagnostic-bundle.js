// SPDX-License-Identifier: Apache-2.0
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';
import { PRODUCT_NAME, userDataPaths, VERSION } from './product.js';
import { createZip } from './zip-archive.js';

export class DiagnosticBundle {
  constructor(options) {
    if (!options?.engine) throw new ContractError('bundle_engine_required', 'diagnostic bundle requires an engine');
    this.engine = options.engine;
    this.logger = options.logger;
    this.maintenance = options.maintenance ?? null;
    this.supportRoot = options.supportRoot ?? userDataPaths().support;
    this.sessions = Array.isArray(options.sessions) && options.sessions.length > 0
      ? options.sessions.slice(0, 63)
      : [{ id: options.engine.sessionId, engine: options.engine }];
    this.activeSessionId = options.activeSessionId ?? options.engine.sessionId;
  }

  async preview() {
    return Object.freeze({
      categories: ['health', 'effective_configuration', 'structured_logs', 'reviewer_audit', 'governance_audit', 'forensic_trace', 'idle_maintenance'],
      skipped: ['raw_transcript_content', 'raw_prompt_content', 'raw_tool_content', 'memory_content', 'credentials'],
      redactions: ['secret-like keys', 'credential values', 'free-form content'],
      archive: 'zip', layout: 'one folder per conversation session', upload: false,
    });
  }

  defaultPath() { return join(this.supportRoot, supportFileName()); }

  async create(path = null) {
    const outputPath = path || this.defaultPath();
    if (typeof outputPath !== 'string' || !outputPath.toLowerCase().endsWith('.zip')) {
      throw new ContractError('bundle_path_invalid', 'support bundle path must end in .zip');
    }
    const preview = await this.preview();
    await this.logger?.flush?.();
    await Promise.all(this.sessions.map((session) => session.engine.telemetry?.flush?.()));
    const createdAt = new Date().toISOString();
    const logSnapshot = this.logger?.snapshot() ?? emptyLogs();
    const entries = [];
    const manifestSessions = [];
    for (const [index, session] of this.sessions.entries()) {
      const sessionId = session.id ?? session.engine.sessionId;
      const folder = sessionFolder(sessionId, index);
      const forensicTrace = await safeForensicTrace(session.engine);
      const diagnostics = {
        format: 2, created_at: createdAt, product: { name: PRODUCT_NAME, version: VERSION },
        session_id: sessionId, active: sessionId === this.activeSessionId,
        statistics: session.statistics ?? null,
        health: await session.engine.health(), configuration: safeConfiguration(session.engine.config),
        logs: sessionLogs(logSnapshot, sessionId), reviewer_audit: session.engine.reviewerAudit(1000),
        governance_audit: session.engine.governanceAudit(1000),
        idle_maintenance: sessionId === this.activeSessionId ? safeMaintenance(this.maintenance) : { status: 'not_active_session' },
        forensic_trace: {
          format: forensicTrace.format, rows: forensicTrace.rows.length,
          open_spans: forensicTrace.open_spans.length,
        },
        uploaded: false,
      };
      entries.push(
        { name: `${folder}/diagnostics.json`, content: `${JSON.stringify(diagnostics, null, 2)}\n` },
        { name: `${folder}/forensic-trace.json`, content: `${JSON.stringify(forensicTrace, null, 2)}\n` },
      );
      manifestSessions.push({ session_id: sessionId, folder, active: sessionId === this.activeSessionId });
    }
    const manifest = {
      format: 2, created_at: createdAt, product: { name: PRODUCT_NAME, version: VERSION },
      preview, sessions: manifestSessions, uploaded: false,
    };
    entries.unshift({ name: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
    entries.push({ name: 'README.txt', content: supportReadme(createdAt) });
    const inspection = entries.map((entry) => String(entry.content)).join('\n');
    if (containsSecret(inspection)) throw new ContractError('bundle_redaction_failed', 'diagnostic bundle failed privacy verification');
    const archive = createZip(entries);
    await atomicWrite(outputPath, archive);
    return Object.freeze({ path: outputPath, bytes: archive.length, manifest: preview });
  }
}

function emptyLogs() {
  return { product: { name: PRODUCT_NAME, version: VERSION }, records: [], dropped: 0 };
}

function sessionLogs(snapshot, sessionId) {
  return {
    product: snapshot.product ?? { name: PRODUCT_NAME, version: VERSION },
    records: (snapshot.records ?? []).filter((record) => record.session_id === sessionId),
    dropped: snapshot.dropped ?? 0,
  };
}

function sessionFolder(sessionId, index) {
  const source = String(sessionId ?? `session-${index + 1}`);
  const label = source.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || `session-${index + 1}`;
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 10);
  return `sessions/${label}-${digest}`;
}

function safeMaintenance(source) {
  try {
    const value = typeof source === 'function' ? source() : source;
    if (!value || typeof value !== 'object') return { status: 'unavailable' };
    const recent = Array.isArray(value.recent) ? value.recent.slice(0, 10) : [];
    return {
      status: value.state ?? 'unknown', enabled: value.enabled === true, reason: value.reason ?? null,
      watermark: value.watermark ? {
        turn_sequence: value.watermark.turn_sequence ?? null,
        stage: value.watermark.stage ?? null, updated_at: value.watermark.updated_at ?? null,
      } : null,
      runs: value.store?.runs ?? {},
      candidates: value.store?.candidates ?? {},
      recent: recent.map((run) => ({
        stage: run.stage ?? null, state: run.state ?? null, trigger: run.trigger ?? null,
        result_code: run.result_code ?? null, duration_ms: run.duration_ms ?? null,
        finished_at: run.finished_at ?? null,
      })),
    };
  } catch (error) {
    return { status: 'degraded', code: error?.code ?? 'maintenance_snapshot_failed' };
  }
}

async function safeForensicTrace(engine) {
  try { return await engine.telemetry?.supportSnapshot?.({ sessionId: engine.sessionId, limit: 5000 }) ?? emptyTrace(); }
  catch (error) {
    return { ...emptyTrace(), degraded: true, code: error?.code ?? 'telemetry_export_failed' };
  }
}

function emptyTrace() {
  return { format: 1, rows: [], open_spans: [], disabled: true };
}

function safeConfiguration(config) {
  if (!config || typeof config !== 'object') return { status: 'unavailable' };
  const profiles = config.providerProfiles && typeof config.providerProfiles === 'object'
    ? Object.values(config.providerProfiles) : [];
  const memory = config.memory && typeof config.memory === 'object' ? config.memory : {};
  const mcpServers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
  return {
    version: config.version, persistence: config.persistence, provenance: config.provenance,
    workspaceRoot: config.workspaceRoot, routes: config.routes,
    providers: profiles.filter((profile) => profile && typeof profile === 'object').map((profile) => ({
      id: profile.id, endpoint: profile.endpoint, model: profile.model, trustZone: profile.trustZone,
      credential: profile.credential || profile.credentialEnv ? '[reference configured]' : '[none]',
    })),
    memory: { ...memory, enabled: memory.enabled === true },
    mcp: mcpServers.filter((server) => server && typeof server === 'object')
      .map((server) => ({ id: server.id, transport: server.transport, enabled: server.enabled })),
  };
}

export async function atomicWrite(path, content, operations = {}) {
  const openFile = operations.open ?? open;
  const linkFile = operations.link ?? link;
  const removeFile = operations.unlink ?? unlink;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.nna-diagnostic-${randomUUID()}.tmp`);
  const handle = await openFile(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content); await handle.sync(); await handle.close();
    await linkFile(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeFile(temporary).catch(() => undefined);
    if (error.code === 'EEXIST') {
      throw new ContractError('bundle_exists', 'support bundle destination already exists; choose a new .zip path');
    }
    throw error;
  }
  // Cleanup failures cannot replace the publication result.
  await removeFile(temporary).catch(() => undefined);
}

function supportFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return `${PRODUCT_NAME}-support-${VERSION}-${stamp}.zip`;
}

function supportReadme(createdAt) {
  return [
    `${PRODUCT_NAME} Support Bundle`,
    `Version: ${VERSION}`,
    `Created: ${createdAt}`,
    '',
    'This archive was generated locally for troubleshooting and was not uploaded automatically.',
    'manifest.json lists the included conversations. Each sessions/<id>/ folder contains that conversation\'s diagnostics.json and forensic-trace.json.',
    'Raw transcript, prompt, tool-result, memory, and credential content are excluded.',
    `Review the archive before sending it to the ${PRODUCT_NAME} maintainers.`,
    '',
  ].join('\n');
}

function containsSecret(value) {
  return /(?:bearer\s+[A-Za-z0-9._~+/-]{16,}|(?:api[_-]?key|password|secret|token)\s*["']?\s*[=:]\s*["']?[^"'\s]{8,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk_live_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b|[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@)/iu.test(value);
}
