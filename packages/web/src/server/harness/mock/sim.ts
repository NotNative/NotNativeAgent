// SPDX-License-Identifier: Apache-2.0
/**
 * Mock turn execution (doc 02 LF-8 + §5.2.1 worked wire examples).
 * Order matters: user echo (caller messageID verbatim, §11.14) → busy →
 * step/text transcription deltas → durable part (message.part.updated) →
 * step.ended with cost/tokens → assistant message.updated (completed) →
 * idle + session.idle. Text triggers demo permission/question/todo flows.
 */
import { emitEvent } from './events.ts';
import { CONFIG, AGENTS } from './fixtures.ts';
import {
  activeTurns,
  ascendingId,
  entries,
  pendingPermissions,
  pendingQuestions,
  sessionStatus,
  sessions,
  todos,
} from './store.ts';
import type {
  AssistantMessage,
  MessageEntry,
  PromptPartInput,
  Session,
  TextPart,
  UserMessage,
} from '../../../../../ui/src/lib/nnd/types.ts';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildUserEntry(session: Session, parts: PromptPartInput[], messageID?: string): MessageEntry {
  const now = Date.now();
  const info: UserMessage = {
    id: messageID || ascendingId('msg'),
    sessionID: session.id,
    role: 'user',
    time: { created: now },
    agent: CONFIG.default_agent ?? 'build',
    model: { providerID: 'nnd-mock', modelID: 'mock-smart' },
  };
  return {
    info,
    parts: parts.map((part, index) => ({
      id: `${info.id}_p${index}`,
      sessionID: session.id,
      messageID: info.id,
      ...(part as Record<string, unknown>),
      type: (part.type as string) || 'text',
    })),
  };
}

const userTextOf = (entry: MessageEntry): string =>
  entry.parts
    .filter((p) => p.type === 'text' && typeof (p as TextPart).text === 'string' && !(p as TextPart).text?.startsWith('!') && !(p as TextPart).synthetic)
    .map((p) => (p as TextPart).text)
    .join('\n')
    .trim();

// ── tool-lifecycle demo (doc 02 §5.2.3 worked sequence) ────────────────────
/**
 * A "tool" word in the user text replays the doc-02 tool lifecycle against
 * the RUNNING assistant turn: input transcription → pending part → called →
 * running → (bash: live `state.output` deltas via message.part.delta,
 * field "output") → success/failed → completed/error part. Everything stays
 * inside the doc-02 event/part vocabulary; `error` lands a real error state.
 */
export type ToolDemoVariant = 'read' | 'bash' | 'fail';

const TOOL_STEP_MS = 90;
const DUMMY_CWD = 'D:/workspace/notnative';

export function toolDemoVariantOf(userText: string): ToolDemoVariant | null {
  const lowered = userText.toLowerCase();
  if (!lowered.includes('tool')) return null;
  if (lowered.includes('fail') || lowered.includes('error') || lowered.includes('fail')) return 'fail';
  if (lowered.includes('bash') || lowered.includes('command')) return 'bash';
  return 'read';
}

const BASH_OUTPUT_LINES = [
  'RUN  v3.2.4  --maxWorkers=2',
  ' ✓ chat/__tests__/tool-card.test.tsx (7 tests) 214ms',
  ' ✓ chat/__tests__/transcript-parts.test.tsx (12 tests) 501ms',
  ' Test Files  2 passed (2)',
  '      Tests  19 passed (19)',
];

interface ToolSpec {
  tool: string;
  input: Record<string, unknown>;
  title: string;
  finish: { status: 'completed'; output: string; metadata: Record<string, unknown> } | { status: 'error'; error: string; metadata: Record<string, unknown> };
}

function specFor(variant: ToolDemoVariant): ToolSpec {
  if (variant === 'bash') {
    return {
      tool: 'bash',
      input: { command: 'pnpm --filter @notnative/ui test -- --maxWorkers=2', description: 'run the ui test suite' },
      title: 'pnpm --filter @notnative/ui test',
      finish: { status: 'completed', output: BASH_OUTPUT_LINES.join('\n'), metadata: { exitCode: 0, outputLines: BASH_OUTPUT_LINES.length, workingDirectory: DUMMY_CWD } },
    };
  }
  if (variant === 'fail') {
    return {
      tool: 'grep',
      input: { pattern: 'definitely-missing-symbol', path: 'packages/ui/src' },
      title: 'No matches for “definitely-missing-symbol”',
      finish: { status: 'error', error: 'no matches found in the requested paths (exit 1)', metadata: { exitCode: 1 } },
    };
  }
  return {
    tool: 'read',
    input: { path: 'packages/ui/src/chat/turns.ts' },
    title: 'packages/ui/src/chat/turns.ts',
    finish: { status: 'completed', output: 'export function projectTurns(messages: Message[]): ChatTurn[] {\n  const turns: ChatTurn[] = [];\n  for (const source of messages) {\n    …\n  }\n  return turns;\n}', metadata: { lines: 64, source: 'packages/ui/src/chat/turns.ts' } },
  };
}

function applyTriggers(session: Session, text: string): void {
  const lowered = text.toLowerCase();
  if (lowered.includes('permission')) {
    const id = ascendingId('perm');
    pendingPermissions.set(id, {
      id,
      sessionID: session.id,
      permission: 'bash',
      patterns: ['npm test*'],
      metadata: {},
      always: ['npm test'],
      directory: session.directory,
    });
    emitEvent(session.directory, 'permission.asked', {
      id,
      sessionID: session.id,
      permission: 'bash',
      patterns: ['npm test*'],
      metadata: {},
      always: ['npm test'],
    });
  }
  if (lowered.includes('question')) {
    const id = ascendingId('qq');
    pendingQuestions.set(id, {
      id,
      sessionID: session.id,
      directory: session.directory,
      questions: [
        {
          question: 'Use PORT 3000 or 5173?',
          header: 'Port',
          options: [
            { label: 'Use 3000', description: 'matches the server config' },
            { label: 'Use 5173', description: 'Vite default' },
          ],
          multiple: false,
          custom: true,
        },
      ],
    });
    emitEvent(session.directory, 'question.asked', { id, sessionID: session.id, questions: pendingQuestions.get(id)!.questions });
  }
  if (lowered.includes('todo')) {
    const list = [
      { content: 'Inspect the failing area', status: 'completed', priority: 'high' },
      { content: 'Awaiting NNA integration for the real fix', status: 'pending', priority: 'medium' },
    ];
    todos.set(session.id, list);
    emitEvent(session.directory, 'todo.updated', { sessionID: session.id, todos: list });
  }
}

/** Runs one assistant turn; resolves with the finished assistant entry. */
export async function runTurn(session: Session, userEntry: MessageEntry, reply: string): Promise<MessageEntry> {
  const dir = session.directory;
  const list = entries.get(session.id) ?? [];
  entries.set(session.id, list);
  list.push(userEntry);
  emitEvent(dir, 'message.updated', { sessionID: session.id, info: userEntry.info });

  const entry = beginTurn(session, dir, userEntry);
  const part = beginTextPart(entry, dir);

  sessionStatus.set(session.id, { type: 'busy' });
  emitEvent(dir, 'session.status', { sessionID: session.id, status: { type: 'busy' } });
  emitActivity(dir, session.id, `turn-${entry.info.id}`, 'turn', 'started', 'Assistant turn started');
  const turn = { aborted: false };
  activeTurns.set(session.id, turn);
  emitEvent(dir, 'session.next.step.started', {
    timestamp: Date.now(),
    sessionID: session.id,
    assistantMessageID: entry.info.id,
    agent: (entry.info as AssistantMessage).agent,
    model: { id: (entry.info as AssistantMessage).modelID, providerID: (entry.info as AssistantMessage).providerID },
  });
  // The unfinished assistant INFO record goes out while the turn streams so a
  // live client can anchor part deltas (doc 02 LF-8: transcription → durable).
  emitEvent(dir, 'message.updated', { sessionID: session.id, info: entry.info });
  await streamTextDeltas(turn, part, dir, session.id, reply);
  if (toolDemoVariantOf(userTextOf(userEntry)) !== null) {
    await runToolDemo(turn, entry, dir, session.id, toolDemoVariantOf(userTextOf(userEntry))!);
  }

  const aborted = turn.aborted;
  activeTurns.delete(session.id);
  part.time = { start: part.time?.start ?? Date.now(), end: Date.now() };
  if (aborted) return finishTurnAborted(session, entry, part, list);
  return finishTurnOk(session, entry, part, list, reply);
}

function beginTurn(session: Session, dir: string, userEntry: MessageEntry): MessageEntry {
  const user = userEntry.info as UserMessage;
  const info: AssistantMessage = {
    id: ascendingId('msg'),
    sessionID: session.id,
    role: 'assistant',
    time: { created: Date.now() },
    parentID: user.id,
    modelID: 'mock-smart',
    providerID: 'nnd-mock',
    mode: 'primary',
    agent: AGENTS[0]!.name,
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { total: 0, input: 8, output: 16, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return { info, parts: [] };
}

function beginTextPart(entry: MessageEntry, dir: string): TextPart {
  const info = entry.info as AssistantMessage;
  const part: TextPart = {
    id: ascendingId('prt'),
    sessionID: info.sessionID,
    messageID: info.id,
    type: 'text',
    text: '',
    time: { start: Date.now() },
  };
  emitEvent(dir, 'session.next.text.started', {
    timestamp: Date.now(),
    sessionID: info.sessionID,
    assistantMessageID: info.id,
    textID: part.id,
  });
  return part;
}

async function streamTextDeltas(turn: { aborted: boolean }, part: TextPart, dir: string, sessionID: string, reply: string): Promise<void> {
  const chunks = reply.match(/.{1,16}/gsu) ?? [reply];
  for (const chunk of chunks) {
    if (turn.aborted) break;
    part.text += chunk;
    emitEvent(dir, 'session.next.text.delta', {
      timestamp: Date.now(),
      sessionID,
      assistantMessageID: part.messageID,
      textID: part.id,
      delta: chunk,
    });
    await sleep(60);
  }
  emitEvent(dir, 'session.next.text.ended', {
    timestamp: Date.now(),
    sessionID,
    assistantMessageID: part.messageID,
    textID: part.id,
    text: part.text,
  });
}

function finishTurnAborted(session: Session, entry: MessageEntry, part: TextPart, list: MessageEntry[]): MessageEntry {
  const dir = session.directory;
  const info = entry.info as AssistantMessage;
  entry.parts.push(part);
  list.push(entry);
  info.error = { name: 'MessageAbortedError', data: { message: 'The running turn was aborted.' } };
  info.time.completed = Date.now();
  emitEvent(dir, 'message.part.updated', { sessionID: session.id, time: Date.now(), part });
  emitEvent(dir, 'message.updated', { sessionID: session.id, info });
  emitEvent(dir, 'session.error', {
    sessionID: session.id,
    error: { name: 'MessageAbortedError', data: { message: 'The running turn was aborted.' } },
  });
  emitActivity(dir, session.id, `turn-${info.id}`, 'turn', 'failed', 'Assistant turn interrupted');
  settleIdle(session);
  return entry;
}

function finishTurnOk(session: Session, entry: MessageEntry, part: TextPart, list: MessageEntry[], reply: string): MessageEntry {
  const dir = session.directory;
  const info = entry.info as AssistantMessage;
  emitEvent(dir, 'session.next.text.ended', {
    timestamp: Date.now(),
    sessionID: session.id,
    assistantMessageID: info.id,
    textID: part.id,
    text: reply,
  });
  part.text = reply;
  entry.parts.push(part);
  list.push(entry);

  emitEvent(dir, 'message.part.updated', { sessionID: session.id, time: Date.now(), part });
  applyTriggers(session, reply);
  emitEvent(dir, 'session.next.step.ended', {
    timestamp: Date.now(),
    sessionID: session.id,
    assistantMessageID: info.id,
    finish: 'stop',
    cost: 0,
    tokens: { input: 8, output: Math.max(1, Math.round(reply.length / 4)), reasoning: 0, cache: { read: 0, write: 0 } },
  });
  info.time.completed = Date.now();
  info.finish = 'stop';
  info.cost = 0;
  emitEvent(dir, 'message.updated', { sessionID: session.id, info });
  emitActivity(dir, session.id, `turn-${info.id}`, 'turn', 'completed', 'Assistant turn completed');

  session.time.updated = Date.now();
  const parent = sessions.get(session.id);
  if (parent) emitEvent(dir, 'session.updated', { sessionID: session.id, info: parent });
  settleIdle(session);
  return entry;
}

export function settleIdle(session: Session): void {
  sessionStatus.set(session.id, { type: 'idle' });
  emitEvent(session.directory, 'session.status', { sessionID: session.id, status: { type: 'idle' } });
  emitEvent(session.directory, 'session.idle', { sessionID: session.id });
}

function emitActivity(directory: string, sessionID: string, id: string, kind: 'turn' | 'tool', status: 'started' | 'completed' | 'failed', summary: string): void {
  emitEvent(directory, 'nnd.activity', { id, sessionID, kind, status, summary, time: Date.now() });
}

export { userTextOf };

// ── the demo sequence itself ────────────────────────────────────────────────

type ToolPartRecord = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: Record<string, unknown>;
};

async function runToolDemo(turn: { aborted: boolean }, entry: MessageEntry, dir: string, sessionID: string, variant: ToolDemoVariant): Promise<void> {
  const info = entry.info as AssistantMessage;
  const spec = specFor(variant);
  const callID = ascendingId('call');
  emitActivity(dir, sessionID, `tool-${callID}`, 'tool', 'started', `Running ${spec.title}`);
  emitEvent(dir, 'session.next.tool.input.started', { sessionID, assistantMessageID: info.id, callID, name: spec.tool });
  const rawInput = JSON.stringify(spec.input);
  emitEvent(dir, 'session.next.tool.input.delta', { sessionID, assistantMessageID: info.id, callID, delta: rawInput });
  emitEvent(dir, 'session.next.tool.input.ended', { sessionID, assistantMessageID: info.id, callID, text: rawInput });
  const finalPart = await emitToolPartStates(turn, dir, sessionID, info.id, callID, spec, rawInput);
  if (finalPart) {
    const status = (finalPart.state.status === 'completed' ? 'completed' : 'failed') as 'completed' | 'failed';
    emitActivity(dir, sessionID, `tool-${callID}`, 'tool', status, status === 'completed' ? `${spec.title} completed` : `${spec.title} failed`);
  }
  if (finalPart) entry.parts.push(finalPart);
}

/** Streams pending → running → (live output) → terminal states; returns the
 *  durable final part. An abort lands the terminal error state immediately. */
async function emitToolPartStates(
  turn: { aborted: boolean },
  dir: string,
  sessionID: string,
  messageID: string,
  callID: string,
  spec: ToolSpec,
  rawInput: string,
): Promise<ToolPartRecord | null> {
  const emitPart = (state: Record<string, unknown>): ToolPartRecord => {
    const part: ToolPartRecord = { id: ascendingId('prt'), sessionID, messageID, type: 'tool', callID, tool: spec.tool, state };
    emitEvent(dir, 'message.part.updated', { sessionID, time: Date.now(), part });
    return part;
  };
  emitPart({ status: 'pending', input: spec.input, raw: rawInput });
  emitEvent(dir, 'session.next.tool.called', { sessionID, assistantMessageID: messageID, callID, tool: spec.tool, input: spec.input, provider: { executed: true } });
  const start = Date.now();
  const runningPart = emitPart({ status: 'running', input: spec.input, title: spec.title, time: { start } });
  let output: string | null = spec.finish.status === 'completed' && spec.tool === 'bash' ? '' : null;
  if (output !== null) {
    for (const line of BASH_OUTPUT_LINES) {
      if (turn.aborted) break;
      emitEvent(dir, 'message.part.delta', { sessionID, messageID, partID: runningPart.id, field: 'output', delta: `${line}\n` });
      output += `${line}\n`;
      await sleep(TOOL_STEP_MS);
    }
  } else {
    await sleep(TOOL_STEP_MS * 2);
  }
  const terminal = toolTerminalState(spec, turn.aborted, start, output);
  const finalPart = emitPart(terminal.state);
  emitEvent(dir, terminal.event, {
    sessionID,
    assistantMessageID: messageID,
    callID,
    ...(terminal.event === 'session.next.tool.success'
      ? { structured: terminal.state.metadata, content: [{ type: 'text', text: terminal.state.output ?? '' }], provider: { executed: true } }
      : { error: terminal.state.error }),
  });
  // The terminal tool part (error on abort, completed/failed otherwise) rides
  // the durable entry so REST history matches the stream (merge-preserving rule).
  return finalPart;
}

function toolTerminalState(spec: ToolSpec, aborted: boolean, start: number, streamingOutput: string | null): { event: string; state: Record<string, unknown> } {
  const now = Date.now();
  if (aborted) {
    return { event: 'session.next.tool.failed', state: { status: 'error', error: 'Interrupted', input: spec.input, metadata: {}, time: { start, end: now } } };
  }
  if (spec.finish.status === 'error') {
    return { event: 'session.next.tool.failed', state: { status: 'error', error: spec.finish.error, input: spec.input, metadata: spec.finish.metadata, time: { start, end: now } } };
  }
  return {
    event: 'session.next.tool.success',
    state: { status: 'completed', input: spec.input, output: streamingOutput ?? spec.finish.output, title: spec.title, metadata: spec.finish.metadata, time: { start, end: now } },
  };
}
