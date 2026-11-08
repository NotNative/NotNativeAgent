// SPDX-License-Identifier: Apache-2.0
// The slash-command surface over NNA's skill registry: every user-invocable
// skill is one command, listed as `{ name, description }` and run by queueing
// the skill on the session engine — the same lane the TUI's `/skill` takes.
//
// Security: no skill body crosses this surface. The catalog maps to the two
// fields `Command.Info` declares, so a listing exposes name and description
// only; a body reaches a model solely through the engine's own
// `configured_skill` journaling, and command traffic grants nothing.
import { SkillRegistry } from '../skill-registry.js';
import { userDataPaths } from '../product.js';
import { apiError, invalid, objectInput } from './v2-contract.js';

/** The roots every engine and the command palette share.
 *
 *  Why one computation for both: the palette is only honest if it lists exactly
 *  what a session can run. A caller that names its skill roots (a hosted
 *  surface, a test) owns the palette; otherwise it is the operator's user
 *  skills directory, which is what every other NNA surface offers as skills.
 *  Why read the default here rather than inherit the caller's `paths`: the
 *  engines resolve the same default themselves, so agreeing by construction
 *  beats agreeing by hoping the caller passed one object everywhere. */
export function commandSkillRoots(options) {
  if (options.skillRoots) return Object.freeze(options.skillRoots.map((root) => Object.freeze({ ...root })));
  return Object.freeze([Object.freeze({ scope: 'user', path: userDataPaths().skills })]);
}

/** The surface's registered commands, discovered once from `commandSkillRoots`.
 *
 *  Why one discovery for the surface: gold's `command.list` returns currently
 *  registered commands, and the client caches the palette until something emits
 *  `command.updated` — which nothing does here, because NNA has no skill install
 *  or unload at runtime. So the palette is stable for the process's life, which
 *  is also what keeps a listed command runnable: an engine's registry is
 *  immutable after initialization, so a skill added to disk mid-session joins no
 *  session that was already open.
 *  Why the cached promise: two clients opening at once must not discover the
 *  same tree twice; a failed discovery is retried rather than cached, because a
 *  transient read error must not answer commands with 500 for the rest of the
 *  process's life. */
export function createCommandSurface(options) {
  const config = options.config ?? {};
  const roots = commandSkillRoots(options);
  let catalog = null;
  const discover = async () => {
    // Invariant: these are the engine's own registry options (`engine/components.js`)
    // read from the same config a session engine runs, because the palette is
    // only honest if it lists exactly what a session can queue. A hosted run
    // answers from host skills and a local run from `roots`, so a command here
    // is runnable there — never a listing of something no engine will accept.
    const registry = new SkillRegistry({
      hosted: config.executionManifest !== null,
      hostSkills: config.skills,
      roots,
      allowedTools: config.executionManifest?.allowedTools,
    });
    await registry.initialize();
    return registry.catalog({ invocation: 'user' });
  };
  return {
    roots,
    commands() {
      if (!catalog) {
        catalog = discover().then(commandEntries).catch((error) => { catalog = null; throw error; });
      }
      return catalog;
    },
  };
}

/** The wire catalog: deduplicated by name, because `Command.Info` has no field
 *  to distinguish two sources that both registered the same command. */
export function commandEntries(skills) {
  const byName = new Map();
  for (const skill of skills) if (!byName.has(skill.id)) byName.set(skill.id, skill);
  return Object.freeze([...byName.values()]
    .map((skill) => Object.freeze({ name: skill.id, description: skill.description }))
    .sort((left, right) => left.name.localeCompare(right.name)));
}

/** The command's name and the prompt it posts, from the gold payload
 *  `{ name, ...PromptInput.Prompt.fields }`.
 *
 *  Why no `resume`: a command is a task the caller means to run, so a deferred
 *  command would hold operator speech as untrusted briefing and never run it —
 *  the same reason the prompt route refuses the field. `delivery` rides on and
 *  is validated by the shared admission, which owns that mode. */
export function commandPrompt(body) {
  const input = objectInput(body, ['name', 'text', 'files', 'agents', 'skills', 'delivery']);
  if (typeof input.name !== 'string' || !input.name.trim()) throw invalid('name must be a non-empty string');
  const name = input.name.trim();
  // Compatibility: a command with no argument text runs the workflow against the
  // conversation, which is what the TUI's `/skill` does with no words after it.
  const text = input.text === undefined || input.text === ''
    ? `Run the ${name} workflow using the current conversation as the request and report the result.`
    : input.text;
  if (typeof text !== 'string') throw invalid('text must be a string');
  for (const field of ['files', 'agents', 'skills']) {
    // Security: an attachment would silently vanish from the admitted prompt, so
    // the surface refuses rather than run a command on less than it was given.
    if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].length)) {
      throw invalid(`${field} are not supported by this surface`);
    }
  }
  return { name, prompt: { text, ...(input.delivery === undefined ? {} : { delivery: input.delivery }) } };
}

/** Map the skill registry's contract codes onto this route's declared errors.
 *
 *  Why both codes answer the same 404: an `invocation: 'agent'` skill exists but
 *  is not a command anyone may type, and telling the caller which kind is missing
 *  would disclose the operator's skill inventory to a caller that could not
 *  invoke it either way. A skill the palette listed but this session's engine
 *  declined (its required tools are not granted) gives the same answer: the
 *  command is not runnable here, and no listing gap becomes a surface failure. */
export function commandError(error, tag = 'CommandNotFoundError', message = 'Command was not found') {
  if (error?.code === 'skill_not_found' || error?.code === 'skill_invocation_forbidden') {
    return apiError(404, tag, message);
  }
  return error;
}

export function commandApi(context, requireState, admit, surface) {
  const { operations } = context;
  // Why here rather than in the engine lane: skills promote only at turn start,
  // and the workspace state is what knows a turn is admitted or in flight — the
  // engine's own active turn outlives its turn. A command queued mid-turn would
  // bind its workflow to a turn the caller never opened, and a `steer` delivery
  // would inject its text into the running turn while the skill waited one turn
  // too long, so the refusal is the same one the TUI's `/skill` gives.
  const refuseBusy = (state) => {
    if (state.running || state.pending.size) {
      throw apiError(409, 'ConflictError', 'Wait for or cancel the active turn before invoking a skill');
    }
  };
  return {
    commands: () => surface.commands(),
    async command(id, body) {
      const state = requireState(id);
      const { name, prompt } = commandPrompt(body);
      refuseBusy(state);
      // Why queue before admit: the engine promotes queued user skills at turn
      // start, so queueing first binds the workflow to the turn its own command
      // text opens instead of a turn that was already scheduled.
      try { operations.queueCommand(id, name); } catch (error) { throw commandError(error); }
      try { return await admit(context, state, prompt); }
      // Why the undo: a refused admission (a full queue, a rejected delivery)
      // means no turn ever opened, and a skill left pending would bind its
      // workflow to some later, unrelated turn.
      catch (error) { try { operations.unqueueCommand(id, name); } catch { /* the refusal stands */ } throw error; }
    },
    // Compatibility: the SDK declares this experimental route and no GUI calls it.
    // It stages the skill exactly as a command does and starts no turn of its own.
    async useSkill(id, body) {
      const state = requireState(id);
      objectInput(body, ['id', 'resume']);
      if (typeof body.id !== 'string' || !body.id.trim()) throw invalid('id must be a non-empty string');
      if (body.resume === true) throw invalid('Starting a turn from the skill route is not supported; run the command with text instead');
      refuseBusy(state);
      const skill = body.id.trim();
      try { operations.queueCommand(id, skill); }
      catch (error) { throw commandError(error, 'SkillNotFoundError', 'Skill was not found'); }
    },
  };
}
