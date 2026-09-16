/**
 * Mock harness adapter — a contract-shaped stand-in for NotNativeAgent (NNA).
 *
 * Shapes are provisional, modeled on doc 02 §5–§7; phase P1 (doc 02 deep-read)
 * will align every field exactly and promote these fixtures to shared test
 * assets. An echo agent responds to posted messages so the chat loop can be
 * exercised end-to-end before NNA integration.
 */
import { type HarnessAdapter, harnessError, harnessJson } from './adapter.ts';
import { sseResponse, type SseSender } from '../lib/sse.ts';

type Json = Record<string, unknown>;

interface MockMessage extends Json {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: { created: number };
  parts: Json[];
}

const EPOCH = Date.now();
let idCounter = 0;
const id = (prefix: string) => `${prefix}_${(++idCounter).toString(36)}${Date.now().toString(36)}`;

const PROVIDERS = [
  {
    id: 'nnd-mock',
    name: 'NotNativeAgent (mock)',
    models: {
      'mock-smart': {
        id: 'mock-smart',
        name: 'Mock Smart',
        limit: { context: 200_000, output: 32_768 },
      },
      'mock-small': {
        id: 'mock-small',
        name: 'Mock Small (side-channel)',
        limit: { context: 32_768, output: 8_192 },
      },
    },
  },
];

const AGENTS = [
  { id: 'build', name: 'build', description: 'Default hands-on agent', mode: 'primary' },
  { id: 'plan', name: 'plan', description: 'Read-only planning agent', mode: 'primary' },
];

interface MockSession {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
}

const sessions = new Map<string, MockSession>();
const messages = new Map<string, MockMessage[]>();

function seedSession(): void {
  const directory = process.cwd();
  const session: MockSession = {
    id: id('ses'),
    title: 'Welcome to NotNativeDesktop',
    directory,
    time: { created: EPOCH, updated: EPOCH },
  };
  sessions.set(session.id, session);
  messages.set(session.id, [
    {
      id: id('msg'),
      sessionID: session.id,
      role: 'assistant',
      time: { created: EPOCH },
      parts: [
        {
          id: id('prt'),
          type: 'text',
          text:
            'This workspace is running against the **mock harness**. The NotNativeAgent ' +
            '(NNA) adapter will take its place behind the same seam — send me a message ' +
            'to see the echo loop work.',
        },
      ],
    },
  ]);
}
seedSession();

// ── event stream (harness-level, proxied at /api/event) ─────────────────────
type EventListener = (event: Json) => void;
const eventListeners = new Set<EventListener>();
let eventSeq = 0;

function emit(type: string, properties: Json): void {
  const event = { id: ++eventSeq, type, properties };
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch {}
  }
}

// ── echo agent ───────────────────────────────────────────────────────────────
function echoReply(session: MockSession, userText: string): void {
  emit('session.status', { sessionID: session.id, status: { type: 'busy' } });
  setTimeout(() => {
    const message: MockMessage = {
      id: id('msg'),
      sessionID: session.id,
      role: 'assistant',
      time: { created: Date.now() },
      parts: [
        {
          id: id('prt'),
          type: 'text',
          text: `(mock harness) You said: “${userText}”. Real answers arrive with NNA integration.`,
        },
      ],
    };
    (messages.get(session.id) ?? messages.set(session.id, []).get(session.id)!).push(message);
    session.time.updated = Date.now();
    emit('message.updated', { sessionID: session.id, message });
    emit('session.status', { sessionID: session.id, status: { type: 'idle' } });
  }, 450);
}

// ── routing ──────────────────────────────────────────────────────────────────
async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method.toUpperCase();

  // SSE event stream
  if (method === 'GET' && path === '/event') {
    return sseResponse((send: SseSender) => {
      const listener = (event: Json) =>
        send({ event: 'message', id: String(event.id), data: JSON.stringify(event) });
      eventListeners.add(listener);
      const heartbeat = setInterval(() => send({ data: ': heartbeat' }), 30_000);
      send({
        event: 'message',
        data: JSON.stringify({ id: ++eventSeq, type: 'server.connected', properties: {} }),
      });
      return () => {
        eventListeners.delete(listener);
        clearInterval(heartbeat);
      };
    }, request.signal);
  }

  if (method === 'GET' && path === '/path') {
    return harnessJson({
      state: process.cwd(),
      config: process.env?.NOTNATIVE_DATA_DIR ?? '~/.notnative-desktop',
      worktree: null,
      username: process.env?.USERNAME ?? process.env?.USER ?? 'you',
    });
  }

  if (method === 'GET' && path === '/config') {
    return harnessJson({
      model: { providerID: 'nnd-mock', modelID: 'mock-smart' },
    });
  }

  if (method === 'GET' && path === '/provider') {
    return harnessJson({ all: PROVIDERS, connected: ['nnd-mock'] });
  }

  if (method === 'GET' && path === '/agent') {
    return harnessJson(AGENTS);
  }

  if (method === 'GET' && path === '/session') {
    return harnessJson([...sessions.values()].sort((a, b) => b.time.updated - a.time.updated));
  }

  if (method === 'POST' && path === '/session') {
    const body = (await request.json().catch(() => ({}))) as Json;
    const session: MockSession = {
      id: id('ses'),
      title: typeof body.title === 'string' && body.title ? body.title : 'New session',
      directory: typeof body.directory === 'string' ? body.directory : process.cwd(),
      time: { created: Date.now(), updated: Date.now() },
    };
    sessions.set(session.id, session);
    messages.set(session.id, []);
    emit('session.created', { info: session });
    return harnessJson(session, 201);
  }

  const sessionMessagesMatch = /^\/session\/([^/]+)\/message$/.exec(path);
  if (sessionMessagesMatch) {
    const sessionId = decodeURIComponent(sessionMessagesMatch[1]!);
    const session = sessions.get(sessionId);
    if (!session) return harnessError('session not found', 404);

    if (method === 'GET') return harnessJson(messages.get(sessionId) ?? []);

    if (method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Json;
      const parts = Array.isArray(body.parts) ? (body.parts as Json[]) : [];
      const text = parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n');
      const message: MockMessage = {
        id: id('msg'),
        sessionID: sessionId,
        role: 'user',
        time: { created: Date.now() },
        parts: parts.map((p) => ({ id: id('prt'), ...p })),
      };
      (messages.get(sessionId) ?? messages.set(sessionId, []).get(sessionId)!).push(message);
      session.time.updated = Date.now();
      emit('message.updated', { sessionID: sessionId, message });
      echoReply(session, text || '(non-text message)');
      return harnessJson({ accepted: true }, 202);
    }
  }

  // cheap read surfaces the UI probes; keep opaque-but-valid
  if (method === 'GET' && /^\/(mcp|lsp|vcs|command|project|permission|question)$/.test(path)) {
    return harnessJson(path === '/project' ? [] : []);
  }

  return harnessError(`mock harness: unhandled ${method} ${path}`, 404);
}

export const mockHarness: HarnessAdapter = { handle: route };
