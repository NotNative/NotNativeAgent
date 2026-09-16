/**
 * Mock harness fixtures — doc 02 §6–§7 shapes, modeled on the §7.2 worked
 * example. These are also the seed for NNA contract tests (D14).
 */
import { HARNESS_VERSION } from '../../lib/harnessNaming.ts';
import type {
  AgentInfo,
  CommandInfo,
  HarnessConfig,
  HarnessPath,
  Project,
  Provider,
  Session,
  SessionTokens,
} from '../../../../../ui/src/lib/nna/types.ts';

export const DEFAULT_DIRECTORY = process.cwd().replace(/\\/g, '/');

export const PROVIDERS: Provider[] = [
  {
    id: 'nnd-mock',
    name: 'NotNativeAgent (mock)',
    source: 'custom',
    env: [],
    options: {},
    models: {
      'mock-smart': {
        id: 'mock-smart',
        providerID: 'nnd-mock',
        api: { id: 'nnd-mock', url: 'http://127.0.0.1/mock', npm: '@notnative/mock' },
        name: 'Mock Smart',
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 200_000, output: 32_768 },
        status: 'active',
        release_date: '2025-01-01',
        variants: { low: {}, medium: {}, high: {} },
      },
      'mock-small': {
        id: 'mock-small',
        providerID: 'nnd-mock',
        api: { id: 'nnd-mock', url: 'http://127.0.0.1/mock', npm: '@notnative/mock' },
        name: 'Mock Small (side-channel)',
        capabilities: { toolcall: true, input: { text: true }, output: { text: true } },
        cost: { input: 0, output: 0 },
        limit: { context: 32_768, output: 8_192 },
        status: 'active',
        release_date: '2025-01-01',
      },
    },
  },
];

export const AGENTS: AgentInfo[] = [
  { name: 'build', description: 'Default hands-on agent', mode: 'primary' },
  { name: 'plan', description: 'Read-only planning agent', mode: 'primary' },
  { name: 'general', description: 'General subagent', mode: 'subagent', hidden: true },
  { name: 'explore', description: 'Exploration subagent', mode: 'subagent', hidden: true },
];

export const COMMANDS: CommandInfo[] = [
  { name: 'init', description: 'Bootstrap AGENTS.md', source: 'command' },
  { name: 'review', description: 'Review current changes (mock)', source: 'command' },
];

export const CONFIG: HarnessConfig = {
  $schema: 'https://notnative.local/schema.json',
  model: 'nnd-mock/mock-smart',
  small_model: 'nnd-mock/mock-small',
  default_agent: 'build',
  username: process.env.USERNAME ?? process.env.USER ?? 'you',
  share: 'manual',
  autoupdate: false,
};

export const PROJECT: Project = {
  id: 'prj_local',
  worktree: DEFAULT_DIRECTORY,
  vcs: 'git',
  name: 'workspace',
  time: { created: Date.now(), updated: Date.now() },
  sandboxes: [],
};

export const harnessPath = (directory: string): HarnessPath => ({
  home: process.env.USERPROFILE?.replace(/\\/g, '/') ?? '/home/user',
  state: `${process.env.NOTNATIVE_DATA_DIR ?? '~/.notnative-desktop'}/state`,
  config: `${process.env.NOTNATIVE_DATA_DIR ?? '~/.notnative-desktop'}/config`,
  worktree: directory,
  directory,
});

export const emptyTokens = (): SessionTokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

export const newSession = (directory: string, title: string): Session => ({
  id: `ses_${Math.random().toString(36).slice(2, 10)}`,
  slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-+$/g, '').slice(0, 40) || 'session',
  projectID: PROJECT.id,
  directory,
  title,
  version: HARNESS_VERSION,
  tokens: emptyTokens(),
  time: { created: Date.now(), updated: Date.now() },
  permission: [],
});
