/**
 * Mock harness contract tests (doc 02 §12.1 + §12.3 hinge points reachable
 * in-process): messageID passthrough, 204 prompt semantics, event envelope +
 * Last-Event-ID replay, abort mid-turn, permission 404-settled convention.
 */
import { describe, expect, it } from 'vitest';
import { mockHarness } from '../../../../../web/src/server/harness/mock/index.ts';

const api = (path: string, init?: RequestInit) =>
  mockHarness.handle(new Request(`http://harness.test/api${path}`, init));

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() - started > timeoutMs) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createSession(title: string): Promise<{ id: string }> {
  const response = await api('/session', jsonInit('POST', { title }));
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

async function prompt(sessionId: string, text: string, messageID?: string): Promise<void> {
  const response = await api(`/session/${sessionId}/prompt_async`, jsonInit('POST', {
    model: { providerID: 'nnd-mock', modelID: 'mock-smart' },
    messageID,
    parts: [{ type: 'text', text }],
  }));
  expect(response.status).toBe(204); // accepted; outcome arrives via events only
  expect(await response.text()).toBe('');
}

async function messages(sessionId: string): Promise<Array<{ info: { id: string; role: string; error?: { name?: string }; time: { completed?: number } } }>> {
  const response = await api(`/session/${sessionId}/message`);
  return (await response.json()) as never;
}

describe('mock harness contract', () => {
  it('labels its welcome as a test mode without claiming NNA integration is pending', async () => {
    const list = await (await api('/session')).json() as Array<{ id: string; title: string }>;
    const welcome = list.find((item) => item.title === 'Welcome to NotNativeDesktop');
    expect(welcome).toBeDefined();
    const entries = await (await api(`/session/${welcome!.id}/message`)).json() as Array<{ parts: Array<{ text?: string }> }>;
    expect(entries[0]?.parts[0]?.text).toContain('Normal NND launches use the managed NotNativeAgent');
    expect(entries[0]?.parts[0]?.text).not.toContain('until the real one lands');
  });
  it('keeps prompt and command replies labeled as mock-only behavior', async () => {
    const session = await createSession('mock wording test');
    const promptResponse = await api(`/session/${session.id}/message`, jsonInit('POST', {
      parts: [{ type: 'text', text: 'hello' }],
    }));
    expect(promptResponse.status).toBe(200);
    const promptReply = await promptResponse.json() as { parts: Array<{ text?: string }> };
    expect(promptReply.parts[0]?.text).toContain('This is a test reply; normal NND launches use NNA.');
    const commandResponse = await api(`/session/${session.id}/command`, jsonInit('POST', {
      command: 'example', arguments: '',
    }));
    expect(commandResponse.status).toBe(200);
    const commandReply = await commandResponse.json() as { parts: Array<{ text?: string }> };
    expect(commandReply.parts[0]?.text).toContain('This is a test echo; normal NND launches use NNA.');
  });
  it('answers global health with the harness shape', async () => {
    const response = await api('/global/health');
    const body = await response.json();
    expect(body).toMatchObject({ healthy: true });
    expect(typeof body.version).toBe('string');
  });

  it('echoes the caller messageID and completes a turn (P-05, §11.14)', async () => {
    const session = await createSession('echo test');
    await prompt(session.id, 'hello contract', 'msg_client_1');
    const list = await waitFor(async () => {
      const all = await messages(session.id);
      return all.length >= 2 ? all : null;
    });
    expect(list[0]!.info.id).toBe('msg_client_1');
    expect(list[1]!.info.role).toBe('assistant');
    expect(typeof list[1]!.info.time.completed).toBe('number');
  });

  it('replays from Last-Event-ID with the §5.1 envelope', async () => {
    const session = await createSession('replay test');
    await prompt(session.id, 'stream me');
    await waitFor(async () => ((await messages(session.id)).length >= 2 ? true : null));
    const response = await api('/event', { headers: { 'last-event-id': '1' } });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const timeoutFrame = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 700));
    for (;;) {
      const raced = await Promise.race([reader.read(), timeoutFrame]);
      if (raced === 'timeout' || raced.done) break;
      text += decoder.decode(raced.value, { stream: true });
      if (text.split('data:').length - 1 >= 3) break;
    }
    await reader.cancel().catch(() => undefined);
    const frames = text
      .split('\n\n')
      .filter((block) => block.includes('data:'))
      .map((block) => JSON.parse(block.replace(/^id:.*\n/, '').replace(/^data: /, '')));
    expect(frames.length).toBeGreaterThan(0);
    const first = frames[0];
    expect(first.payload.id).toBe('2');
    expect(typeof first.directory).toBe('string');
    expect(typeof first.payload.type).toBe('string');
  });

  it('settles permissions: reply then 404 means already settled (P-08)', async () => {
    const session = await createSession('permission test');
    await prompt(session.id, 'please ask for permission');
    const pending = await waitFor(async () => {
      const response = await api('/permission');
      const list = (await response.json()) as Array<{ id: string }>;
      return list.length > 0 ? list : null;
    });
    const reply = await api(`/permission/${pending[0]!.id}/reply`, jsonInit('POST', { reply: 'once' }));
    expect(reply.status).toBe(200);
    const again = await api(`/permission/${pending[0]!.id}/reply`, jsonInit('POST', { reply: 'once' }));
    expect(again.status).toBe(404); // 404 = settled, treat as success upstream
  });

  it('aborts a running turn into an error, never a frozen part (§12.3)', async () => {
    const session = await createSession('abort test');
    await prompt(session.id, `x ${'long text '.repeat(20)}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const aborted = await api(`/session/${session.id}/abort`, jsonInit('POST', {}));
    expect(aborted.status).toBe(200);
    const list = await waitFor(async () => {
      const all = await messages(session.id);
      return all.some((entry) => entry.info.role === 'assistant') ? all : null;
    });
    const assistant = list.find((entry) => entry.info.role === 'assistant')!;
    expect(assistant.info.error?.name).toBe('MessageAbortedError');
    expect(typeof assistant.info.time.completed).toBe('number');
  });
});
