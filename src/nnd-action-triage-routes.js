// SPDX-License-Identifier: Apache-2.0
/** Native gateway runtime and managed-SearXNG action routes over
 * /v1/nnd/configuration/gateway/status + /actions/test and
 * /v1/nnd/configuration/web-search/actions/managed-status. Why: the
 * gateway_action/web_search_action census families are per-verb
 * operator_action rows and the slice is a per-verb triage: the
 * config-mutation verbs (gateway token/token-stdin/token-env/authorize/
 * revoke/workspace/enable/disable; WebSearch add/promote/remove-profile/
 * reset/disable/configure/install-if-unconfigured) are ALREADY natively
 * served by the two settings save/preview/operations surfaces; the runtime
 * verbs (gateway run/start/stop; managed deploy/install-local/remove/
 * remove-deployment/refresh-managed-when-mutating) spawn Docker or detach a
 * child process — CLI-only: this surface refuses them honestly
 * ("run the command in the terminal") instead of pretending. The status and
 * test reads reuse the CLI authorities verbatim: gateway status =
 * gatewayPublicStatus(config) + runtimeStatus(pid file, identity-verified),
 * test = the live Telegram getMe probe over the configured token; managed
 * status = SearxngDeployment.status() (HTTP probe + docker ps). Invariants:
 * the token value never projects; the test action is read-only (getMe);
 * refusals are honest codes with an operator-facing hint, never fake
 * receipts.
 */
import { ContractError } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { loadGatewayConfig, gatewayPublicStatus, gatewayToken } from './gateway/config.js';
import { runtimeStatus } from './gateway-cli.js';
import { TelegramApi } from './gateway/telegram-api.js';
import { SearxngDeployment } from './searxng-deployment.js';

const GATEWAY_BASE = '/v1/nnd/configuration/gateway';
const WEB_SEARCH_BASE = '/v1/nnd/configuration/web-search';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const invalid = () => new ContractError('nnd_action_triage_request_invalid', 'Native action-triage request is invalid.');
const projection = () => new ContractError('nnd_action_triage_projection_invalid', 'Native action-triage projection refused a drifted receipt.');

export function createNndGatewayStatusService({ paths, installationId, dataId,
  loadConfig = loadGatewayConfig, statusRunner = runtimeStatus, environment = process.env }) {
  if (typeof paths?.gatewayConfig !== 'string' || typeof paths?.gateway !== 'string'
    || !ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw invalid();
  return Object.freeze({
    async status() {
      const config = await loadConfig(paths.gatewayConfig);
      const publicStatus = gatewayPublicStatus(config, environment);
      const runtime = await statusRunner(paths, { environment });
      return Object.freeze({ schema_version: '1.0', installation_id: installationId,
        data_id: dataId, scope: 'user', family: 'gateway', action: 'status',
        application: 'not_applied', config: publicStatus, runtime });
    },
  });
}

export function createNndGatewayTestService({ paths, installationId, dataId,
  loadConfig = loadGatewayConfig, telegramFactory = (token) => new TelegramApi(token),
  environment = process.env }) {
  if (typeof paths?.gatewayConfig !== 'string'
    || !ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw invalid();
  return Object.freeze({
    async test() {
      const config = await loadConfig(paths.gatewayConfig);
      const token = gatewayToken(config, environment).value;
      if (!token) {
        return refusal('gateway', 'test', 'telegram_token_missing',
          'no Telegram token is configured; set it with nna gateway token (or token-env) first');
      }
      try {
        const bot = await telegramFactory(token).getMe();
        return Object.freeze({ schema_version: '1.0', installation_id: installationId,
          data_id: dataId, scope: 'user', family: 'gateway', action: 'test',
          application: 'not_applied', ok: true, bot: { id: bot.id, username: bot.username ?? null } });
      } catch (error) {
        return refusal('gateway', 'test', 'gateway_test_unreachable',
          `the Telegram API probe failed (${error?.code ?? error?.message ?? 'unknown error'}); check connectivity or the token`);
      }
    },
  });
}

function refusal(family, action, reason, hint) {
  return Object.freeze({ schema_version: '1.0', installation_id: null, data_id: null,
    scope: 'user', family, action, application: 'not_applied', refused: true,
    reason, hint, runtime: null, config: null });
}

/** CLI-only runtime verbs: an honest, registered refusal (the native
 * service process never detaches or kills gateway children; the operator
 * runs those in the terminal). */
export function gatewayActionRefusal(action) {
  if (!['run', 'start', 'stop'].includes(action)) throw invalid();
  return refusal('gateway', action, 'nnd_action_cli_only',
    action === 'run'
      ? 'nna gateway run stays attached to the terminal; run it there'
      : action === 'start'
        ? 'nna gateway start detaches a child process; run it in the terminal'
        : 'nna gateway stop signals a detached process; run it in the terminal');
}


export function searxngActionRefusal(action) {
  if (!['deploy', 'install-local', 'refresh-managed', 'remove', 'remove-deployment'].includes(action)) throw invalid();
  return refusal('searxng', action, 'nnd_action_cli_only',
    `SearXNG ${action} drives docker compose against the managed root; run 'nna web-search ${action}' in the terminal`);
}

export function createNndSearxngStatusService({ paths, installationId, dataId,
  deploymentFactory = (root) => new SearxngDeployment({ root }) }) {
  if (typeof paths?.managedSearxng !== 'string'
    || !ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw invalid();
  return Object.freeze({
    async managedStatus() {
      const deployment = deploymentFactory(paths.managedSearxng);
      const value = await deployment.status();
      return Object.freeze({ schema_version: '1.0', installation_id: installationId,
        data_id: dataId, scope: 'user', family: 'searxng', action: 'managed-status',
        application: 'not_applied', status: value });
    },
  });
}

export function projectGatewayStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,application,config,data_id,family,'
      + 'installation_id,runtime,schema_version,scope'
    || value.schema_version !== '1.0' || typeof value.installation_id !== 'string'
    || !ID.test(value.installation_id) || typeof value.data_id !== 'string'
    || !ID.test(value.data_id) || value.scope !== 'user' || value.family !== 'gateway'
    || value.action !== 'status' || value.application !== 'not_applied'
    || !value.config || typeof value.config !== 'object' || Array.isArray(value.config)
    || Object.keys(value.config).sort().join(',') !== 'authorized_user_ids,configured,enabled,'
      + 'polling_timeout_seconds,token_source,workspace_root'
    || typeof value.config.enabled !== 'boolean'
    || typeof value.config.configured !== 'boolean'
    || (value.config.token_source !== null && typeof value.config.token_source !== 'string')
    || !Array.isArray(value.config.authorized_user_ids)
    || value.config.authorized_user_ids.some((id) => typeof id !== 'string' && !/^[1-9][0-9]{0,19}$/u.test(String(id)))
    || (value.config.workspace_root !== null && typeof value.config.workspace_root !== 'string')
    || !Number.isSafeInteger(value.config.polling_timeout_seconds)) throw projection();
  const runtime = value.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
    || typeof runtime.running !== 'boolean'
    || (runtime.running === true && !Number.isSafeInteger(runtime.pid))
    || (runtime.pid !== undefined && typeof runtime.pid !== 'number')
    || (runtime.verified !== undefined && typeof runtime.verified !== 'boolean')
    || (runtime.stale !== undefined && typeof runtime.stale !== 'boolean')
    || (runtime.reason !== undefined && typeof runtime.reason !== 'string')) throw projection();
  return { schema_version: '1.0', installation_id: value.installation_id, data_id: value.data_id,
    scope: 'user', family: 'gateway', action: 'status', application: 'not_applied',
    config: value.config, runtime };
}

export function projectGatewayTest(value) {
  const keys = Object.keys(value).sort().join(',');
  if (value && typeof value === 'object' && !Array.isArray(value) && value.refused !== true) {
    if (keys !== 'action,application,bot,data_id,family,installation_id,ok,schema_version,scope'
      || value.schema_version !== '1.0' || typeof value.installation_id !== 'string'
      || !ID.test(value.installation_id) || typeof value.data_id !== 'string'
      || !ID.test(value.data_id) || value.scope !== 'user' || value.family !== 'gateway'
      || value.action !== 'test' || value.application !== 'not_applied' || value.ok !== true
      || !value.bot || typeof value.bot !== 'object' || Array.isArray(value.bot)
      || Object.keys(value.bot).sort().join(',') !== 'id,username'
      || !Number.isSafeInteger(value.bot.id)
      || (value.bot.username !== null && typeof value.bot.username !== 'string')) throw projection();
    return { schema_version: '1.0', installation_id: value.installation_id, data_id: value.data_id,
      scope: 'user', family: 'gateway', action: 'test', application: 'not_applied',
      ok: true, bot: value.bot };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || keys !== 'action,application,config,data_id,family,hint,installation_id,reason,'
      + 'refused,runtime,schema_version,scope'
    || value.refused !== true || typeof value.reason !== 'string' || typeof value.hint !== 'string'
    || value.reason.length === 0 || value.hint.length === 0) throw projection();
  return { schema_version: '1.0', installation_id: null, data_id: null, scope: 'user',
    family: value.family, action: value.action, application: 'not_applied',
    refused: true, reason: value.reason, hint: value.hint };
}

export function projectSearxngStatus(value) {
  const statusKeys = 'container,container_error,endpoint,search';
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,application,data_id,family,'
      + 'installation_id,schema_version,scope,status'
    || value.schema_version !== '1.0' || typeof value.installation_id !== 'string'
    || !ID.test(value.installation_id) || typeof value.data_id !== 'string'
    || !ID.test(value.data_id) || value.scope !== 'user' || value.family !== 'searxng'
    || value.action !== 'managed-status' || value.application !== 'not_applied'
    || !value.status || typeof value.status !== 'object' || Array.isArray(value.status)
    || Object.keys(value.status).sort().join(',') !== statusKeys
    || typeof value.status.container !== 'string'
    || (value.status.container_error !== null && typeof value.status.container_error !== 'string')
    || typeof value.status.endpoint !== 'string'
    || !value.status.search || typeof value.status.search !== 'object'
    || typeof value.status.search.ok !== 'boolean'
    || (value.status.search.error !== undefined && typeof value.status.search.error !== 'string')
  ) throw projection();
  return { schema_version: '1.0', installation_id: value.installation_id, data_id: value.data_id,
    scope: 'user', family: 'searxng', action: 'managed-status', application: 'not_applied',
    status: value.status };
}

const REQUEST_BYTES = 4_096;
const RESPONSE_BYTES = 16_384;

/** Per-verb triage map for the 24 gateway_action/web_search_action census rows
 * (all kind operator_action, store path_class config/gateway.json +
 * config/web-search.json, validator runGatewayCommand/runWebSearchCommand):
 * - gateway token / token-stdin / token-env → POST /v1/nnd/configuration/
 *   gateway/save operations [{op:"set_token"}|{op:"clear_token"}] +
 *   token_env field update (native-gateway-timeout CATALOG field token,
 *   operations set_token/clear_token; token-stdin and token-env are input
 *   variants of set_token — stdin supplies the value, env replaces it with a
 *   token_env + clear) — web-search GUIs equivalent: gateway timeout panel.
 * - gateway authorize / revoke → the same save surface, operations
 *   [{op:"authorize"}|{op:"revoke"}] on field authorized_user_ids.
 * - gateway workspace → the same save surface (workspace_root field).
 * - gateway enable / disable → the same save surface (enabled field;
 *   class next_service_start, application 'restart_gateway').
 * - gateway status → the read route BELOW (GET /gateway/status) — a live
 *   merged config + runtime view the stored-file read cannot show.
 * - gateway test → POST /gateway/actions/test (Telegram getMe over the
 *   resolved token, read-only).
 * - gateway run / start / stop → refused natively below (CLI authority:
 *   attached/detached runtime and process signal).
 * - web_search status → GET /v1/nnd/configuration/web-search (the settings
 *   read; the status verb IS that file view).
 * - web_search configured-verb reads (configure precondition) and
 *   install-if-unconfigured → the settings save surface with the candidate
 *   profile (same transform as replacePrimaryWebSearch, native
 *   operations add_profile/promote_profile/remove_profile).
 * - web_search add / promote / remove-profile → the settings save surface
 *   operations [{op:"add_profile"}|{op:"promote_profile"}|{op:"remove_profile"}].
 * - web_search reset / disable → the settings save surface resetting
 *   enabled=false (and profiles cleared per reset) with class next_search.
 * - web_search deploy / install-local → refused natively below (docker
 *   compose lifecycle); install-if-unconfigured with a pre-running local
 *   SearXNG uses configure, so no native gap remains.
 * - web_search remove-managed deployment verbs (remove / remove-deployment)
 *   → refused natively below.
 * - web_search refresh-managed → the read managed-status BELOW (the CLI
 *   verb refreshes only when assets drift; the native surface observes the
 *   current deployment and its staleness honestly instead — the refresh,
 *   when needed, is the deploy refusal's CLI authority).
 * Census sensitivity: all 24 rows pin "security" (operator authority over
 * the Telegram bot and SearXNG deployment). */

export async function dispatchNndActionTriageRequest(request, response, context) {
  const path = context.url.pathname;
  const gateway = path === `${GATEWAY_BASE}/status` || path === `${GATEWAY_BASE}/actions/test`
    || gatewayRefusalPath(path);
  const searxng = path === `${WEB_SEARCH_BASE}/actions/managed-status` || searxngRefusalPath(path);
  if (!gateway && !searxng) return false;
  // Permission split follows the compatibility_service_action precedent
  // (service-lifecycle.tsx): reads carry nnd.configuration.read; refused-verb
  // routes still demand the verb's operational permission (nnd.service.manage)
  // so the 403 vs honest-refusal distinction stays intact.
  requireIntegrationPermission(context.principal,
    gatewayRefusalPath(path) || searxngRefusalPath(path)
      ? 'nnd.service.manage' : 'nnd.configuration.read');
  return gateway ? dispatchGatewayTriage(request, response, context)
    : dispatchSearxngTriage(request, response, context);
}

function triageRoute(response, runner, project) {
  return async () => {
    const receipt = project(await runner());
    if (Buffer.byteLength(JSON.stringify(receipt)) > RESPONSE_BYTES) throw invalid();
    return send(response, 200, receipt);
  };
}

function requireTriageService(context, property, method, label) {
  const service = context[property];
  if (!service || typeof service[method] !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', label);
  }
  return service;
}

async function dispatchGatewayTriage(request, response, context) {
  const path = context.url.pathname;
  if (path !== `${GATEWAY_BASE}/status` && path !== `${GATEWAY_BASE}/actions/test`
    && !gatewayRefusalPath(path)) return send(response, 404, { error: 'not_found' });
  if (path === `${GATEWAY_BASE}/status`) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    const service = requireTriageService(context, 'nndGatewayStatusService', 'status',
      'Native gateway runtime status is unavailable.');
    return triageRoute(response, () => service.status(), projectGatewayStatus)();
  }
  if (path === `${GATEWAY_BASE}/actions/test`) {
    if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    await readJsonBody(request, REQUEST_BYTES);
    const service = requireTriageService(context, 'nndGatewayTestService', 'test',
      'Native gateway test action is unavailable.');
    return triageRoute(response, () => service.test(), projectGatewayTest)();
  }
  if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  await readJsonBody(request, REQUEST_BYTES);
  return triageRoute(response,
    () => gatewayActionRefusal(path.slice(`${GATEWAY_BASE}/actions/`.length)), projectGatewayTest)();
}

async function dispatchSearxngTriage(request, response, context) {
  const path = context.url.pathname;
  if (path !== `${WEB_SEARCH_BASE}/actions/managed-status` && !searxngRefusalPath(path)) {
    return send(response, 404, { error: 'not_found' });
  }
  if (path === `${WEB_SEARCH_BASE}/actions/managed-status`) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    const service = requireTriageService(context, 'nndSearxngStatusService', 'managedStatus',
      'Native managed SearXNG status is unavailable.');
    return triageRoute(response, () => service.managedStatus(), projectSearxngStatus)();
  }
  if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  await readJsonBody(request, REQUEST_BYTES);
  return triageRoute(response,
    () => searxngActionRefusal(path.slice(`${WEB_SEARCH_BASE}/actions/`.length)), projectGatewayTest)();
}

function gatewayRefusalPath(path) {
  return ['/actions/run', '/actions/start', '/actions/stop']
    .includes(path.slice(GATEWAY_BASE.length));
}

function searxngRefusalPath(path) {
  return ['/actions/deploy', '/actions/install-local', '/actions/refresh-managed',
    '/actions/remove', '/actions/remove-deployment'].includes(path.slice(WEB_SEARCH_BASE.length));
}
