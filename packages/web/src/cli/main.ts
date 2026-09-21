// SPDX-License-Identifier: Apache-2.0
/**
 * `notnative` CLI entry (doc 03 S10, NND-brand binary per the E-08 registry):
 * command dispatch + the S10 global behavior rules — output modes, exit
 * codes, unknown-command suggestion (Levenshtein <= 3), usage errors = exit 2.
 * Commands implemented so far: `connect-url` (doc 08 S5.9). The rest of the
 * S10.1 inventory (serve/stop/restart/status/logs/tunnel/schedule/...) is the
 * P4 CLI slice and errors with usage guidance until then. Dispatch rules:
 * an unknown/missing/pending command never falls through into a run, and
 * `help`/`-h` route to the topical help text.
 */
import { CliUsageError, parseInvocation, suggestCloseMatches, type FlagSpec } from './args.ts';
import { EXIT_CODES, resolveOutputMode, type OutputFlags } from './output.ts';
import { runConnectUrl, type ConnectUrlFlags } from './connect-url-command.ts';

export const COMMANDS = ['connect-url', 'help', 'version'] as const;

export const CLI_NAME = 'notnative';

/** The S10.1 connect-url flag surface; exported for dispatch/parse gates. */
export const CONNECT_URL_SPECS: FlagSpec[] = [
  { name: 'port', kind: 'number', short: '-p' },
  { name: 'host', kind: 'string', aliases: ['hostname'] },
  { name: 'server', kind: 'string', aliases: ['server-url'] },
  { name: 'lan', kind: 'boolean' },
  { name: 'relay', kind: 'boolean' },
  { name: 'name', kind: 'string' },
  { name: 'ui-password', kind: 'string' },
  { name: 'api-only', kind: 'boolean' },
  { name: 'qr', kind: 'boolean' },
  { name: 'json', kind: 'boolean' },
  { name: 'quiet', kind: 'boolean', short: '-q' },
  { name: 'plain', kind: 'boolean' },
  { name: 'help', kind: 'boolean', short: '-h' },
  { name: 'version', kind: 'boolean', short: '-v' },
];

const PENDING_ROSTER = ['serve', 'stop', 'restart', 'status', 'logs', 'update',
  'tunnel', 'startup', 'schedule', 'session', 'models', 'projects', 'control'];

export interface CommandOutcome {
  exitCode: number;
}

export async function main(argv: readonly string[]): Promise<CommandOutcome> {
  if (argv.length === 0) return pendingRoster('');
  const first = argv[0] ?? '';
  if (first === 'help') return helpCommandOutcome(argv.slice(1));
  if (first === 'version') return versionCommandOutcome(argv.length > 1);
  if (!first.startsWith('-') && first !== 'connect-url') return pendingRoster(first);
  const invocation = parseInvocation(first === 'connect-url' ? argv.slice(1) : argv, CONNECT_URL_SPECS);
  const flags = invocation.flags as unknown as ConnectUrlFlags & OutputFlags;
  if (invocation.command !== null) throw new CliUsageError(`unexpected argument "${invocation.command}" `);
  if (flags.help === true) return helpLines(first === 'connect-url' ? 'connect-url' : '');
  if (flags.version === true) return versionOutcome();
  if (first !== 'connect-url') {
    throw new CliUsageError('no command given (try "notnative help" or "notnative connect-url") ');
  }
  const mode = resolveOutputMode(flags);
  await runConnectUrl(flags, mode);
  return { exitCode: EXIT_CODES.ok };
}

function versionCommandOutcome(hasExtras: boolean): CommandOutcome {
  if (hasExtras) throw new CliUsageError('version takes no arguments ');
  return versionOutcome();
}

function versionOutcome(): CommandOutcome {
  process.stdout.write(`${CLI_NAME} ${process.env.NOTNATIVE_CLI_VERSION ?? 'dev'}\n`);
  return { exitCode: EXIT_CODES.ok };
}

function helpCommandOutcome(topics: readonly string[]): CommandOutcome {
  const topic = topics[0] ?? '';
  if (topic === '' || topic === 'help' || topic === 'version') return helpLines('');
  if (topics.length > 1) throw new CliUsageError(`unexpected argument "${topics[1] ?? ''}" `);
  if (topic === 'connect-url') return helpLines('connect-url');
  if (PENDING_ROSTER.includes(topic)) return pendingRoster(topic);
  throw new CliUsageError(`unknown help topic "${topic}" `);
}

function helpLines(command: string): CommandOutcome {
  for (const entry of helpBody(command)) process.stdout.write(`${entry}\n`);
  return { exitCode: EXIT_CODES.ok };
}

function helpBody(command: string): string[] {
  if (command === 'connect-url') return CONNECT_URL_HELP;
  return HELP_TOP;
}

const HELP_TOP = [
  `${CLI_NAME} - NotNativeDesktop command line`,
  '',
  'Commands in this slice:',
  '  connect-url    create a one-time pairing-v2 connect link (QR/JSON/quiet)',
  '  help, version',
  '',
  `Pending the P4 CLI slice: ${PENDING_ROSTER.join(', ')}`,
  '',
  'Output modes: --json (one document), -q/--quiet (essentials), human otherwise.',
  'Exit codes: 0 ok · 1 error · 2 usage · 3 dependency · 4 auth · 5 network',
];

const CONNECT_URL_HELP = [
  `${CLI_NAME} connect-url - pairing-v2 connect link`,
  '',
  'Flags: -p, --port <1..65535> · --host/--hostname <address|url> · --server/--server-url <url>',
  '       --lan (host:=0.0.0.0) · --relay · --name <device label> · --ui-password <value>',
  '       --api-only · --qr/--no-qr · --json · -q/--quiet · --plain · -h/--help',
  '',
  'Ensures a server runs on the port (auto-starts one when none answers),',
  'then prints a one-time openchamber://connect?v=2&p=... link (expires in 10 minutes).',
];

function pendingRoster(command: string): CommandOutcome {
  const suggestion = suggestCloseMatches(command, [...COMMANDS, ...PENDING_ROSTER])[0];
  process.stdout.write(helpBody(command).join('\n'));
  process.stdout.write(
    command === ''
      ? '\nNo usable command in this slice yet; pending the P4 CLI slice.\n'
      : `\nCommand "${command}" is not available in this slice yet.\n`,
  );
  if (suggestion !== undefined && suggestion !== command) {
    process.stdout.write(`  did you mean "${suggestion}"?\n`);
  }
  return { exitCode: EXIT_CODES.usage };
}

export const CLI_MAIN = main;
