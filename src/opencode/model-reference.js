// SPDX-License-Identifier: Apache-2.0
// Model references on the OpenCode surface: the three spellings one selection
// has, and which of them is durable.
//
// Why these live together: the surface's own configuration names a model
// `modelID`, the wire's `Provider.Model.Ref` names it `id`, and the durable index
// stores the wire shape. Every place that converted between them by hand was a
// place a session could come back on a model it never ran. One module owns the
// conversions, so a caller reads one function instead of re-deriving the rules.

/** The surface-local reference from a resolved configuration.
 *
 *  Why the fallbacks: a fresh manifest carries `routes.primary`, while a
 *  single-provider scenario configuration may carry only `provider`. Both name
 *  the same choice, and the `nna` fallbacks keep a half-configured document from
 *  producing a record with an absent field rather than a truthful placeholder. */
export function configModelRef(config) {
  const primary = boundedRef(config?.routes?.primary);
  if (primary) return primary;
  const provider = config?.provider;
  if (!provider || typeof provider !== 'object') return null;
  return boundedRef(provider);
}

function boundedRef(source) {
  if (!source || typeof source !== 'object') return null;
  const providerID = typeof source.providerId === 'string' && source.providerId ? source.providerId
    : typeof source.id === 'string' && source.id ? source.id : null;
  const modelID = typeof source.model === 'string' && source.model ? source.model : null;
  if (!providerID && !modelID) return null;
  return { providerID: providerID ?? 'nna', modelID: modelID ?? 'nna' };
}

/** A persistable model selection: the wire's `Provider.Model.Ref` fields.
 *
 *  Why bounded and field-by-field: this value is written to the durable index
 *  and read back at boot, so it must round-trip through JSON without carrying
 *  anything a session record does not expose — no credential, no endpoint, no
 *  provider options. `variant` is the thinking level the operator chose, which
 *  a client shows beside the model and which must survive a restart for the
 *  same reason the model does.
 *
 *  Why both spellings are accepted: the same selection arrives as `{id}` from the
 *  wire and as `{modelID}` from an internal selection object, and a caller that
 *  had to remember which one to pass is how the two drifted apart. */
export function boundedSelection(source) {
  if (!source || typeof source !== 'object') return null;
  const id = typeof source.id === 'string' && source.id ? source.id
    : typeof source.modelID === 'string' && source.modelID ? source.modelID : null;
  const providerID = typeof source.providerID === 'string' && source.providerID ? source.providerID : null;
  if (!id || !providerID) return null;
  const variant = typeof source.variant === 'string' && source.variant ? source.variant : null;
  return { id, providerID, ...(variant ? { variant } : {}) };
}
