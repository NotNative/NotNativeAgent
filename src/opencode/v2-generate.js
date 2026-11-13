// SPDX-License-Identifier: Apache-2.0
// `POST /api/experimental/generate/text`: one prompt in, one answer out, with no
// session, no turn and no tool loop.
//
// Why this belongs on the OpenCode surface: OpenChamber runs its session titles
// and its per-turn recap through this route (`lib/small-model/index.js` calls
// `client.experimental.generate.text`). Refusing it was not a silent gap —
// OpenChamber logged `[session-assist] generation failed This operation is not
// supported by the NNA OpenCode surface` after every turn, so naming a
// conversation and the "what happened" line above it never worked.
//
// Security: this is a nested inference call, not an operator turn. It carries no
// tools, no conversation history and no retrieved content, and its output is a
// string returned to the caller — it grants no authority and enters no
// transcript. The credential comes from the same isolated store the surface's
// own prompts use, so a GUI-only key keeps working and a Console key is still
// never read here.
import { apiError, invalid, objectInput, textInput } from './v2-contract.js';

/** The largest prompt this route accepts, mirroring the surface's own ingress bound. */
const MAX_PROMPT_CHARS = 65_536;
/** Its own ceiling: a title is a line, a recap a sentence. A runaway answer is refused. */
const MAX_OUTPUT_CHARS = 32_768;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Answer one generate-text request.
 *
 * @param {{ options: object, body: object, directory: string }} input
 * @returns {Promise<{ text: string }>} the `{ data: { text } }` payload
 */
export async function generateText({ options, body, directory }) {
  const input = objectInput(body, ['prompt', 'model']);
  const prompt = textInput(input.prompt, 'prompt', MAX_PROMPT_CHARS);
  if (!prompt.trim()) throw invalid('prompt must not be empty');
  // Why the model is optional: OpenChamber's own fallback chain calls this route
  // with only a prompt when it wants whatever the catalog would pick. A caller
  // that names one gets exactly that one, or a refusal — never a silent switch,
  // because the caller picked it for the thinking level or the cost.
  const reference = input.model == null ? null : modelReference(input.model);
  if (!options.providerSettings) {
    throw apiError(503, 'ServiceUnavailableError', 'The provider catalog is unavailable on this surface');
  }
  const selected = await options.providerSettings.runtimeConfig(options.config, reference ?? undefined, directory);
  refuseMissingCredential(selected);
  return { text: await answer(selected, prompt, options) };
}

/** A `Provider.Model.Ref`: `{ id, providerID, variant? }`. */
function modelReference(value) {
  const model = objectInput(value, ['id', 'providerID', 'variant']);
  textInput(model.id, 'model.id', 256);
  textInput(model.providerID, 'model.providerID', 256);
  if (model.variant != null) textInput(model.variant, 'model.variant', 128);
  return { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) };
}

/**
 * Why the same refusal the prompt route gives: a title that fails is noise, but a
 * title that fails with "connect a key" is the instruction the operator needs.
 * The wording is shared so the two routes cannot drift apart.
 */
function refuseMissingCredential(selected) {
  const provider = selected?.config?.connectionRecords?.[selected.reference.providerID];
  if (provider?.credential) return;
  const stale = selected?.credentialEndpoints;
  throw invalid(stale?.length
    ? `This provider's credential is bound to ${stale.join(', ')} but the provider now points at ${provider.endpoint}. Reconnect the API key for this endpoint in OpenChamber settings before sending a prompt`
    : 'Connect an API key for this OpenCode provider in OpenChamber settings before sending a prompt');
}

/**
 * One non-streaming completion against the resolved route.
 *
 * Why not the engine's provider: that path is a streaming transport with a tool
 * loop, retry budgets and a journal, all of which exist to govern an operator
 * turn. This call has no turn to govern. The request body is the smallest thing
 * an OpenAI-compatible endpoint accepts, and the credential is read through the
 * surface's own isolated broker so both paths use one key and one endpoint bound
 * to it.
 */
async function answer(selected, prompt, options) {
  const provider = selected.config.connectionRecords[selected.reference.providerID];
  const route = selected.config.routes?.primary ?? {};
  const url = `${String(provider.endpoint).replace(/\/+$/u, '')}/chat/completions`;
  const send = options.providerFetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.generateTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Why a consumer callback: the broker's contract hands the secret to a
  // callback rather than returning it, so a credential is never a value this
  // module can hold, log or leak into an error message.
  const request = {
    method: 'POST', signal: controller.signal, destination: provider.endpoint,
    // Why the audit fields: the broker refuses an unattributed secret use, and
    // that refusal is the point — every read of an operator's key is recorded
    // against who asked, where it went and why. This route's answer is a title
    // or a recap, so the record says so rather than borrowing a turn's identity
    // it does not have.
    consumer: 'opencode.generate.text',
    purpose: 'Generate a session title or recap as one nested model call',
    reviewerDecisionId: 'surface_generate_text',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model: route.model ?? provider.model,
      messages: [{ role: 'user', content: prompt }],
      // Why explicit: some hosts default an omitted `stream` to true, and this
      // route's contract is a single JSON answer.
      stream: false,
      ...(Number.isFinite(provider.outputLimitTokens) ? { max_tokens: provider.outputLimitTokens } : {}),
      ...(selected.reasoningEffort ? { reasoning_effort: selected.reasoningEffort } : {}),
    }),
  };
  try {
    return await withCredential(selected, provider, request, async (authorization) => {
      const headers = authorization ? { ...request.headers, authorization: `Bearer ${authorization}` } : request.headers;
      let response;
      try { response = await send(url, { ...request, headers }); }
      catch { throw apiError(controller.signal.aborted ? 504 : 502, 'GenerateUnavailableError',
        controller.signal.aborted ? 'The model did not answer in time' : 'The model endpoint could not be reached'); }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => undefined);
        // Why fixed text: a provider's error body can quote the prompt, and the
        // status alone is what a caller can act on here.
        throw apiError(502, 'GenerateUnavailableError', 'The model endpoint refused the request');
      }
      const payload = await readJson(response);
      const text = extractText(payload);
      if (text === null) throw apiError(502, 'GenerateUnavailableError', 'The model returned no text');
      if (text.length > MAX_OUTPUT_CHARS) {
        throw apiError(502, 'GenerateUnavailableError', 'The model returned more text than this route accepts');
      }
      return text;
    });
  } finally { clearTimeout(timer); }
}

/**
 * Run `consumer` with the provider's bearer, or with none when the provider
 * resolves credentials from its own environment.
 *
 * Why the environment case sends no header: NNA treats an explicit environment
 * reference as the provider's own configuration, where the endpoint reads the
 * variable itself. Inventing an Authorization header from the process
 * environment would send a key the operator never bound to this endpoint.
 */
async function withCredential(selected, provider, request, consumer) {
  const binding = selected.credential;
  if (!binding || binding.source !== 'secret') return consumer(null);
  const broker = selected.broker;
  if (!broker || typeof broker.withSecret !== 'function') {
    throw apiError(503, 'ServiceUnavailableError', 'The credential store is unavailable on this surface');
  }
  return broker.withSecret(binding.secret_id, request, (secret) => {
    // Why the field name: the broker hands back the decrypted *fields* of the
    // record, and this surface stores a provider key under `key`. Reading only
    // that field keeps an unrelated secret field out of an Authorization header.
    const value = secret?.[binding.field ?? 'key'];
    return consumer(typeof value === 'string' && value ? value : null);
  });
}

async function readJson(response) {
  try { return await response.json(); }
  catch { throw apiError(502, 'GenerateUnavailableError', 'The model returned an unreadable answer'); }
}

/** The answer text, from either the chat-completion or the plain-completion shape. */
function extractText(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? payload?.text;
  if (typeof content === 'string') return content;
  // Why: a multi-part answer (some hosts split text under `parts`) is joined
  // rather than dropped, because a title would otherwise be empty for a model
  // that answers that way.
  if (Array.isArray(content)) {
    const joined = content.map((part) => (typeof part === 'string' ? part : part?.text)).filter((part) => typeof part === 'string').join('');
    return joined || null;
  }
  return null;
}
