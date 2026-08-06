// SPDX-License-Identifier: Apache-2.0

const ENGINEERING_BASELINE = [
  'NNA engineering standards apply directly to your work; they are not reserved for the final reviewer.',
  'Read and obey the target repository guidance. Apply the Power of Ten with engineering judgment to every function and class in each file you touch: avoid needless recursion; bound loops, retries, and growing state; keep functions cohesive; check meaningful outcomes without swallowing failures; and validate external inputs, trust boundaries, state transitions, and critical invariants at their owning boundary.',
  'For interface work also enforce one authoritative owner per state, interaction isolation, observational rendering, bounded UI work, explicit lifecycle recovery, inert hidden views, event-authoritative execution state, platform adapters, invariant tests, accessibility, and preservation of user control on failure.',
  'Do not perform ceremonial refactors. Mark a genuinely irrelevant standard NOT_APPLICABLE with a short reason.',
].join(' ');

const ROLE_STANDARD = Object.freeze({
  planner: 'Encode every applicable engineering standard as an observable acceptance criterion with required evidence.',
  coder: 'Implement these standards while working and inspect the entirety of every touched file, including relevant pre-existing violations.',
  tester: 'Verify applicable bounds, malformed input, cancellation, partial failure, recovery, state ownership, and interface invariants in addition to happy paths.',
  reviewer: 'Independently audit every touched file against the applicable standards and report concrete evidence for each failure or NOT_APPLICABLE disposition.',
});

export function subagentConfig(config, type) {
  const primary = Object.freeze({ ...config.routes.subagent, role: 'primary' });
  const rolePolicy = {
    planner: 'You are the planning stage of a software delivery pipeline. Inspect the repository and write only the requested planning artifacts; do not modify product code or tests.',
    coder: 'You are the implementation stage of a software delivery pipeline. Read the supplied specification completely, implement it, verify your work, and write the requested handoff artifact.',
    tester: 'You are the test stage of a software delivery pipeline. Read the specification and implementation handoff, add focused tests, run relevant verification, and write the requested test artifact.',
    reviewer: 'You are the read-only review stage of a software delivery pipeline. Inspect artifacts and changed files. Do not modify product code, tests, configuration, or documentation; write only the requested verdict artifact.',
    general: 'You are a bounded sub-agent. Complete the delegated task and return verifiable evidence to the parent agent.',
  }[type];
  const engineeringPolicy = ROLE_STANDARD[type] ? `${ENGINEERING_BASELINE} ${ROLE_STANDARD[type]}` : null;
  return Object.freeze({
    ...config, routes: Object.freeze({ ...config.routes, primary }),
    applicationPolicy: [config.applicationPolicy, rolePolicy, engineeringPolicy].filter(Boolean).join('\n\n'),
  });
}

export function subagentOutputStatus(record) {
  if (record?.outcome === 'failed' || record?.type === 'error') return 'failed';
  if (record?.outcome === 'cancelled') return 'cancelled';
  if (record?.outcome === 'denied') return 'denied';
  return 'succeeded';
}

export async function subagentParallelLimit(engine, group, signal) {
  if (group !== 'subagent') return 1;
  const route = engine.router.resolve('subagent');
  const runtime = await engine.modelRuntime.resolve(engine.router, route, signal);
  const capacity = runtime.parallelCapacity ?? 1;
  engine.scheduler.setDiscoveredLimit(route.profile.id, capacity);
  engine.telemetry?.record('subagent.capacity', 'succeeded', {
    provider_profile: route.profile.id, model: route.model, capacity,
    source: runtime.parallelCapacity != null ? runtime.source : 'sequential_fallback',
  });
  return capacity;
}
