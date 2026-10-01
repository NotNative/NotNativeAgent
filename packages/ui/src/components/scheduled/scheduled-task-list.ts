// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled-task list state (doc 12 §H rows + doc 03 §5.16): loads a
 * project's task list through the typed client, folds the "no store yet"
 * 404 into an empty list (E-09-23 a), wires the C.10 control fanout as a
 * live refresh on the open project, and owns busy-state + single-toast
 * handling for row actions.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import {
  listScheduledTasks, parseTaskRunEvent, type ScheduledTaskView,
} from '../../lib/scheduled-tasks-api.ts';
import { subscribeControlEvents } from '../../lib/nnd/events.ts';
import {
  interpolateText,
  scheduleStatusLabel,
  useScheduledText,
  type ScheduledText,
} from './scheduledText.ts';

export interface TaskList {
  tasks: ScheduledTaskView[];
  loading: boolean;
  error: string | null;
  busyTaskId: string;
  busy: (id: string, work: () => Promise<unknown>) => Promise<void>;
  refresh: (id: string) => void;
}

/** Server errors keep their message; a missing store file is just "empty". */
async function loadTaskList(
  projectId: string,
): Promise<{ tasks: ScheduledTaskView[] } | { error: string }> {
  const outcome = await listScheduledTasks(projectId);
  if (outcome.ok) return { tasks: outcome.tasks };
  if (outcome.status === 404) {
    // The store is born on the first create; a project that never scheduled
    // anything answers the plain list 404 (E-09-23 a).
    return { tasks: [] };
  }
  return { error: outcome.error };
}

/** C.10 live refresh (one subscription per project, lifecycle-safe): a
 * task-ran event on the open project reloads the list; a late subscription
 * resolution after a switch/unmount only runs its close. */
function useTaskRanFanout(
  projectId: string,
  viewIdRef: RefObject<string>,
  refresh: (id: string) => void,
  text: ScheduledText,
): void {
  useEffect(() => {
    if (projectId === '') return;
    let cancelled = false;
    let dispose: (() => void) | null = null;
    void subscribeControlEvents((frame) => {
      const ran = parseTaskRunEvent(frame);
      if (ran === null || ran.projectId !== projectId) return;
      toast.message(interpolateText(text.ranToastTitle, {
        taskId: ran.taskId,
        status: scheduleStatusLabel(ran.status, text),
      }), { description: interpolateText(text.ranToastDescription, { projectId: ran.projectId }) });
      refresh(ran.projectId);
    }).then((close) => {
      if (cancelled) close();
      else dispose = close;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [projectId, refresh, text]);
}

export function useScheduledTaskList(projectId: string): TaskList {
  const text = useScheduledText();
  const [tasks, setTasks] = useState<ScheduledTaskView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState('');
  // The view-ownership boundary: only the project the LIST EFFECT last armed
  // may apply results. A delayed older load (fast project switch) or a frame
  // racing through a still-attached C.10 listener of a previous project
  // writes nothing into the current view (and must not flash `loading`).
  const viewIdRef = useRef('');

  const refresh = useCallback((id: string): void => {
    if (id.length === 0 || viewIdRef.current !== id) return;
    setLoading(true);
    void loadTaskList(id).then((result) => {
      if (viewIdRef.current !== id) return;
      if ('tasks' in result) {
        setTasks(result.tasks);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (viewIdRef.current !== projectId) {
      setTasks([]);
      setError(null);
      setBusyTaskId('');
    }
    viewIdRef.current = projectId;
    refresh(projectId);
  }, [projectId, refresh]);

  // C.10 live refresh: a task-ran event on this project reloads the list.
  useTaskRanFanout(projectId, viewIdRef, refresh, text);

  const busy = useCallback((id: string, work: () => Promise<unknown>): Promise<void> => {
    setBusyTaskId(id);
    return work().then((outcome) => {
      setBusyTaskId('');
      foldOutcome(outcome, text);
      refresh(projectId);
    }, (requestError: unknown) => {
      setBusyTaskId('');
      toast.error(String(requestError).slice(0, 160));
    });
  }, [projectId, refresh, text]);

  return { tasks, loading, error, busyTaskId, busy, refresh };
}

/** The wire fold puts `{ok:false,error}` on every refusal; surface it once.
 * `null`/`{ok:true}`/run bodies the worker already toasted are silent. */
function foldOutcome(outcome: unknown, text: ScheduledText): void {
  if (outcome !== null && typeof outcome === 'object' && (outcome as { ok?: unknown }).ok === false) {
    const message = (outcome as { error?: unknown }).error;
    toast.error(typeof message === 'string' ? message : text.changeRejected);
  }
}
