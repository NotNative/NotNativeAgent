// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function scrollScenario() {
  const wait = async (read, label) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const value = read(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Scroll acceptance timed out: ${label}`);
  };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const find = selector => document.querySelector(selector);
  await wait(() => window.__notnativeAppReady === true, 'completed application boot');
  await wait(() => find('[data-testid="chat-draft-landing"]') && find('button[aria-label="Choose model"]'), 'initial draft restored');
  // Invariant: fixtures change only rendered content, never session or workspace records.
  const row = await wait(() => find('[data-testid="session-row"]'), 'existing conversation');
  row.click();
  const transcript = await wait(() => {
    const node = find('[data-chat-column]'); return node?.querySelector('article') && node;
  }, 'loaded transcript');
  const context = find('button[aria-label="Context"]');
  if (!find('[data-testid="operator-surface-title"]')?.getBoundingClientRect().height) context.click();
  await frame();
  const left = find('[data-testid="workspace-scroll"]'), right = find('[data-testid="operator-scroll"]');
  const header = find('[data-testid="app-header"]'), composer = find('[data-composer-bound]');
  const title = find('[data-testid="operator-surface-title"]');
  const regions = [transcript, left, right], previous = regions.map(node => node.scrollTop);
  const shortList = left.scrollHeight === left.clientHeight;
  const fixtures = [];
  const bounds = nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return [rect.top, rect.bottom]; });
  const fixed = [header, composer, find('[data-testid="session-sidebar"]'), title];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    for (const node of regions) {
      check(node?.clientHeight > 0, 'Scroll region is not visible');
      const filler = document.createElement('div'); filler.style.height = `${innerHeight * 4}px`;
      filler.textContent = 'Disposable scroll geometry fixture'; node.append(filler); fixtures.push(filler);
    }
    await frame();
    const baseline = bounds(fixed);
    check(baseline.every(([top, bottom]) => top >= -1 && bottom <= innerHeight + 1), 'Fixed controls escape viewport');
    check(document.documentElement.scrollHeight <= innerHeight + 1, 'Document expanded with panel content');
    for (const [index, node] of regions.entries()) {
      check(node.scrollHeight > node.clientHeight + 100, 'Fixture did not create overflow');
      const before = regions.map(region => region.scrollTop);
      node.scrollTop = node.scrollHeight; await frame();
      check(node.scrollTop > before[index], 'Region cannot scroll');
      check(regions.every((region, other) => other === index || region.scrollTop === before[other]), 'Scrolling moved another panel');
      check(JSON.stringify(bounds(fixed)) === JSON.stringify(baseline), 'Scrolling moved fixed controls');
      check(window.scrollY === 0, 'Scrolling moved the document');
    }
    // Short lists must not acquire artificial scroll space.
    fixtures.forEach(node => node.remove()); await frame();
    if (shortList) check(left.scrollHeight === left.clientHeight, 'Short workspace list has excess scroll space');
    return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron',
      independentRegions: 3, fixedControls: true, documentContained: true, shortListDoesNotScroll: shortList };
  } finally {
    fixtures.forEach(node => node.remove());
    regions.forEach((node, index) => { node.scrollTop = previous[index]; });
  }
}

await runInstalledUiAcceptance(scrollScenario, 'NNA_INSTALLED_SCROLL_OK');
