// SPDX-License-Identifier: Apache-2.0
/** F6.3 commit-graph lanes: assign each commit (reverse-chronological log
 * order) a lane index and per-row edge targets so the history dialog can
 * draw the branch/merge graph. Pure and deterministic. Lanes are reused from
 * a free pool once their expected commit is claimed or abandoned, so
 * recurring forks do not accumulate dead lanes. Parents that already
 * appeared earlier in the window (clock-skewed ordering) get a terminal
 * edge without keeping a lane open. Parents beyond maxCount keep their
 * allocated lane open without rendering. */
export interface LaneRow { lane: number; edges: { from: number; to: number }[]; laneCount: number }

export function computeCommitLanes(commits: { hash: string; parents: string[] }[]): LaneRow[] {
  const rows: LaneRow[] = [];
  const pending = new Map<number, string>(); // lane → expected parent hash
  const free: number[] = []; // reusable lanes, kept ascending
  const seen = new Set<string>();
  const lastLane = new Map<string, number>();
  let nextLane = 0;
  const allocate = (hash: string): { lane: number; created: boolean } => {
    for (const [lane, expected] of pending) {
      if (expected === hash) return { lane, created: false };
    }
    return { lane: free.length > 0 ? free.shift()! : nextLane++, created: true };
  };
  for (const commit of commits) {
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    const { lane } = allocate(commit.hash);
    seen.add(commit.hash);
    lastLane.set(commit.hash, lane);
    for (const [waiting, expected] of [...pending]) {
      if (expected === commit.hash) { pending.delete(waiting); free.push(waiting); }
    }
    free.sort((a, b) => a - b);
    const edges: { from: number; to: number }[] = [];
    let laneUsed = false;
    parents.forEach((parent, at) => {
      if (seen.has(parent)) { // earlier row: terminal edge to its historical lane
        edges.push({ from: lane, to: lastLane.get(parent) ?? lane });
        return;
      }
      if (at === 0) { // first parent continues this lane (or curves into an open one)
        const open = [...pending].find(([, expected]) => expected === parent);
        if (open) edges.push({ from: lane, to: open[0] });
        else { pending.set(lane, parent); laneUsed = true; edges.push({ from: lane, to: lane }); }
        return;
      }
      const target = allocate(parent);
      if (target.created) pending.set(target.lane, parent);
      edges.push({ from: lane, to: target.lane });
    });
    if (!laneUsed && !pending.has(lane)) {
      free.push(lane);
      free.sort((a, b) => a - b);
    }
    rows.push({ lane, edges, laneCount: nextLane });
  }
  return rows;
}
