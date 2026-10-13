// SPDX-License-Identifier: Apache-2.0
/**
 * `connect-url` command (doc 08 S5.9 + doc 03 S10.1 row): ensures a server
 * runs on the port (probe first, auto-start detached otherwise), resolves the
 * advertised server URL by the S5.9 order, builds direct + optional relay
 * candidates (identity lazy mint), creates the pairing session DIRECTLY in
 * the on-disk store the host serves redeem from, assembles + encodes the
 * pairing-v2 link with the shared ui encoder (byte-for-byte CLI parity), and
 * prints in the three output modes.
 *
 * The demand side is the on-disk store — the host's 60 s poll picks a relay
 * session up even when the relay was off, and a stopped host starts it on the
 * next launch; the CLI never flips relay config from a side process (S3.12:
 * the lifecycle owns that file).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ENV } from '../server/env.ts';
import { isLoopbackUrl, serverLabel } from '../server/lib/auth/pairing-candidates.ts';
import {
  createPairingSessionStore,
  type PublicPairingSession,
} from '../server/lib/auth/pairing-sessions.ts';
import { getSharedRelayIdentityStore } from '../server/lib/relay/identity.ts';
import type { PairingCandidate } from '@notnative/ui/lib/connection-payload.ts';
import { encodePairingConnectionPayload } from '@notnative/ui/lib/connection-payload.ts';
import {
  buildRelayCandidate,
  directCandidate,
  relayConfigFor,
  relayShouldBeIncluded,
  resolveRelayEndpoint,
  resolveServerTarget,
  type UrlResolutionInput,
} from './connect-url.ts';
import {
  AUTOSTART_READINESS_TIMEOUT_MS,
  ensureServerRunning,
  probePortHealth,
  writeInstanceRecord,
  removeInstanceRecord,
  type ProbeOutcome,
  type ServerTarget,
  type SpawnSeam,
} from './instances.ts';
import { CliRuntimeError, HUMAN, printMode, type CliMessage, type ResolvedOutputMode } from './output.ts';
import { CliUsageError } from './args.ts';

const API_ONLY_WARNING = '--api-only is accepted for flag parity only; the doc-03 env table lands with the P4 CLI slice';
const PASSWORD_WARNING = 'the auto-started instance will have no UI password; pass --ui-password or set the env';

export interface ConnectUrlFlags {
  port?: string | number | undefined;
  host?: string;
  lan?: boolean;
  server?: string;
  relay?: boolean;
  name?: string;
  uiPassword?: string;
  apiOnly?: boolean;
  qr?: boolean;
  json?: boolean;
  quiet?: boolean;
  plain?: boolean;
  help?: boolean;
  version?: boolean;
}

export interface ConnectUrlDeps {
  dataDir?: string;
  probe?: (port: number) => Promise<ProbeOutcome>;
  prepareWait?: (stage: 'pre-spawn' | 'post-spawn') => Promise<void>;
  spawn?: SpawnSeam;
  /** Best-effort shutdown for a child this invocation spawned; every test
   *  MUST seam it so no test pid reaches the process table. */
  kill?: (pid: number) => boolean;
  injectServerRunning?: boolean;
  readinessTimeoutMs?: number;
}

export interface AssembledLink {
  serverUrl: string;
  connectUrl: string;
  session: { id: string; fingerprint: string; expiresAt: string };
  candidates: PairingCandidate[];
  usesRelay: boolean;
  relayUrl: string | null;
  autoStarted: boolean;
  source: string;
  port: number;
}

/** Flag-parity warnings (S10.1 keeps the row's full flag shape). */
export function connectUrlWarnings(
  flags: ConnectUrlFlags,
  context: { autoStarted: boolean; uiPasswordSet: boolean },
): CliMessage[] {
  const warnings: CliMessage[] = [];
  if (flags.apiOnly === true) warnings.push({ level: 'warning', code: 'API_ONLY_DEFERRED', message: API_ONLY_WARNING });
  if (context.autoStarted && !context.uiPasswordSet) {
    warnings.push({ level: 'warning', code: 'PASSWORD_NOT_SET', message: PASSWORD_WARNING });
  }
  return warnings;
}

function resolvePort(flags: ConnectUrlFlags): number {
  if (flags.port === undefined || flags.port === '') return ENV.port;
  const raw = typeof flags.port === 'number' ? flags.port : Number(flags.port);
  if (Number.isSafeInteger(raw) && raw >= 1 && raw <= 65_535) return raw;
  throw new CliUsageError(`--port expects a number 1..65535, got "${String(flags.port)}"`);
}

/** An empty --ui-password value is "not set" for the auto-start warning. */
function uiPasswordProvided(flags: ConnectUrlFlags): boolean {
  return typeof flags.uiPassword === 'string' && flags.uiPassword.trim() !== '';
}

function loadQrcodeTerminal(): ((text: string, options: object, callback: (code: string) => void) => void) | null {
  try {
    const required = createRequire(fileURLToPath(import.meta.url))('qrcode-terminal') as { generate?: unknown };
    if (typeof required?.generate !== 'function') return null;
    return required.generate.bind(required) as never;
  } catch {
    return null;
  }
}

/** qrcode-terminal THROWS on unencodable input; a missing/failed renderer
 *  just withholds the QR (the link line still carries everything). */
function qrText(link: string): { qr?: string } {
  const generate = loadQrcodeTerminal();
  if (generate === null) return {};
  let captured: string | null = null;
  try {
    generate(link, { small: true }, (code: string) => { captured = code; });
  } catch {
    return {};
  }
  return captured === null ? {} : { qr: captured };
}

/** The whole S5.9 flow. */
export async function runConnectUrl(
  flags: ConnectUrlFlags,
  mode: ResolvedOutputMode,
  deps: ConnectUrlDeps = {},
): Promise<void> {
  const port = resolvePort(flags);
  const dataDir = deps.dataDir ?? ENV.dataDir;
  const resolution: UrlResolutionInput = {
    port,
    serverFlag: flags.server,
    hostFlag: flags.host,
    lanFlag: flags.lan === true,
  };
  const target = resolveServerTarget(resolution);
  const uiPasswordSet = uiPasswordProvided(flags);
  if (deps.injectServerRunning === true) {
    const assembled = await assembleAndStore(flags, dataDir, target, port, false);
    emitWarnings(assembled, mode, connectUrlWarnings(flags, { autoStarted: false, uiPasswordSet }));
    emit(assembled, target, mode, flags, dataDir);
    return;
  }
  const outcome = await ensureServerRunning(
    target,
    { uiPassword: typeof flags.uiPassword === 'string' ? flags.uiPassword : undefined, dataDir },
    {
      probe: deps.probe ?? ((probePort: number) => probePortHealth(probePort)),
      prepareWait: (stage) => deps.prepareWait?.(stage) ?? Promise.resolve(),
      spawn: deps.spawn ?? null,
      kill: deps.kill,
      record: (record) => writeInstanceRecord(record, dataDir),
      clearRecord: (failedPort) => removeInstanceRecord(failedPort, dataDir),
      readinessTimeoutMs: deps.readinessTimeoutMs,
    },
  );
  if (outcome.autoStarted && outcome.readiness === 'timeout') {
    const waited = Math.round((deps.readinessTimeoutMs ?? AUTOSTART_READINESS_TIMEOUT_MS) / 1000);
    throw new CliRuntimeError(
      `auto-started server did not answer /health within ${waited} s; see the log under ${dataDir}/logs/`,
    );
  }
  const assembled = await assembleAndStore(flags, dataDir, target, port, outcome.autoStarted);
  // Warnings read the POST-ensure truth: an answering probe means no
  // auto-start happened and the password row never applies.
  emitWarnings(assembled, mode, connectUrlWarnings(flags, { autoStarted: outcome.autoStarted, uiPasswordSet }));
  emit(assembled, target, mode, flags, dataDir);
}

function emitWarnings(_assembled: AssembledLink, mode: ResolvedOutputMode, warnings: CliMessage[]): void {
  for (const warning of warnings) {
    if (mode.mode === 'json') continue; // the exact S5.9 shape stays clean; human/quiet carry the rows
    if (mode.mode === 'quiet') {
      // S10.3: --quiet stdout is the link only; warnings ride stderr so a
      // line-oriented consumer never eats a warning as its first line.
      process.stderr.write(`warning ${warning.code}: ${warning.message}\n`);
      continue;
    }
    HUMAN.warning(`[${warning.code}] ${warning.message}`);
  }
}

function emit(
  assembled: AssembledLink,
  target: ServerTarget,
  mode: ResolvedOutputMode,
  flags: ConnectUrlFlags,
  dataDir: string,
): void {
  if (mode.mode === 'human') {
    printHuman(assembled, target, mode, flags, dataDir);
    return;
  }
  printMode(mode, { payload: connectUrlJson(assembled, flags) }, [assembled.connectUrl]);
}

interface OneTimeSession extends PublicPairingSession {
  secret: string;
}

async function assembleAndStore(
  flags: ConnectUrlFlags,
  dataDir: string,
  target: ServerTarget,
  port: number,
  autoStarted: boolean,
): Promise<AssembledLink> {
  const relayConfig = relayConfigFor(dataDir);
  const relay = {
    relayFlag: flags.relay === true,
    configEnabled: relayConfigEnabled(relayConfig),
    configRelayUrl: relayConfig.relayUrl,
  };
  const candidates: PairingCandidate[] = [directCandidate(target.serverUrl)];
  let relayUrl: string | null = null;
  if (relayShouldBeIncluded(relay)) {
    const endpoint = resolveRelayEndpoint(relay);
    const identity = await getSharedRelayIdentityStore(dataDir).resolve();
    const candidate = await buildRelayCandidate(identity, endpoint.relayUrl);
    candidates.push(candidate);
    relayUrl = endpoint.relayUrl;
  }
  const store = createPairingSessionStore({ dataDir });
  const created = store.createPairingSession({
    label: typeof flags.name === 'string' && flags.name.trim() !== '' ? flags.name : null,
    allowedClientKinds: ['mobile', 'desktop'],
    createdByClientId: null,
    usesRelay: relayUrl !== null,
  });
  const oneTime = created as OneTimeSession;
  const connectUrl = encodeLink({
    pairingId: oneTime.id,
    secret: oneTime.secret,
    fingerprint: oneTime.fingerprint,
    expiresAt: oneTime.expiresAt,
    candidates,
  });
  return {
    serverUrl: target.serverUrl,
    connectUrl,
    session: { id: oneTime.id, fingerprint: oneTime.fingerprint, expiresAt: oneTime.expiresAt },
    candidates,
    usesRelay: relayUrl !== null,
    relayUrl,
    autoStarted,
    source: target.source,
    port,
  };
}

/** Corrupt config never reads as "disabled by choice": label it a warning so
 *  the operator heals the file instead of silently getting a relay-only link. */
function relayConfigEnabled(relayConfig: { enabled: boolean; corrupt: boolean }): boolean {
  return relayConfig.corrupt !== true && relayConfig.enabled;
}

function encodeLink(input: {
  pairingId: string;
  secret: string;
  fingerprint: string;
  expiresAt: string;
  candidates: PairingCandidate[];
}): string {
  // Direct ui-facade import: the CLI mirrors the ui encoder byte-for-byte (S5.9).
  return encodePairingConnectionPayload({
    pairingId: input.pairingId,
    secret: input.secret,
    label: serverLabel(),
    fingerprint: input.fingerprint,
    expiresAt: input.expiresAt,
    candidates: input.candidates,
  });
}

/** S5.9 --json shape: exactly the named fields (+ qr when --qr was asked). */
export function connectUrlJson(assembled: AssembledLink, flags: ConnectUrlFlags): unknown {
  return {
    serverUrl: assembled.serverUrl,
    connectUrl: assembled.connectUrl,
    pairingId: assembled.session.id,
    fingerprint: assembled.session.fingerprint,
    expiresAt: assembled.session.expiresAt,
    candidates: assembled.candidates,
    autoStarted: assembled.autoStarted,
    ...(flags.qr === true ? qrText(assembled.connectUrl) : {}),
  };
}

function printHuman(
  assembled: AssembledLink,
  target: ServerTarget,
  mode: ResolvedOutputMode,
  flags: ConnectUrlFlags,
  dataDir: string,
): void {
  HUMAN.intro('connect link created');
  HUMAN.line(assembled.connectUrl);
  HUMAN.line(`Server URL: ${target.serverUrl} (source: ${target.source})`);
  if (assembled.usesRelay) {
    HUMAN.line(`Relay fallback: ${assembled.relayUrl}`);
    if (relayConfigFor(dataDir).enabled === false) {
      HUMAN.info('[RELAY_STARTING] A running instance starts it within a minute; a stopped instance starts it on next launch.');
    }
  }
  HUMAN.line(`Fingerprint: ${assembled.session.fingerprint}`);
  if (isLoopbackUrl(assembled.serverUrl)) {
    HUMAN.warning('[LAN_UNREACHABLE] The direct candidate is loopback-only; use --lan or --server. With --relay the link still works, always through the relay.');
  }
  if (assembled.autoStarted) HUMAN.info(`[AUTO_STARTED] A new instance was started on port ${assembled.port}.`);
  if (flags.qr === true && mode.mode === 'human') printHumanQr(assembled.connectUrl);
  HUMAN.outro('single-use, 10 minutes, revocable from the pending list');
}

function printHumanQr(link: string): void {
  const rendered = qrText(link);
  if (typeof rendered.qr === 'string') HUMAN.line(rendered.qr);
  else HUMAN.warning('[QR_UNAVAILABLE] qrcode-terminal could not render this link.');
}
