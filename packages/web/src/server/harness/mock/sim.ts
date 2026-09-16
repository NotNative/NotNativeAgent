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
} from '../../../../../ui/src/lib/nna/types.ts';

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
    .filter((p) => p.type === 'text' && typeof (p as TextPart).text === 'string' && !(p as TextPart).synthetic)
    .map((p) => (p as TextPart).text)
    .join('\n')
    .trim();

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

  const info: AssistantMessage = {
    id: ascendingId('msg'),
    sessionID: session.id,
    role: 'assistant',
    time: { created: Date.now() },
    parentID: userEntry.info.id,
    modelID: 'mock-smart',
    providerID: 'nnd-mock',
    mode: 'primary',
    agent: AGENTS[0]!.name,
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { total: 0, input: 8, output: 16, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const entry: MessageEntry = { info, parts: [] };

  sessionStatus.set(session.id, { type: 'busy' });
  emitEvent(dir, 'session.status', { sessionID: session.id, status: { type: 'busy' } });
  const turn = { aborted: false };
  activeTurns.set(session.id, turn);

  emitEvent(dir, 'session.next.step.started', {
    timestamp: Date.now(),
    sessionID: session.id,
    assistantMessageID: info.id,
    agent: info.agent,
    model: { id: info.modelID, providerID: info.providerID },
  });

  const part: TextPart = {
    id: ascendingId('prt'),
    sessionID: session.id,
    messageID: info.id,
    type: 'text',
    text: '',
    time: { start: Date.now() },
  };
  emitEvent(dir, 'session.next.text.started', {
    timestamp: Date.now(),
    sessionID: session.id,
    assistantMessageID: info.id,
    textID: part.id,
  });
  const chunks = reply.match(/.{1,16}/gsu) ?? [reply];
  for (const chunk of chunks) {
    if (turn.aborted) break;
    part.text += chunk;
    emitEvent(dir, 'session.next.text.delta', {
      timestamp: Date.now(),
      sessionID: session.id,
      assistantMessageID: info.id,
      textID: part.id,
      delta: chunk,
    });
    await sleep(60);
  }
  const aborted = turn.aborted;
  activeTurns.delete(session.id);
  part.time = { start: part.time?.start ?? Date.now(), end: Date.now() };

  if (aborted) {
    emitEvent(dir, 'session.next.text.ended', {
      timestamp: Date.now(),
      sessionID: session.id,
      assistantMessageID: info.id,
      textID: part.id,
      text: part.text,
    });
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
    settleIdle(session);
    return entry;
  }

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

export { userTextOf };
