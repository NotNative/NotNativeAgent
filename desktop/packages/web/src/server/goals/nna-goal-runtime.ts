// SPDX-License-Identifier: Apache-2.0
/** Event-driven NNA goal safety runner; its ready consumer owns prompt dispatch. */
import type { QueueEnvelope, QueueFeed } from '../queue/queue-feed.ts';
import { getSessionGoal } from './goal-payload.ts';
import { GOAL_REASONS, IDLE_QUIET_MS, KICKOFF_QUIET_MS, RESUME_KICKOFF_MS } from './goal-constants.ts';
import { runNnaGoalSafetyTick, type GoalSafetyPorts, type GoalSafetyTickResult } from './nna-goal-safety-tick.ts';
import { buildGoalWrite } from './goal-metadata.ts';
import { readGoalRevision, sameGoalPayload } from './nna-goal-auditor.ts';
import { GoalRuntimeInactiveError, type GoalDispatchPorts } from './nna-goal-dispatch.ts';

interface GoalTiming { idleMs: number; kickoffMs: number; resumeMs: number }
const DEFAULT_TIMING: GoalTiming = { idleMs: IDLE_QUIET_MS, kickoffMs: KICKOFF_QUIET_MS,
  resumeMs: RESUME_KICKOFF_MS };
interface Armed { timer: ReturnType<typeof setTimeout>; at: number }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Fence an exchange after its feature gate or session is invalidated. */
export function guardGoalAuditExchangePorts(ports: GoalDispatchPorts, isCurrent: () => boolean): GoalDispatchPorts {
  return {
    ...ports,
    writeGoal: (...args) => isCurrent() ? ports.writeGoal(...args)
      : Promise.reject(new GoalRuntimeInactiveError()),
    runAudit: (...args) => isCurrent() ? ports.runAudit(...args)
      : Promise.resolve({ status: 409, body: { error: { code: 'nnd_goal_audit_conflict' } } }),
    sendPrompt: (...args) => isCurrent() ? ports.sendPrompt(...args)
      : Promise.reject(new GoalRuntimeInactiveError()),
    recoverSkippedSend: async (sessionId, directory, persisted, prior, expectedRevision) => {
      const record = await ports.readSession(sessionId, directory);
      const current = getSessionGoal(record);
      if (readGoalRevision(record) !== expectedRevision || !current
        || !sameGoalPayload(current, persisted)) return false;
      const restored = { ...prior, statusReason: GOAL_REASONS.resumed, updatedAt: Date.now() };
      return ports.writeGoal(sessionId, directory, buildGoalWrite(record, restored).body);
    },
  };
}

export class NnaGoalSafetyRuntime {
  private readonly timers = new Map<string, Armed>();
  private readonly directories = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly exchangeGenerations = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  private unsubs: Array<() => void> = [];
  private stopped = false;

  constructor(
    private readonly feed: QueueFeed,
    private readonly ports: GoalSafetyPorts,
    private readonly enabled: () => boolean,
    private readonly onReady: (result: Extract<GoalSafetyTickResult, { kind: 'ready' }>, sessionId: string,
      directory: string, isCurrent: () => boolean) => unknown = () => {},
    private readonly timing: GoalTiming = DEFAULT_TIMING,
  ) {}

  start(): void {
    this.unsubs.push(this.feed.onEvent((envelope) => this.onEvent(envelope)));
    this.unsubs.push(this.feed.onConnected(() => { void this.reconcile(); }));
    void this.reconcile();
  }

  dispose(): void {
    this.stopped = true;
    for (const id of [...this.timers.keys()]) this.clear(id);
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    this.directories.clear();
    this.generations.clear();
    this.exchangeGenerations.clear();
    this.pending.clear();
  }

  /** Reconcile active goals when the profile gate changes without a session event. */
  settingsChanged(): void {
    if (this.stopped) return;
    if (this.enabled()) { void this.reconcile(); return; }
    for (const id of this.directories.keys()) { this.invalidate(id); this.invalidateExchange(id); }
  }

  private remember(id: string, directory: unknown): boolean {
    if (typeof directory === 'string' && directory !== '') this.directories.set(id, directory);
    return this.directories.has(id);
  }

  private onEvent(envelope: QueueEnvelope): void {
    if (this.stopped) return;
    const properties = record(envelope.payload?.properties);
    const id = properties?.sessionID ?? properties?.sessionId;
    if (typeof id !== 'string' || id === '') return;
    if (envelope.payload.type === 'session.deleted') {
      this.invalidate(id); this.invalidateExchange(id); this.directories.delete(id); return;
    }
    const info = record(properties?.info);
    if (!this.remember(id, envelope.directory ?? info?.directory)) return;
    if (!this.enabled()) { this.invalidate(id); this.invalidateExchange(id); return; }
    if (envelope.payload.type === 'session.status') {
      const type = record(properties?.status)?.type;
      if (type === 'idle') this.arm(id, this.timing.idleMs);
      if (type === 'busy' || type === 'retry') { this.invalidate(id); this.invalidateExchange(id); }
    }
    if (envelope.payload.type === 'session.updated' && info && !info.parentID) {
      const goal = getSessionGoal(info);
      if (goal?.status !== 'active') { this.invalidate(id); this.invalidateExchange(id); return; }
      if (this.inFlight.has(id)) {
        this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
        this.arm(id, goal.statusReason === 'resumed' ? this.timing.resumeMs
          : goal.turnsUsed === 0 ? this.timing.kickoffMs : this.timing.idleMs);
        return;
      }
      if (goal.statusReason === 'resumed') this.arm(id, this.timing.resumeMs);
      else if (goal.turnsUsed === 0) this.arm(id, this.timing.kickoffMs);
    }
  }

  private arm(id: string, delay: number): void {
    if (this.inFlight.has(id)) {
      this.pending.set(id, Math.min(delay, this.pending.get(id) ?? Number.POSITIVE_INFINITY));
      return;
    }
    const at = Date.now() + Math.max(0, delay);
    const previous = this.timers.get(id);
    if (previous && previous.at <= at) return;
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => { this.timers.delete(id); void this.tick(id); }, Math.max(1, at - Date.now()));
    timer.unref?.();
    this.timers.set(id, { timer, at });
  }

  private clear(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer.timer);
    this.timers.delete(id);
  }

  private invalidate(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.pending.delete(id);
    this.clear(id);
  }

  private invalidateExchange(id: string): void {
    this.exchangeGenerations.set(id, (this.exchangeGenerations.get(id) ?? 0) + 1);
  }

  async tick(id: string): Promise<GoalSafetyTickResult> {
    if (this.stopped || !this.enabled()) return { kind: 'wait', reason: 'runtime inactive' };
    if (this.inFlight.has(id)) {
      this.pending.set(id, Math.min(this.timing.idleMs, this.pending.get(id) ?? Number.POSITIVE_INFINITY));
      return { kind: 'wait', reason: 'tick in flight' };
    }
    const directory = this.directories.get(id);
    if (!directory) return { kind: 'wait', reason: 'directory unavailable' };
    this.inFlight.add(id);
    const generation = this.generations.get(id) ?? 0;
    const stillCurrent = (): boolean => !this.stopped && this.enabled()
      && generation === (this.generations.get(id) ?? 0) && this.directories.get(id) === directory;
    const guardedPorts: GoalSafetyPorts = {
      ...this.ports,
      writeGoal: (...args) => stillCurrent() ? this.ports.writeGoal(...args) : Promise.resolve(false),
    };
    try {
      const result = await runNnaGoalSafetyTick(guardedPorts, id, directory);
      if (this.stopped) return { kind: 'wait', reason: 'runtime stopped' };
      if (!this.enabled()) return { kind: 'wait', reason: 'runtime inactive' };
      if (!stillCurrent()) {
        return { kind: 'wait', reason: 'session changed during tick' };
      }
      if (result.kind === 'ready') {
        // A ready consumer owns its failures: the safety loop must survive a
        // rejected exchange the same way it survives an unreachable harness.
        try {
          const exchangeGeneration = this.exchangeGenerations.get(id) ?? 0;
          const exchangeCurrent = (): boolean => !this.stopped && this.enabled()
            && exchangeGeneration === (this.exchangeGenerations.get(id) ?? 0)
            && this.directories.get(id) === directory;
          const consumed = this.onReady(result, id, directory, exchangeCurrent);
          if (consumed instanceof Promise) await consumed;
        } catch { /* owned */ }
      }
      if (result.kind === 'wait' && ['status unavailable', 'goal tick dependency unavailable'].includes(result.reason)) {
        this.arm(id, this.timing.idleMs);
      }
      return result;
    } finally {
      this.inFlight.delete(id);
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (!this.stopped && pending !== undefined && this.directories.has(id)) this.arm(id, pending);
    }
  }

  /** Recover active goals after a missed event or feed reconnect. */
  async reconcile(): Promise<void> {
    if (this.stopped || !this.enabled()) return;
    let sessions: unknown;
    try { sessions = await this.ports.listSessions(); } catch { return; }
    if (this.stopped || !Array.isArray(sessions)) return;
    for (const raw of sessions) {
      const item = record(raw);
      if (typeof item?.id !== 'string' || item.parentID || !this.remember(item.id, item.directory)) continue;
      const goal = getSessionGoal(item);
      if (goal?.status !== 'active' || this.timers.has(item.id)) continue;
      this.arm(item.id, goal.statusReason === 'resumed' ? this.timing.resumeMs
        : goal.turnsUsed === 0 ? this.timing.kickoffMs : this.timing.idleMs);
    }
  }
}
