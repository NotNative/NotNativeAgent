// SPDX-License-Identifier: Apache-2.0
/**
 * What a page reading proves, for the agent actions that follow it.
 *
 * Why this is separate: an observation is the only thing standing between the
 * model and a change it cannot verify, so it is worth reading on its own. A
 * receipt says the agent saw *this* page; it does not say it saw the control it
 * is about to use. A click the page never rendered used to answer "ok" because a
 * selector merely matched something in the document, so a receipt now names the
 * page, the reading, and every element that reading reported.
 *
 * Invariant: an action is allowed only while the current observation was taken
 * on the same URL and covers what the action names. A selector is covered when
 * the surface reported it, or when it descends from the reported scope along
 * direct-child steps that name elements by type, class, id, or quoted attribute.
 * A space combinator or a positional step is refused: any ancestor satisfies the
 * former, and the latter points at whatever the page's layout happens to put
 * there, so neither is evidence of what was rendered.
 */

/** One element step of a selector: a type, class, id, or quoted attribute. */
const STEP = /^[a-z][a-z0-9-]*(?:[.#][A-Za-z0-9_-]+|\[[A-Za-z0-9_-]+="[^"\\]*"\])*$/iu;
/** Actions that change or leave the page, and so need a reading to stand on.
 *  Why back and forward are here: navigating leaves the page the receipt
 *  describes, so acting on one without a fresh reading would rest on a document
 *  that is no longer shown. `history` is the desktop surface's name for the same
 *  pair, and it takes an expected URL, so it is judged like one. */
const CONSEQUENTIAL = Object.freeze(['click', 'scroll', 'back', 'forward', 'history', 'type', 'select', 'capture']);
/** Actions that act on the page the reading describes, confirming it by URL. */
const PAGE_ACTIONS = Object.freeze(['click', 'scroll', 'type', 'select', 'capture', 'history']);
/** Readings that leave the observation in place: a snapshot replaces it, and an
 *  inspect re-reads one element of it. Every other action spends it. */
const REPLACING = Object.freeze(['snapshot', 'inspect']);

/** Whether this action may only run on a reading the surface already reported. */
export const requiresObservation = (action) => CONSEQUENTIAL.includes(action);

const empty = () => ({ url: null, revision: null, id: null, action: null, selector: null,
  scoped: false, covered: null, elements: [] });

/** Whether a candidate selector describes something inside a reported scope. */
export function namesScope(candidate, scope) {
  if (typeof candidate !== 'string' || typeof scope !== 'string' || candidate.length === 0) return false;
  if (candidate === scope) return true;
  // A scope reported as an id ('#panel') is named by that id alone: anything after
  // it is a descendant the snapshot did not report at the top level, and an id is
  // already a statement about identity rather than position.
  if (scope.endsWith('#')) return false;
  if (!candidate.startsWith(`${scope} > `)) return false;
  const rest = candidate.slice(scope.length + 3).trim();
  if (rest.length === 0) return true;
  return rest.split(/\s*>\s*/u).every((step) => STEP.test(step));
}

/**
 * The observation one surface reading establishes.
 *
 * A document snapshot covers every action on that page. A scoped snapshot covers
 * the scope itself and each control the surface reported inside it, so the
 * per-action reading it reports (an `action` field) is not what limits it.
 */
export function readingOf(data) {
  const scope = typeof data?.scope === 'string' ? data.scope : '';
  const document = !scope || scope === 'document';
  const elements = Array.isArray(data?.elements)
    ? data.elements.filter((item) => typeof item?.selector === 'string').map((item) => item.selector) : [];
  return {
    action: typeof data?.action === 'string' ? data.action : null,
    selector: document ? null : scope,
    scoped: !document,
    covered: document || scope.startsWith('#') ? null : [],
    elements: document ? [] : elements,
    url: data?.url, revision: data?.observationRevision, id: data?.observationId,
  };
}

/** A holder whose authority each action consumes, so it cannot be reused. */
export function createObservation() {
  let current = empty();
  let revision = 0;
  const namesUrl = (expectedUrl) => current.revision !== null && current.id !== null && current.url === expectedUrl;
  // A document reading covers the whole page, so any selector on it stands. A
  // scoped reading covers the scope and each control the surface reported in it.
  const coversSelector = (selector) => selector === null || current.selector === null
    || current.elements.includes(selector) || namesScope(selector, current.selector);
  return {
    get state() { return current; },
    /** Whether this action may proceed on what was read; a reason when it may not. */
    check(args) {
      if (!requiresObservation(args.action)) return null;
      // Why two shapes: an action on the current page confirms it by URL, while a
      // back or a forward leaves that page by definition and so only needs proof
      // that a reading was taken and the session is not blind.
      if (PAGE_ACTIONS.includes(args.action)) {
        if (!namesUrl(args.expectedUrl)) return `${args.action} requires a snapshot of the exact page URL`;
        const selector = args.selector ?? null;
        if (coversSelector(selector)) return null;
        return `${args.action} has no observation of ${selector ?? 'that page element'}; snapshot it first and act on a selector the snapshot returned`;
      }
      if (current.revision === null || current.id === null) return `${args.action} requires a snapshot first`;
      return null;
    },
    /** Spends the receipt. A snapshot replaces it and an inspect re-reads one
     *  element without changing the page, so those keep it; a capture spends it
     *  like any other action, because it is one use of one reading. */
    consume(action) {
      if (REPLACING.includes(action)) return revision;
      revision += 1;
      current = empty();
      return revision;
    },
    /** Records a reading only when nothing consumed the authority in between. */
    record(data, authorizedRevision) {
      if (authorizedRevision !== revision) return;
      current = readingOf(data);
    },
  };
}
