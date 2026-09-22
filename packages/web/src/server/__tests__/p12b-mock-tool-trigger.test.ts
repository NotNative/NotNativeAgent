// SPDX-License-Identifier: Apache-2.0
/**
 * Mock harness tool-lifecycle demo (doc 02 §5.2.3, SLICE-C task 1): a "tool"
 * word in the user text replays the full worked sequence on the event stream
 * (input transcription → pending part → called → running → live output deltas
 * → success/failed → terminal durable part) while the REST entry carries the
 * final tool part. Variants: plain=read JSON, "bash"=live output deltas,
 * "fail"=error state. Everything stays inside doc-02 shapes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockHarness } from '../harness/mock/index.ts';

interface Envelope { directory: string; payload: { id: string; type: string; properties: Record<string, unknown> } }

const ORIGIN = 'http://mock.test';

async function call(path: string, init?: RequestInit): Promise<Response> {
  return mockHarness.handle(new Request(`${ORIGIN}${path}`, init)) as unknown as Promise<Response>;
}

async function createSession(): Promise<string> {
  const response = await call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'tool demo' }) });
  expect(response.status).toBe(200);
  const session = await response.json() as { id: string };
  return session.id;
}

/** Collect SSE frames until the extra reader promise settles. */
async function openStream(): Promise<{ frames: Envelope[]; done: Promise<void>; stop: () => void }> {
  const controller = new AbortController();
  const response = await call('/api/event', { signal: controller.signal });
  const reader = response.body!.getReader();
  const frames: Envelope[] = [];
  const done = (async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try { frames.push(JSON.parse(line.slice(6)) as Envelope); } catch { /* skip */ }
        }
      }
    } catch { /* aborted read */ }
  })();
  return { frames, done, stop: () => { controller.abort(); } };
}

async function sendMessage(sessionId: string, text: string): Promise<{ info: { id: string; role: string }; parts: Array<Record<string, unknown>> }> {
  const response = await call(`/api/session/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: 'msg_tooltest1', model: { providerID: 'nnd-mock', modelID: 'mock-smart' }, parts: [{ type: 'text', text }] }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { info: { id: string; role: string }; parts: Array<Record<string, unknown>> };
}

let stream: { frames: Envelope[]; done: Promise<void>; stop: () => void } | null = null;

beforeEach(async () => {
  stream = await openStream();
});

afterEach(() => {
  stream?.stop();
  stream = null;
});

function typesOf(): string[] {
  return stream!.frames.map((frame) => frame.payload.type);
}

describe('mock "tool" trigger (doc 02 §5.2.3 worked sequence)', () => {
  it('plain read tool: running + completed durable parts and tool lifecycle frames', async () => {
    const sessionId = await createSession();
    const result = await sendMessage(sessionId, 'please show a tool run');
    const toolPart = result.parts.find((part) => part.type === 'tool') as { state: { status: string; output?: string; title: string } } | undefined;
    expect(toolPart).toBeDefined();
    expect(toolPart!.state.status).toBe('completed');
    expect(toolPart!.state.title).toContain('turns.ts');
    const types = typesOf();
    expect(types).toContain('session.next.tool.input.started');
    expect(types).toContain('session.next.tool.called');
    expect(types).toContain('session.next.tool.success');
    expect(types).toContain('message.part.updated');
  });

  it('bash variant streams live output deltas on the state.output field', async () => {
    const sessionId = await createSession();
    const result = await sendMessage(sessionId, 'run the bash tool now');
    const deltas = stream!.frames.filter((frame) => frame.payload.type === 'message.part.delta' && frame.payload.properties['field'] === 'output');
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(String((stream!.frames.at(-1) as Envelope).payload.type)).toBe('session.idle');
    const toolPart = result.parts.find((part) => part.type === 'tool') as { tool: string; state: { status: string; output: string } } | undefined;
    expect(toolPart?.tool).toBe('bash');
    expect(toolPart!.state.output).toContain('Test Files');
  });

  it('fail variant lands the error state + failed frame', async () => {
    const sessionId = await createSession();
    const result = await sendMessage(sessionId, 'run the tool and make it fail');
    expect(typesOf()).toContain('session.next.tool.failed');
    const toolPart = result.parts.find((part) => part.type === 'tool') as { state: { status: string; error?: string } } | undefined;
    expect(toolPart!.state.status).toBe('error');
    expect(toolPart!.state.error).toContain('no matches');
  });

  it('without the trigger word no tool frames fire', async () => {
    const sessionId = await createSession();
    const result = await sendMessage(sessionId, 'plain hello, no demo please');
    expect(typesOf()).not.toContain('session.next.tool.called');
    expect(result.parts.some((part) => part.type === 'tool')).toBe(false);
  });
});
