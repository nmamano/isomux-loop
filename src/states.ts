// The task states of the loop, read from board facts (and, for Triage,
// from the app's cards). Nothing here is stored: every read classifies
// the board as it is.

import { WORKER_NAMES } from "./config";
import { parseTag } from "./loop";
import type { Task } from "./office";

// Nil, 2026-10-18: no "waiting for Nil" state. A task that needs him is a card
// in Triage: a curator proposal or a worker's design packet.
export const STATES = [
  "filed",
  "triage",
  "decided",
  "ready",
  "working",
  "merging",
  "signoff",
  "push",
  "hold",
  "backlog",
  "done",
  "obsolete",
] as const;
export type StateKey = (typeof STATES)[number] | "other";

// "auto" and "decide" are the old names of go and design (Nil, 2026-10-19).
const LOOP_CLASSES = ["go", "design", "auto", "decide"];
const LOOP_PRIORITIES = ["P0", "P1", "P2", "P3"];

// The task's card in the app: "open" waits for Nil in the Triage tab;
// "decided" waits for the curator to write Nil's decision to the board (the
// Decided tab).
export type Card = "open" | "decided" | null;

// First match wins, from the end of the path backwards, so a task never
// counts in two states. needsSignoff: the app holds a merged sign-off item
// for it that waits for Nil or waits for its revert (the board already says
// done). unpushed: Main reported its merge, and no push since.
export function classify(t: Task, card: Card, needsSignoff = false, unpushed = false): StateKey {
  // An open card is Triage and a decided one Decided whatever the board says,
  // so these states and their tabs count the same cards.
  if (card === "open") return "triage";
  if (card === "decided") return "decided";
  if (needsSignoff) return "signoff";
  if (unpushed && t.status === "done") return "push";
  if (t.status === "done") return "done";
  if (t.status === "obsolete") return "obsolete";
  if (t.priority === "P4") return "backlog";
  const tag = parseTag(t.title);
  // "authority" is the class's old name (2026-10-19).
  if (tag?.class === "hold" || tag?.class === "authority") return "hold";
  if (tag?.state === "merging") return "merging";
  if (t.status === "in_progress" && WORKER_NAMES.includes(t.assignee ?? "")) return "working";
  if (
    tag &&
    LOOP_CLASSES.includes(tag.class) &&
    tag.state === "ready" &&
    t.status === "open" &&
    !t.assignee &&
    LOOP_PRIORITIES.includes(t.priority ?? "")
  )
    return "ready";
  if (!tag && t.status === "open") return "filed";
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
  cards: Map<string, Card>,
  closedAt: (t: Task) => number | undefined,
  signoff: Set<string> = new Set(),
  unpushed: Set<string> = new Set(),
): Record<StateKey, StateView> {
  const groups = {} as Record<StateKey, Task[]>;
  for (const k of [...STATES, "other" as const]) groups[k] = [];
  for (const t of tasks) groups[classify(t, cards.get(t.id) ?? null, signoff.has(t.id), unpushed.has(t.id))].push(t);
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
