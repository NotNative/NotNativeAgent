// SPDX-License-Identifier: Apache-2.0

export const LONG_RUNNING_FOREGROUND_GUIDANCE = 'The command starts a long-running foreground development server, so shell.run cannot return while it is serving. For workspace browser verification, call web.browse with action navigate and path set to the HTML entry file; NNA owns the temporary loopback server and cleans it up automatically. Do not install Playwright in the project or retry the server with Start-Process, Start-Job, or another detached form. If the operator actually wants a persistent server, ask for explicit background-process authorization.';

export function longRunningForegroundInvocation(source) {
  const text = String(source ?? '');
  return /\b(?:python(?:3|\.exe)?|py(?:\.exe)?)\s+-m\s+http\.server\b/iu.test(text);
}

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

function hasTrailingBackgroundOperator(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '&' || text[index - 1] === '&' || text[index + 1] === '&') continue;
    const remainder = text.slice(index + 1).match(/^[ \t]*(?:;|\r?\n|$)/u);
    if (remainder) return true;
  }
  return false;
}
