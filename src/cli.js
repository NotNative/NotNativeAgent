#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { parseCli, readPrompt } from './cli-options.js';
import { runHeadless } from './headless.js';
import { runPlainText } from './plain-text.js';
import { runTui } from './tui.js';
import { SessionDataManager } from './session-data.js';
import { join, resolve } from 'node:path';
import { ensureUserDataPaths, userDataPaths, VERSION } from './product.js';
import { runWebSearchCommand } from './web-search-cli.js';
import { loadEffectiveStartupConfiguration, runtimeHookRoots, runtimeSkillRoots } from './startup-configuration.js';
import { StructuredLog } from './structured-log.js';
import { runSkillsCommand } from './skills-cli.js';
import { runGatewayCommand } from './gateway-cli.js';
import { runWebFetchCommand } from './web-fetch-cli.js';
import { loadManagedProviderCredentials, runProviderBootstrapCommand } from './provider-bootstrap.js';
import { loadManagedMcpCredentials } from './mcp-credentials.js';

try {
  const options = parseCli(process.argv.slice(2));
  if (['help', '--help', '-h'].includes(options.mode)) process.stdout.write(help());
  else if (['version', '--version', '-v'].includes(options.mode)) process.stdout.write(`${VERSION}\n`);
  else if (options.mode === 'headless') {
    const paths = await runtimePaths();
    await runHeadless(process.stdin, process.stdout, process.stderr, productOptions(paths));
  }
  else if (options.mode === 'websearch') {
    const result = await runWebSearchCommand(options.prompt, await runtimePaths());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  else if (options.mode === 'skills') {
    await runSkillsCommand(options.prompt, await runtimePaths(), process.stdout);
  }
  else if (options.mode === 'gateway') {
    const result = await runGatewayCommand(options.prompt, await runtimePaths(), { input: process.stdin });
    if (options.prompt[0] !== 'run') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  else if (options.mode === 'webfetch') {
    const result = await runWebFetchCommand(options.prompt, await runtimePaths());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  else if (options.mode === 'provider') {
    const result = await runProviderBootstrapCommand(options.prompt, await runtimePaths(), { input: process.stdin });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  else if (options.mode === 'tui') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw Object.assign(new Error('interactive terminal required'), { code: 'interactive_terminal_required' });
    const paths = await runtimePaths();
    const startupLog = await new StructuredLog({ path: join(paths.logs, 'runtime.ndjson') }).initialize();
    const effective = await loadEffectiveStartupConfiguration({
      paths, input: process.stdin, output: process.stdout, diagnostics: process.stderr,
      explicitPath: options.manifestPath, workspaceRoot: process.cwd(), securityAudit: (event) => startupLog.record(event),
    });
    await startupLog.flush();
    const config = effective.config;
    const configPath = options.manifestPath ? resolve(options.manifestPath) : join(paths.config, 'manifest.json');
    await runTui(process.stdin, process.stdout, process.stderr, {
      ...options, ...productOptions(paths), config, configPath, startupProject: effective.project,
      hookRoots: runtimeHookRoots(paths, effective.project),
      skillRoots: runtimeSkillRoots(paths, effective.project),
    });
  } else if (options.mode === 'text') {
    const paths = await runtimePaths();
    const startupLog = await new StructuredLog({ path: join(paths.logs, 'runtime.ndjson') }).initialize();
    const config = (await loadEffectiveStartupConfiguration({
      paths, input: process.stdin, output: process.stderr, diagnostics: process.stderr,
      explicitPath: options.manifestPath, workspaceRoot: process.cwd(), securityAudit: (event) => startupLog.record(event),
    })).config;
    await startupLog.flush();
    const prompt = await readPrompt(process.stdin, options.prompt);
    process.exitCode = await runPlainText(prompt, process.stdout, process.stderr, {
      ...options, ...productOptions(paths), config,
    });
  } else if (options.mode === 'sessions') {
    await sessionCommand(options.prompt, await runtimePaths());
  } else {
    process.stderr.write('nna: invalid_invocation\n'); process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`nna: ${error.code ?? 'internal_failure'}\n`);
  process.exitCode = 2;
}

function help() {
  return [
    `NotNativeAgent ${VERSION}`,
    'Usage:',
    '  nna                                      Launch configured TUI',
    '  nna tui [--manifest PATH] [--session ID] [--no-color] [--reduced-motion]',
    '  nna headless',
    '  nna text [--manifest PATH] [PROMPT]',
    '  nna sessions preview SESSION_ID',
    '  nna sessions export SESSION_ID PATH',
    '  nna sessions delete SESSION_ID delete:SESSION_ID',
    '  nna websearch status|configure URL|deploy',
    '  nna skills [list] [--json]',
    '  nna gateway status|test|start|stop|enable|disable',
    '  nna gateway token-env NAME|authorize USER_ID|revoke USER_ID|workspace PATH',
    '  nna webfetch status|trust ORIGIN|revoke ORIGIN',
    '  nna provider status|discover ENDPOINT|configure ENDPOINT MODEL',
    '  nna --help | --version',
    '',
  ].join('\n');
}

async function runtimePaths() {
  const paths = await ensureUserDataPaths();
  await loadManagedProviderCredentials(paths);
  await loadManagedMcpCredentials(paths);
  return paths;
}

async function sessionCommand(args, paths = userDataPaths()) {
  const [action, id, value] = args;
  const manager = new SessionDataManager({
    sessionRoot: paths.sessions, reviewerRoot: paths.reviewerLedger, diagnosticsRoot: paths.logs,
  });
  let result;
  if (action === 'preview' && id) result = await manager.preview(id);
  else if (action === 'export' && id && value) result = await manager.exportRedacted(id, resolve(value));
  else if (action === 'delete' && id && value) result = await manager.deleteToTrash(id, value);
  else throw Object.assign(new Error('invalid sessions command'), { code: 'invalid_session_command' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function productOptions(paths) {
  return {
    dataPaths: paths,
    storeRoot: paths.sessions, reviewerRoot: paths.reviewerLedger, tabPoolPath: join(paths.rootTui, 'pool.json'),
    webSearchConfigPath: paths.webSearchConfig, managedSearxngRoot: paths.managedSearxng,
    webFetchConfigPath: paths.webFetchConfig,
    gatewayConfigPath: paths.gatewayConfig,
    logPath: join(paths.logs, 'runtime.ndjson'),
    trustedWorkspacesPath: paths.trustedWorkspaces,
    hookRoot: paths.hooks,
    skillRoots: [{ scope: 'user', path: paths.skills }],
  };
}
