// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseNativeGatewayStatus, parseNativeGatewayTest, parseNativeSearxngStatus,
  type GatewayTestOkReceipt } from '../action-triage.ts';

const gatewayStatus = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', family: 'gateway', action: 'status', application: 'not_applied',
  config: { enabled: true, configured: true, token_source: 'NNA_TELEGRAM_BOT_TOKEN',
    authorized_user_ids: ['124'], workspace_root: 'C:\\ws', polling_timeout_seconds: 30 },
  runtime: { running: true, pid: 4242, verified: true } });

const botOk = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', family: 'gateway', action: 'test', application: 'not_applied',
  ok: true, bot: { id: 7, username: 'demo_bot' } });

const testRefusal = () => ({ schema_version: '1.0', installation_id: null, data_id: null,
  scope: 'user', family: 'gateway', action: 'test', application: 'not_applied',
  refused: true, reason: 'telegram_token_missing',
  hint: 'no Telegram token is configured; set it with nna gateway token (or token-env) first' });

const cliOnly = () => ({ schema_version: '1.0', installation_id: null, data_id: null,
  scope: 'user', family: 'searxng', action: 'refresh-managed', application: 'not_applied',
  refused: true, reason: 'nnd_action_cli_only',
  hint: 'SearXNG refresh-managed drives docker compose against the managed root; run \'nna web-search refresh-managed\' in the terminal' });

const searxngStatus = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', family: 'searxng', action: 'managed-status', application: 'not_applied',
  status: { endpoint: 'http://127.0.0.1:8888/search', container: 'searxng',
    container_error: null, search: { ok: true } } });

const drift = (base: () => object,
  modifier: (value: Record<string, unknown>) => Record<string, unknown>) => () =>
  modifier({ ...(base() as Record<string, unknown>) });

describe('native gateway runtime receipt', () => {
  it('parses the honest merged view', () => {
    const receipt = parseNativeGatewayStatus(gatewayStatus());
    expect(receipt.config.configured).toBe(true);
    expect(receipt.runtime.running).toBe(true);
  });
  it('refuses drift', () => {
    expect(() => parseNativeGatewayStatus(null)).toThrow();
    expect(() => parseNativeGatewayStatus(drift(gatewayStatus, (v) => ({ ...v, family: 'searxng' }))())).toThrow();
    expect(() => parseNativeGatewayStatus(drift(gatewayStatus, (v) => ({ ...v, runtime: { running: 'yes' } }))())).toThrow();
    expect(() => parseNativeGatewayStatus(drift(gatewayStatus,
      (v) => ({ ...v, config: { ...(v.config as Record<string, unknown>), token_source: 7 } }))())).toThrow();
    expect(() => parseNativeGatewayStatus(drift(gatewayStatus, (v) => ({ ...v, runtime: { running: true } }))())).toThrow();
    expect(() => parseNativeGatewayStatus(drift(gatewayStatus, (v) => ({ ...v, extra: true }))())).toThrow();
  });
});

describe('native gateway test receipt', () => {
  it('parses both verdicts', () => {
    const ok = parseNativeGatewayTest(botOk()) as GatewayTestOkReceipt;
    expect(ok.ok).toBe(true);
    const refusal = parseNativeGatewayTest(testRefusal());
    expect(refusal).toMatchObject({ refused: true, reason: 'telegram_token_missing' });
  });
  it('refuses drift', () => {
    expect(() => parseNativeGatewayTest(drift(botOk, (v) => ({ ...v, ok: false }))())).toThrow();
    expect(() => parseNativeGatewayTest(drift(botOk, (v) => ({ ...v, bot: { id: 7, username: 5 } }))())).toThrow();
    expect(() => parseNativeGatewayTest(drift(botOk, (v) => ({ ...v, extra: true }))())).toThrow();
    expect(() => parseNativeGatewayTest(drift(testRefusal, (v) => ({ ...v, reason: '' }))())).toThrow();
    expect(() => parseNativeGatewayTest(null)).toThrow();
  });
});

describe('cli-only refusal receipts across families', () => {
  it('parses and fronts the terminal hint', () => {
    const refusal = parseNativeGatewayTest(cliOnly());
    expect(refusal).toMatchObject({ refused: true, reason: 'nnd_action_cli_only' });
    expect('hint' in refusal && refusal.hint).toContain('terminal');
  });
});

describe('native searxng managed-status receipt', () => {
  it('parses the deployment observation', () => {
    const receipt = parseNativeSearxngStatus(searxngStatus());
    expect(receipt.status.container).toBe('searxng');
    expect(receipt.status.search.ok).toBe(true);
  });
  it('refuses drift', () => {
    expect(() => parseNativeSearxngStatus(null)).toThrow();
    expect(() => parseNativeSearxngStatus(drift(searxngStatus, (v) => ({ ...v, action: 'status' }))())).toThrow();
    expect(() => parseNativeSearxngStatus(drift(searxngStatus,
      (v) => ({ ...v, status: { ...(v.status as Record<string, unknown>), container: 7 } }))())).toThrow();
    expect(() => parseNativeSearxngStatus(drift(searxngStatus,
      (v) => ({ ...v, status: { ...(v.status as Record<string, unknown>), search: { ok: 'yes' } } }))())).toThrow();
    expect(() => parseNativeSearxngStatus(drift(searxngStatus, (v) => ({ ...v, extra: true }))())).toThrow();
  });
});
