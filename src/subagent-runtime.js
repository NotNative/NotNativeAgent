// SPDX-License-Identifier: Apache-2.0

export function subagentConfig(config, type) {
  const primary = Object.freeze({ ...config.routes.subagent, role: 'primary' });
  const rolePolicy = {
    planner: 'You are the planning stage of a software delivery pipeline. Inspect the repository and write only the requested planning artifacts; do not modify product code or tests.',
    coder: 'You are the implementation stage of a software delivery pipeline. Read the supplied specification completely, implement it, verify your work, and write the requested handoff artifact.',
    tester: 'You are the test stage of a software delivery pipeline. Read the specification and implementation handoff, add focused tests, run relevant verification, and write the requested test artifact.',
    reviewer: 'You are the read-only review stage of a software delivery pipeline. Inspect artifacts and changed files. Do not modify product code, tests, configuration, or documentation; write only the requested verdict artifact.',
    general: 'You are a bounded sub-agent. Complete the delegated task and return verifiable evidence to the parent agent.',
  }[type];
  return Object.freeze({
    ...config, routes: Object.freeze({ ...config.routes, primary }),
    applicationPolicy: [config.applicationPolicy, rolePolicy].filter(Boolean).join('\n\n'),
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
