// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function dataScenario() {
  const wait = async (read, label) => { const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(done => setTimeout(done, 50)); }
    throw new Error(`Data acceptance timed out: ${label}`); };
  const read = async path => { const response = await fetch(path); if (!response.ok) throw new Error(`Read ${path}: ${response.status}`); return response.json(); };
  const button = text => [...document.querySelectorAll('button')].find(row => row.textContent.trim() === text);
  const input = (node, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); };
  let download;
  const capture = event => { const anchor = event.target.closest?.('a[download]'); if (!anchor) return; event.preventDefault();
    download = fetch(anchor.href).then(async response => ({ name: anchor.download, mime: response.headers.get('content-type'), content: await response.text() })); };
  document.addEventListener('click', capture, true);
  const created = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `NNA operational acceptance ${Date.now()}` }) });
  if (!created.ok) throw new Error(`Could not prepare disposable conversation: ${created.status}`);
  const session = await created.json();
  (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click();
  (await wait(() => button('Data and diagnostics'), 'Data')).click();
  await wait(() => document.querySelector('[data-testid="diagnostic-summary"]'), 'diagnostic metadata');
  button('Export diagnostic summary').click();
  const summary = await wait(() => download, 'summary download'); const diagnostic = JSON.parse(summary.content);
  if (diagnostic.paths || diagnostic.environment.some(row => Object.keys(row).sort().join(',') !== 'name,present') || summary.mime !== 'application/json') throw new Error('Diagnostic download included private values or wrong content type');
  document.querySelector('input[type="checkbox"]').click(); button('Export diagnostic summary').click();
  const detailed = JSON.parse((await download).content); if (!detailed.paths?.data) throw new Error('Requested paths were absent');
  document.querySelector('input[type="checkbox"]').click();
  [...document.querySelectorAll('[role="tab"]')].find(row => row.textContent === 'Conversations').click();
  const search = await wait(() => document.querySelector('[aria-label="Search data conversations"]'), 'conversation search'); input(search, session.title);
  const row = () => [...document.querySelectorAll('[data-testid="data-conversation"]')].find(item => item.querySelector('h4')?.textContent === session.title);
  await wait(row, 'disposable conversation');
  const rowButton = text => [...(row()?.querySelectorAll('button') ?? [])].find(item => item.textContent === text);
  const changeArchive = async (action, archived) => { (await wait(() => rowButton(action) && !rowButton(action).disabled && rowButton(action), action)).click();
    await wait(async () => Boolean((await read(`/api/session/${session.id}`)).time.archived) === archived, action);
    await wait(() => rowButton(archived ? 'Restore' : 'Archive') && !rowButton(archived ? 'Restore' : 'Archive').disabled, 'archive UI acknowledgement'); };
  try {
    await changeArchive('Archive', true); await changeArchive('Restore', false);
    download = null; rowButton('Export transcript').click(); const transcript = await wait(() => download, 'transcript download');
    if (!transcript.content.includes(session.title) || transcript.mime !== 'text/markdown;charset=utf-8') throw new Error('Transcript export did not match the selected conversation');
    const filter = document.querySelector('[aria-label="Conversation archive filter"]'); filter.value = 'archived'; filter.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => !document.querySelector('[data-testid="data-conversation"]'), 'archive filtering'); filter.value = 'all'; filter.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => document.querySelector('[data-testid="data-conversation"]'), 'filter reset');
  } finally { if (!(await read(`/api/session/${session.id}`)).time.archived) await changeArchive('Archive', true); document.removeEventListener('click', capture, true); }
  return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', diagnosticRedaction: true, optionalPaths: true, archiveRestore: true, transcriptDownload: true, filtering: true, disposableConversationArchived: true };
}

await runInstalledUiAcceptance(dataScenario, 'NNA_INSTALLED_DATA_OK');
