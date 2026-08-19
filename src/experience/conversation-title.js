// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const MAX_SOURCE_MESSAGES = 2;
const MAX_TITLE_WORDS = 3;
const MAX_TITLE_CHARACTERS = 48;
const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}._+#'-]*/gu;

const FILLER = new Set([
  'a', 'about', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because',
  'been', 'before', 'being', 'but', 'by', 'can', 'chat', 'conversation', 'could', 'do', 'does', 'doing', 'done',
  'for', 'from', 'get', 'getting', 'give', 'go', 'going', 'got', 'had', 'has', 'have', 'hello', 'help', 'here',
  'hey', 'hi', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'keep', 'let', 'like', 'look',
  'make', 'me', 'message', 'messages', 'my', 'need', 'now', 'of', 'on', 'or', 'our', 'please', 'set', 'should',
  'so', 'some', 'something', 'starting', 'take', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'to', 'try', 'turn', 'up', 'us', 'use', 'user', 'very', 'want', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'why', 'will', 'with', 'would', 'you', 'your',
  'annoying', 'audit', 'broken', 'diagnose', 'dig', 'exchange', 'failing', 'fix', 'investigate', 'issue',
  'insight', 'inspect', 'mangled', 'problem', 'remember', 'review', 'slightly', 'thing', 'things',
  'agent', 'automatic', 'automatically', 'extremely', 'general', 'harness', 'mechanism', 'succinct', 'terse',
  'first', 'second', 'main', 'meaningful', 'previous', 'tab', 'terminal',
]);

/** Extracts a stable, local 1–3 word topic without spending another model turn. */
export function deriveConversationTitle(transcript) {
  const messages = (transcript ?? [])
    .filter((item) => item?.type === 'message' && item.role === 'user' && typeof item.content === 'string')
    .slice(0, MAX_SOURCE_MESSAGES)
    .map((item) => item.content);
  const selected = [];
  const seen = new Set();
  for (const source of messages) {
    for (const raw of cleanSource(source).match(TOKEN_PATTERN) ?? []) {
      const token = cleanToken(raw);
      const folded = token.toLocaleLowerCase('en-US');
      if (!eligible(token, folded) || seen.has(folded)) continue;
      seen.add(folded);
      selected.push(displayToken(token));
      if (selected.length === MAX_TITLE_WORDS) return boundedTitle(selected);
    }
  }
  return selected.length > 0 ? boundedTitle(selected) : null;
}

export function isGeneratedConversationName(name) {
  return name === 'Main' || name === 'Previous Main' || name === 'Conversation'
    || /^Conversation \d+$/u.test(name) || /^Resumed [A-Za-z0-9_-]+$/u.test(name);
}

export async function maybeAutoNameConversation(workspace, session) {
  if (!session || session.nameLocked || session.autoNamed) return false;
  const name = deriveConversationTitle(session.engine?.transcript);
  if (!name) return false;
  session.name = name; session.autoNamed = true;
  const projected = workspace.projection.sessions.get(session.id);
  if (projected) projected.name = name;
  await workspace._savePoolRecoverable();
  workspace.onChange();
  return true;
}

export function renameWorkspaceConversation(workspace, name) {
  if (!name || name.length > 128) throw new ContractError('session_name_invalid', 'conversation name is invalid');
  const session = workspace._active();
  session.name = name; session.nameLocked = true; session.autoNamed = false;
  workspace.projection.active().name = name;
  workspace.tabPersistence.observe(workspace._savePoolForBroker(), workspace._tasksForBroker());
  workspace.onChange();
  return { sessionId: session.id, name };
}

function cleanSource(value) {
  return String(value)
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ');
}

function cleanToken(value) {
  return value.replace(/['’]s$/iu, '').replace(/^[-_.']+|[-_.']+$/gu, '');
}

function eligible(token, folded) {
  return token.length >= 2 && token.length <= 32
    && !FILLER.has(folded)
    && !/^\d+$/u.test(token)
    && !/^(?:http|https|www)$/u.test(folded);
}

function displayToken(token) {
  if (/[A-Z].*[A-Z]|[a-z][A-Z]|\d|[+.#_-]/u.test(token)) return token;
  return `${token[0].toLocaleUpperCase('en-US')}${token.slice(1).toLocaleLowerCase('en-US')}`;
}

function boundedTitle(words) {
  const accepted = [];
  for (const word of words) {
    const candidate = [...accepted, word].join(' ');
    if (candidate.length > MAX_TITLE_CHARACTERS) break;
    accepted.push(word);
  }
  return accepted.join(' ') || null;
}
