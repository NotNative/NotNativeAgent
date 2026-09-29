// SPDX-License-Identifier: Apache-2.0
/**
 * Mock harness router — doc 02 §12.1 minimal-compatible surface plus the
 * §12.2 items our UI needs early (v2 permission probes, commands, fork,
 * abort, revert, summarize). Responses are BARE payloads (D12); the v2
 * surface keeps its `{data}` envelope on the wire per doc 02 rows 22-23.
 */
import { harnessError, type HarnessAdapter } from '../adapter.ts';
import { HARNESS_VERSION } from '../../lib/harnessNaming.ts';
import { emitEvent, openEventStream } from './events.ts';
import {
  AGENTS,
  COMMANDS,
  CONFIG,
  DEFAULT_DIRECTORY,
  PROVIDERS,
  PROJECT,
  harnessPath,
  newSession,
} from './fixtures.ts';
import {
  activeTurns,
  ascendingId,
  authStore,
  entries,
  normalizeDirectory,
  pendingPermissions,
  pendingPermissionsV2,
  pendingQuestions,
  sessionStatus,
  sessions,
  sessionsInDirectory,
  todos,
} from './store.ts';
import { buildUserEntry, runTurn, settleIdle, sleep, userTextOf } from './sim.ts';
import { mcpRoute } from './mcp.ts';
import type { PromptAsyncBody, Session } from '../../../../../ui/src/lib/nnd/types.ts';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });
const TOOL_IDS = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'task', 'webfetch', 'todowrite'];

function welcomeSeed(): void {
  const session = newSession(DEFAULT_DIRECTORY, 'Welcome to NotNativeDesktop');
  sessions.set(session.id, session);
  const messageID = ascendingId('msg');
  const now = Date.now();
  entries.set(session.id, [
    {
      info: {
        id: messageID,
        sessionID: session.id,
        role: 'assistant',
        time: { created: now, completed: now },
        modelID: 'mock-smart',
        providerID: 'nnd-mock',
        mode: 'primary',
        agent: 'build',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: ascendingId('prt'),
          sessionID: session.id,
          messageID,
          type: 'text',
          text:
            'Welcome! This session opens automatically on boot. The workspace currently ' +
            'runs against the **mock harness** for UI testing. Normal NND launches ' +
            'use the managed NotNativeAgent (NNA) integration. Send a message to ' +
            'watch a streamed turn on the event stream; include the words "tool" (add ' +
            '"bash" for live command output, "fail" for a settled tool error), ' +
            '"permission", "question", or "todo" to see those flows fire.',
        },
      ],
    },
  ]);
}
welcomeSeed();

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method.toUpperCase();
  const scopedDirectory =
    url.searchParams.get('directory') ?? request.headers.get('x-nnd-directory');
  const directory = scopedDirectory ? normalizeDirectory(scopedDirectory) : DEFAULT_DIRECTORY;

  // ── global ──────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/global/health') return json({ healthy: true, version: HARNESS_VERSION });
  if (method === 'POST' && path === '/global/upgrade') return json({ success: false, error: 'the mock harness cannot self-upgrade' });
  if (method === 'GET' && path === '/global/event') return openEventStream(request, null);
  if (method === 'GET' && path === '/event') return openEventStream(request, directory);

  // ── v2 surface (harness serves it under /api on its own origin) ─────────
  const v2Permission = /^\/api\/session\/([^/]+)\/permission(?:\/([^/]+))?(\/reply)?$/.exec(path);
  if (v2Permission) {
    const sessionId = decodeURIComponent(v2Permission[1]!);
    const requestId = v2Permission[2];
    if (method === 'GET' && requestId) {
      const pending = pendingPermissionsV2.get(requestId);
      if (!pending) return harnessError('PermissionNotFound', 404); // 404 ⇒ resolved
      return json({ data: pending });
    }
    if (method === 'POST' && !requestId) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id : ascendingId('pv2');
      pendingPermissionsV2.set(id, {
        id,
        sessionID: sessionId,
        action: String(body.action ?? 'execute'),
        resources: Array.isArray(body.resources) ? (body.resources as string[]) : [],
      });
      emitEvent(directory, 'permission.v2.asked', { id, sessionID: sessionId, action: String(body.action ?? 'execute'), resources: pendingPermissionsV2.get(id)!.resources });
      return json({ data: { id, effect: 'ask' } });
    }
    if (method === 'POST' && requestId && v2Permission[3]) {
      const pending = pendingPermissionsV2.get(requestId);
      if (!pending) return harnessError('PermissionNotFound', 404);
      pendingPermissionsV2.delete(requestId);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      emitEvent(directory, 'permission.v2.replied', { sessionID: pending.sessionID, requestID: requestId, reply: String(body.reply ?? 'once') });
      return json(true);
    }
  }

  // ── config / providers / agents / misc ──────────────────────────────────
  if (method === 'GET' && path === '/config/providers') return json({ providers: PROVIDERS, default: { 'nnd-mock': 'mock-smart' } });
  if (method === 'GET' && path === '/config') return json(CONFIG);
  if (method === 'PATCH' && path === '/config') {
    const body = (await request.json().catch(() => ({}))) as { config?: Record<string, unknown> };
    Object.assign(CONFIG, body.config ?? {}); // global write; directory is ignored by contract
    return json(CONFIG);
  }
  if (method === 'GET' && path === '/provider') return json(PROVIDERS);
  if (method === 'GET' && path === '/provider/auth') return json({});
  if (method === 'GET' && path === '/model') return json(PROVIDERS.flatMap((p) => Object.values(p.models)));
  const authMatch = /^\/auth\/([^/]+)$/.exec(path);
  if (authMatch && (method === 'PUT' || method === 'DELETE')) {
    const providerID = decodeURIComponent(authMatch[1]!);
    if (method === 'PUT') authStore.set(providerID, await request.json().catch(() => ({})));
    else authStore.delete(providerID);
    return json(true);
  }
  if (method === 'GET' && path === '/agent') return json(AGENTS);
  if (method === 'GET' && path === '/command') return json(COMMANDS);
  if (method === 'GET' && path === '/skill') return json([]);
  if (method === 'GET' && path === '/experimental/tool/ids') return json(TOOL_IDS);
  if (method === 'GET' && path === '/experimental/tool') return json(TOOL_IDS.map((id) => ({ id, description: `mock tool ${id}` })));
  if (path === '/mcp' || path.startsWith('/mcp/')) {
    const mcpResponse = await mcpRoute(request, path, directory);
    if (mcpResponse) return mcpResponse;
  }
  if (method === 'GET' && path === '/lsp') return json([]);
  if (method === 'GET' && path === '/vcs') return json({ branch: 'main', default_branch: 'main' });
  if (method === 'GET' && path === '/project/current') return json(PROJECT);
  if (method === 'GET' && path === '/project') return json([PROJECT]);
  if (method === 'GET' && path === '/path') return json(harnessPath(directory));
  if (method === 'GET' && /^\/(find|file|find\/file|find\/symbol|file\/content|file\/status)$/.test(path)) return json([]);

  // ── permissions / questions (v1 authorities) ─────────────────────────────
  if (method === 'GET' && path === '/permission') return json([...pendingPermissions.values()].filter((p) => p.directory === directory).map(({ directory: _drop, ...rest }) => rest));
  if (method === 'GET' && path === '/question') return json([...pendingQuestions.values()].filter((q) => q.directory === directory).map(({ directory: _drop, ...rest }) => rest));
  const permissionReply = /^\/permission\/([^/]+)\/reply$/.exec(path);
  if (permissionReply && method === 'POST') {
    const requestId = decodeURIComponent(permissionReply[1]!);
    const pending = pendingPermissions.get(requestId);
    if (!pending) return harnessError('PermissionNotFoundError', 404); // already settled
    pendingPermissions.delete(requestId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    emitEvent(pending.directory, 'permission.replied', { sessionID: pending.sessionID, requestID: requestId, reply: String(body.reply ?? 'once') });
    return json(true);
  }
  const questionRoute = /^\/question\/([^/]+)\/(reply|reject)$/.exec(path);
  if (questionRoute && method === 'POST') {
    const requestId = decodeURIComponent(questionRoute[1]!);
    const kind = questionRoute[2];
    const pending = pendingQuestions.get(requestId);
    if (!pending) return harnessError('QuestionNotFound', 404);
    pendingQuestions.delete(requestId);
    if (kind === 'reply') {
      const body = (await request.json().catch(() => ({}))) as { answers?: unknown };
      const answers = Array.isArray(body.answers) ? (body.answers as string[][]) : [];
      emitEvent(pending.directory, 'question.replied', { sessionID: pending.sessionID, requestID: requestId, answers });
    } else {
      emitEvent(pending.directory, 'question.rejected', { sessionID: pending.sessionID, requestID: requestId });
    }
    return json(true);
  }

  // ── sessions ─────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/session/status') {
    const out: Record<string, unknown> = {};
    for (const [sessionId, status] of sessionStatus) {
      if (status.type === 'idle') continue; // omission ⇒ idle after a successful snapshot
      const session = sessions.get(sessionId);
      if (scopedDirectory && session && session.directory !== directory) continue;
      out[sessionId] = status;
    }
    return json(out);
  }
  if (method === 'GET' && path === '/session') {
    // §J.3 list filters: `roots` narrows to parentless sessions; `archived`
    // means ALSO include archived (default excludes them); truthful clients
    // fetch inclusive and split client-side.
    const roots = url.searchParams.get('roots');
    const archived = url.searchParams.get('archived') === 'true';
    const limit = Number(url.searchParams.get('limit') ?? '') || Number.POSITIVE_INFINITY;
    let list = scopedDirectory ? sessionsInDirectory(directory) : [...sessions.values()];
    if (!archived) list = list.filter((session) => !session.time.archived);
    if (roots === 'true') list = list.filter((session) => !session.parentID);
    else if (roots === 'false') list = list.filter((session) => Boolean(session.parentID));
    list = list.sort((a, b) => a.id.localeCompare(b.id));
    return json(list.slice(0, Number.isFinite(limit) ? limit : undefined));
  }
  if (method === 'POST' && path === '/session') {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const session = newSession(
      typeof body.directory === 'string' ? normalizeDirectory(body.directory) : directory,
      typeof body.title === 'string' && body.title ? body.title : 'New session',
    );
    if (typeof body.parentID === 'string') session.parentID = body.parentID;
    sessions.set(session.id, session);
    entries.set(session.id, []);
    emitEvent(session.directory, 'session.created', { sessionID: session.id, info: session });
    return json(session);
  }

  const sessionMatch = /^\/session\/([^/]+)(?:\/([a-z_\/]+))?$/.exec(path);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const rest = sessionMatch[2] ?? '';
    const session = sessions.get(sessionId);
    if (!session) return harnessError(`session not found: ${sessionId}`, 404);

    if (!rest && method === 'GET') return json(session);
    if (!rest && method === 'PATCH') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.title === 'string') session.title = body.title;
      if (body.metadata && typeof body.metadata === 'object') session.metadata = { ...session.metadata, ...(body.metadata as object) };
      if (body.time && typeof body.time === 'object') session.time = { ...session.time, ...(body.time as object) };
      session.time.updated = Date.now();
      emitEvent(session.directory, 'session.updated', { sessionID: session.id, info: session });
      return json(session);
    }
    if (!rest && method === 'DELETE') {
      for (const child of [...sessions.values()]) {
        if (child.parentID === session.id) {
          sessions.delete(child.id);
          entries.delete(child.id);
          emitEvent(child.directory, 'session.deleted', { sessionID: child.id, info: child });
        }
      }
      sessions.delete(session.id);
      entries.delete(session.id);
      emitEvent(session.directory, 'session.deleted', { sessionID: session.id, info: session });
      return json(true);
    }
    if (rest === 'children' && method === 'GET') return json([...sessions.values()].filter((s) => s.parentID === session.id));
    if (rest === 'fork' && method === 'POST') {
      const copy = newSession(session.directory, `Fork of ${session.title}`);
      copy.parentID = session.parentID;
      sessions.set(copy.id, copy);
      entries.set(copy.id, (entries.get(session.id) ?? []).map((entry) => ({ info: { ...entry.info, sessionID: copy.id }, parts: entry.parts })));
      emitEvent(copy.directory, 'session.created', { sessionID: copy.id, info: copy });
      return json(copy);
    }
    if (rest === 'abort' && method === 'POST') {
      const turn = activeTurns.get(session.id);
      if (turn) turn.aborted = true;
      else if (sessionStatus.get(session.id)?.type !== 'idle') settleIdle(session);
      return json(true);
    }
    if (rest === 'revert' && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { messageID?: string; partID?: string };
      if (body.messageID) session.revert = { messageID: body.messageID, ...(body.partID ? { partID: body.partID } : {}) };
      emitEvent(session.directory, 'session.updated', { sessionID: session.id, info: session });
      return json(session);
    }
    if (rest === 'unrevert' && method === 'POST') {
      delete session.revert;
      emitEvent(session.directory, 'session.updated', { sessionID: session.id, info: session });
      return json(session);
    }
    if (rest === 'summarize' && method === 'POST') {
      emitEvent(session.directory, 'session.compacted', { sessionID: session.id });
      return json(true);
    }
    if (rest === 'init' && method === 'POST') return json(true);
    if (rest === 'share' && method === 'POST') {
      session.share = { url: `http://share.notnative.local/${session.id}` };
      return json(session.share);
    }
    if (rest === 'share' && method === 'DELETE') {
      delete session.share;
      return json(true);
    }
    if (rest === 'todo' && method === 'GET') return json(todos.get(session.id) ?? []);
    if (rest === 'diff' && method === 'GET') return json([]);
  }

  const messagesMatch = /^\/session\/([^/]+)\/message$/.exec(path);
  if (messagesMatch) {
    const sessionId = decodeURIComponent(messagesMatch[1]!);
    const session = sessions.get(sessionId);
    if (!session) return harnessError(`session not found: ${sessionId}`, 404);
    const list = entries.get(sessionId) ?? [];

    if (method === 'GET') {
      // Cursor window (doc 04 §E.1 / J.3): `before` is an exclusive message id;
      // the next-older cursor rides the `x-next-cursor` response header.
      const limitParam = Number(url.searchParams.get('limit') ?? '');
      const limit = limitParam > 0 ? limitParam : list.length;
      const before = url.searchParams.get('before');
      let window = list;
      if (before) {
        const index = list.findIndex((entry) => entry.info.id === before);
        if (index < 0) return harnessError(`before cursor not found: ${before}`, 400);
        window = list.slice(0, index);
      }
      const page = window.slice(Math.max(0, window.length - limit));
      const more = window.length > page.length;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (more && page.length > 0) headers['x-next-cursor'] = page[0]!.info.id;
      return new Response(JSON.stringify(page), { status: 200, headers });
    }
    if (method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Partial<PromptAsyncBody>;
      const parts = Array.isArray(body.parts) ? body.parts : [];
      if (parts.length < 1) return harnessError('prompt requires at least one part', 400);
      const entry = buildUserEntry(session, parts, body.messageID);
      if (entry.info.role === 'user') {
        if (body.agent) entry.info.agent = body.agent;
        if (body.model) entry.info.model = { providerID: body.model.providerID, modelID: body.model.modelID };
      }
      const userText = userTextOf(entry) || '(non-text message)';
      const reply = `(mock harness) You said: “${userText}”. This is a test reply; normal NND launches use NNA.`;
      const done = await runTurn(session, entry, reply);
      return json({ info: done.info, parts: done.parts }); // sync v1 prompt form
    }
  }
  if (/^\/session\/[^/]+\/prompt_async$/.test(path) && method === 'POST') {
    const sessionId = decodeURIComponent(path.split('/')[2]!);
    const session = sessions.get(sessionId);
    if (!session) return harnessError(`session not found: ${sessionId}`, 404);
    const body = (await request.json().catch(() => ({}))) as Partial<PromptAsyncBody>;
    const parts = Array.isArray(body.parts) ? body.parts : [];
    if (parts.length < 1) return harnessError('prompt requires at least one part', 400);
    const entry = buildUserEntry(session, parts, body.messageID);
    if (entry.info.role === 'user') {
      if (body.agent) entry.info.agent = body.agent;
      if (body.model) entry.info.model = { providerID: body.model.providerID, modelID: body.model.modelID };
    }
    const userText = userTextOf(entry) || '(non-text message)';
    const reply = `(mock harness) You said: “${userText}”. This is a test reply; normal NND launches use NNA.`;
    void runTurn(session, entry, reply).catch(() => undefined);
    return noContent();
  }

  const commandMatch = /^\/session\/([^/]+)\/(command|shell)$/.exec(path);
  if (commandMatch && method === 'POST') {
    const sessionId = decodeURIComponent(commandMatch[1]!);
    const kind = commandMatch[2];
    const session = sessions.get(sessionId);
    if (!session) return harnessError(`session not found: ${sessionId}`, 404);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (kind === 'shell' && activeTurns.has(session.id)) {
      return harnessError('SessionBusyError', 409);
    }
    const list = entries.get(sessionId) ?? [];
    entries.set(sessionId, list);
    const text = kind === 'shell'
      ? `$ ${String(body.command ?? '')}`
      : `/${String(body.command ?? 'command')} ${String(body.arguments ?? '')}`.trim();
    const entry = buildUserEntry(session, [{ type: 'text', text }], typeof body.messageID === 'string' ? body.messageID : undefined);
    const reply = kind === 'shell'
      ? `(mock shell) “${String(body.command ?? '')}” ran to completion. Terminal emulation arrives with the server-side PTY (doc 03).`
      : `(mock command “${String(body.command ?? '')}”) This is a test echo; normal NND launches use NNA.`;
    const done = await runTurn(session, entry, reply);
    return json({ info: done.info, parts: done.parts });
  }

  return harnessError(`mock harness: unhandled ${method} ${path}`, 404);
}

export const mockHarness: HarnessAdapter = { handle: route };
export { sleep };
