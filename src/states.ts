// The task states of the loop, read from board facts (and, for Proposed,
// from the triage cards). Nothing here is stored: every read classifies
// the board as it is.

import { WORKER_NAMES } from "./config";
import { parseTag } from "./loop";
import type { Task } from "./office";

// Nil, 2026-10-18: no "waiting for Nil" state. A task that needs him is a card
// in Triage (Proposed): a curator proposal or a worker's design packet.
export const STATES = [
  "filed",
  "proposed",
  "ready",
  "working",
  "merging",
  "never",
  "backlog",
  "done",
  "obsolete",
] as const;
export type StateKey = (typeof STATES)[number] | "other";

const LOOP_CLASSES = ["auto", "decide"];
const LOOP_PRIORITIES = ["P0", "P1", "P2", "P3"];

// First match wins, from the end of the path backwards, so a task never
// counts in two states. hasCard: a triage proposal or a packet that is not
// written to the board yet.
export function classify(t: Task, hasCard: boolean): StateKey {
  if (t.status === "done") return "done";
  if (t.status === "obsolete") return "obsolete";
  if (t.priority === "P4") return "backlog";
  const tag = parseTag(t.title);
  if (tag?.class === "authority") return "never";
  if (tag?.state === "merging") return "merging";
  if (t.status === "in_progress" && WORKER_NAMES.includes(t.assignee ?? "")) return "working";
  if (tag && LOOP_CLASSES.includes(tag.class) && tag.state === "nil") return hasCard ? "proposed" : "other";
  if (
    tag &&
    LOOP_CLASSES.includes(tag.class) &&
    tag.state === "ready" &&
    t.status === "open" &&
    !t.assignee &&
    LOOP_PRIORITIES.includes(t.priority ?? "")
  )
    return "ready";
  if (!tag && t.status === "open") return hasCard ? "proposed" : "filed";
  return "other";
}

export type Brief = { id: string; title: string; priority: string | null; assignee: string | null; closedAt?: number };
export type StateView = { count: number; tasks: Brief[] };

const RECENT = 20;

function brief(t: Task, closedAt?: number): Brief {
  return { id: t.id, title: t.title, priority: t.priority ?? null, assignee: t.assignee ?? null, closedAt };
}

const byQueue = (a: Task, b: Task) =>
  (a.priority ?? "P9").localeCompare(b.priority ?? "P9") || a.createdAt - b.createdAt;

// Done and Obsolete list the last RECENT by close time (unknown times last);
// every other state lists all its tasks in queue order.
export function stateViews(
  tasks: Task[],
  proposed: Set<string>,
  closedAt: (t: Task) => number | undefined,
): Record<StateKey, StateView> {
  const groups = {} as Record<StateKey, Task[]>;
  for (const k of [...STATES, "other" as const]) groups[k] = [];
  for (const t of tasks) groups[classify(t, proposed.has(t.id))].push(t);
  const out = {} as Record<StateKey, StateView>;
  for (const [k, list] of Object.entries(groups) as [StateKey, Task[]][]) {
    if (k === "done" || k === "obsolete") {
      const recent = list
        .map((t) => ({ t, at: closedAt(t) }))
        .sort((a, b) => (b.at ?? -1) - (a.at ?? -1) || b.t.createdAt - a.t.createdAt)
        .slice(0, RECENT);
      out[k] = { count: list.length, tasks: recent.map((x) => brief(x.t, x.at)) };
    } else {
      out[k] = { count: list.length, tasks: [...list].sort(byQueue).map((t) => brief(t)) };
    }
  }
  return out;
}
