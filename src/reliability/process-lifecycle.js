// SPDX-License-Identifier: Apache-2.0

const PROCESS_NOUN = String.raw`(?:process|server|service|daemon|job|watcher|preview|listener|tunnel)`;

export const DETACHED_PROCESS_GUIDANCE = 'The command would detach a process that can outlive shell.run and the active turn, but authenticated user intent does not explicitly request a persistent or background process. Use a bounded foreground command that terminates and cleans up descendants, or ask the operator to authorize the persistent process. Do not retry with an equivalent Start-Process, Start-Job, nohup, disown, or background form.';

export function detachedProcessInvocation(source, shell = 'auto') {
  const text = String(source ?? '');
  if (!text.trim()) return false;
  if (/\b(?:DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP)\b|\bstart_new_session\s*=\s*true\b|\bdaemon\s*=\s*true\b|\bdetached\s*:\s*true\b|(?:^|\s)--(?:detach(?:ed)?|daemon)(?:\s|$)/iu.test(text)) return true;
  const processStarts = [...text.matchAll(/\bStart-Process\b([^;\r\n]*)/giu)];
  if (processStarts.some((match) => !/(?:^|\s)-Wait(?:\s|$)|\|\s*Wait-Process\b/iu.test(match[1]))) return true;
  if (/\bStart-(?:Thread)?Job\b/iu.test(text) && !/\bWait-Job\b/iu.test(text)) return true;
  if (/\b(?:nohup|setsid|disown|daemonize|systemd-run)\b/iu.test(text)) return true;
  if (/^(?:cmd(?:\.exe)?)?$/iu.test(shell) && /(?:^|[&\r\n])\s*start\s+(?!\/wait\b)/imu.test(text)) return true;
  return /^(?:sh|bash|zsh|fish)$/iu.test(shell) && hasTrailingBackgroundOperator(text);
}

export function detachedProcessAuthorized(authority) {
  const latestIntent = authority?.intent?.at(-1)?.content;
  if (detachedProcessProhibition(latestIntent)) return false;
  return explicitDetachedProcessIntent(latestIntent)
    || explicitDetachedProcessIntent(authority?.mission?.outcome);
}

export function explicitDetachedProcessIntent(value) {
  const text = String(value ?? '');
  if (detachedProcessProhibition(text)) return false;
  const lifecycle = new RegExp(String.raw`\b(?:background|detach(?:ed|ment)?|persistent|daemon(?:ized)?)\b.{0,80}\b${PROCESS_NOUN}\b|\b${PROCESS_NOUN}\b.{0,80}\b(?:background|detach(?:ed|ment)?|persistent|keep\s+running|leave\s+(?:it\s+)?running)\b`, 'iu');
  return lifecycle.test(text);
}

function detachedProcessProhibition(value) {
  const negative = new RegExp(String.raw`\b(?:do\s+not|don't|never|avoid|stop)\b.{0,80}\b(?:background|detach(?:ed|ment)?|persistent|${PROCESS_NOUN})\b`, 'iu');
  return negative.test(String(value ?? ''));
}

function hasTrailingBackgroundOperator(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '&' || text[index - 1] === '&' || text[index + 1] === '&') continue;
    const remainder = text.slice(index + 1).match(/^[ \t]*(?:;|\r?\n|$)/u);
    if (remainder) return true;
  }
  return false;
}
