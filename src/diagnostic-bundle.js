// SPDX-License-Identifier: Apache-2.0
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';
import { userDataPaths, VERSION } from './product.js';
import { createZip } from './zip-archive.js';

export class DiagnosticBundle {
  constructor(options) {
    this.engine = options.engine;
    this.logger = options.logger;
    this.maintenance = options.maintenance ?? null;
    this.supportRoot = options.supportRoot ?? userDataPaths().support;
  }

  async preview() {
    return Object.freeze({
      categories: ['health', 'effective_configuration', 'structured_logs', 'governance_audit', 'forensic_trace', 'idle_maintenance'],
      skipped: ['raw_transcript_content', 'raw_prompt_content', 'raw_tool_content', 'memory_content', 'credentials'],
      redactions: ['secret-like keys', 'credential values', 'free-form content'],
      archive: 'zip', upload: false,
    });
  }

  async create(path = null) {
    const outputPath = path || join(this.supportRoot, supportFileName());
    if (typeof outputPath !== 'string' || !outputPath.toLowerCase().endsWith('.zip')) {
      throw new ContractError('bundle_path_invalid', 'support bundle path must end in .zip');
    }
    const preview = await this.preview();
    await this.logger?.flush?.();
    await this.engine.telemetry?.flush?.();
    const forensicTrace = await safeForensicTrace(this.engine);
    const bundle = {
      format: 1, created_at: new Date().toISOString(), preview,
      product: { name: 'NotNativeAgent', version: VERSION },
      health: await this.engine.health(), configuration: safeConfiguration(this.engine.config),
      logs: this.logger?.snapshot() ?? {
        product: { name: 'NotNativeAgent', version: VERSION }, records: [], dropped: 0,
      },
      governance_audit: this.engine.reviewerAudit(1000), uploaded: false,
      idle_maintenance: safeMaintenance(this.maintenance),
      forensic_trace: {
        format: forensicTrace.format, rows: forensicTrace.rows.length,
        open_spans: forensicTrace.open_spans.length,
      },
    };
    const encoded = JSON.stringify(bundle, null, 2);
    const traceEncoded = JSON.stringify(forensicTrace, null, 2);
    if (containsSecret(encoded) || containsSecret(traceEncoded)) throw new ContractError('bundle_redaction_failed', 'diagnostic bundle failed privacy verification');
    const archive = createZip([
      { name: 'diagnostics.json', content: `${encoded}\n` },
      { name: 'forensic-trace.json', content: `${traceEncoded}\n` },
      { name: 'README.txt', content: supportReadme(bundle.created_at) },
    ]);
    await atomicWrite(outputPath, archive);
    return Object.freeze({ path: outputPath, bytes: archive.length, manifest: preview });
  }
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
    return { ...emptyTrace(), degraded: true, code: error.code ?? 'telemetry_export_failed' };
  }
}

function emptyTrace() {
  return { format: 1, rows: [], open_spans: [], disabled: true };
}

function safeConfiguration(config) {
  return {
    version: config.version, persistence: config.persistence, provenance: config.provenance,
    workspaceRoot: config.workspaceRoot, routes: config.routes,
    providers: Object.values(config.providerProfiles).map((profile) => ({
      id: profile.id, endpoint: profile.endpoint, model: profile.model, trustZone: profile.trustZone,
      credential: profile.credentialEnv ? '[reference configured]' : '[none]',
    })),
    memory: { ...config.memory, enabled: config.memory.enabled },
    mcp: config.mcpServers.map((server) => ({ id: server.id, transport: server.transport, enabled: server.enabled })),
  };
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.nna-diagnostic-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  let published = false;
  try {
    await handle.writeFile(content); await handle.sync(); await handle.close();
    await link(temporary, path);
    published = true;
    await unlink(temporary);
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (published) await unlink(path).catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error.code === 'EEXIST') {
      throw new ContractError('bundle_exists', 'support bundle destination already exists; choose a new .zip path');
    }
    throw error;
  }
}

function supportFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return `NotNativeAgent-support-${VERSION}-${stamp}.zip`;
}

function supportReadme(createdAt) {
  return [
    'NotNativeAgent Support Bundle',
    `Version: ${VERSION}`,
    `Created: ${createdAt}`,
    '',
    'This archive was generated locally for troubleshooting and was not uploaded automatically.',
    'diagnostics.json and forensic-trace.json contain a bounded, strictly redacted troubleshooting projection.',
    'Raw transcript, prompt, tool-result, memory, and credential content are excluded.',
    'Review the archive before sending it to the NotNativeAgent maintainers.',
    '',
  ].join('\n');
}

function containsSecret(value) {
  return /(?:bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key\s*[=:]\s*[^"\s]+|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu.test(value);
}
