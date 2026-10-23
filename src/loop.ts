// Dispatch and tick. The board is the loop's only state: every run reads it
// fresh and keeps nothing between runs.

import { LOOP_PRIORITIES, MAIN_NAME, ROOM_ID, WORKER_NAMES } from "./config";
import type { Agent, Office, Task } from "./office";

// "auto" and "decide" are the old names of go and design (Nil, 2026-10-19);
// old tags still count.
const DISPATCH_CLASSES = ["go", "design", "auto", "decide"];

export type Tag = { class: string; state: string; rest: string };

// `[go | ready] Title` -> {class: "go", state: "ready", rest: "Title"}
export function parseTag(title: string): Tag | null {
  const m = title.match(/^\[\s*([a-z]+)\s*\|\s*([^\]]*?)\s*\]\s*(.*)$/s);
  return m ? { class: m[1], state: m[2], rest: m[3] } : null;
}

function inRoom(t: Task): boolean {
  return t.roomId === undefined || t.roomId === ROOM_ID;
}

// floor: the lowest priority dispatch takes ("P1": P0 and P1); null takes all.
export function readyQueue(tasks: Task[], floor: string | null = null): Task[] {
  const allowed = floor === null ? LOOP_PRIORITIES : LOOP_PRIORITIES.slice(0, LOOP_PRIORITIES.indexOf(floor) + 1);
  return tasks
    .filter((t) => {
      const tag = parseTag(t.title);
      return (
        inRoom(t) &&
        t.status === "open" &&
        !t.assignee &&
        allowed.includes(t.priority ?? "") &&
        tag !== null &&
        tag.state === "ready" &&
        DISPATCH_CLASSES.includes(tag.class)
      );
    })
    .sort((a, b) => (a.priority ?? "").localeCompare(b.priority ?? "") || a.createdAt - b.createdAt);
}

export type Holding = { worker: Agent; task: Task };

// Workers 1..n that exist; all of them when n is omitted.
function workers(agents: Agent[], n = WORKER_NAMES.length): Agent[] {
  return WORKER_NAMES.slice(0, n).map((name) => agents.find((a) => a.name === name)).filter(
    (a): a is Agent => a !== undefined,
  );
}

// Since isomux task 83f71be9 a task carries its holder's agent id: a new
// worker with a killed worker's name does not hold the killed one's task.
// A row with no id matches by name, as before.
export function holds(t: Task, worker: Agent): boolean {
  return t.assigneeAgentId ? t.assigneeAgentId === worker.id : t.assignee === worker.name;
}

function heldBy(tasks: Task[], worker: Agent): Task[] {
  return tasks
    .filter((t) => inRoom(t) && t.status === "in_progress" && holds(t, worker))
    .sort((a, b) => (a.priority ?? "").localeCompare(b.priority ?? "") || a.createdAt - b.createdAt);
}

export function holdings(agents: Agent[], tasks: Task[]): Holding[] {
  return workers(agents).flatMap((w) => heldBy(tasks, w).map((task) => ({ worker: w, task })));
}

// Only Workers 1..n take new tasks.
export function freeWorkers(agents: Agent[], tasks: Task[], n: number): Agent[] {
  return workers(agents, n).filter((w) => heldBy(tasks, w).length === 0);
}

export function withState(tasks: Task[], state: string): Task[] {
  return tasks.filter((t) => inRoom(t) && parseTag(t.title)?.state === state);
}

export type DispatchResult = {
  assigned: { worker: string; taskId: string; messaged: boolean }[];
  conflicts: string[];
  // Ready tasks the server refused because their holder is a killed agent.
  killed: string[];
  errors: string[];
};

// The task's age for the worker (Nil, 2026-10-20: an old task may be stale
// and need reinterpretation). Only a description edit counts as a change: a
// retag or a new priority leaves the text as old as it was.
const DAY_MS = 86_400_000;
function ago(at: number, now: number): string {
  const d = Math.floor((now - at) / DAY_MS);
  const date = new Date(at).toISOString().slice(0, 10);
  return (d < 1 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`) + ` (${date})`;
}
export function ageLine(createdAt: number, editedAt: number | null | undefined, now: number): string {
  const edit =
    editedAt === undefined ? "" : editedAt === null ? "; no description edit on record" : `; description last edited ${ago(editedAt, now)}`;
  return `Filed ${ago(createdAt, now)}${edit}.`;
}

export async function dispatch(office: Office, n: number, now = Date.now(), floor: string | null = null): Promise<DispatchResult> {
  const out: DispatchResult = { assigned: [], conflicts: [], killed: [], errors: [] };
  const [tasks, agents] = await Promise.all([office.tasks(), office.agents()]);
  const queue = readyQueue(tasks, floor);
  for (const worker of freeWorkers(agents, tasks, n)) {
    while (queue.length > 0) {
      const task = queue.shift()!;
      const res = await office.patchTask(task.id, {
        version: task.version,
        assignee: worker.name,
        status: "in_progress",
      });
      if (!res.ok) {
        // 409: someone changed the task since our read, or its holder is a
        // killed agent; either way it is not ours to take.
        if (res.status === 409 && res.killed) out.killed.push(task.id);
        else if (res.status === 409) out.conflicts.push(task.id);
        else out.errors.push(`PATCH ${task.id} answered ${res.status}`);
        continue;
      }
      // An unreadable history leaves the edit out, not the dispatch.
      const edited = await office.lastEdited(task.id).catch(() => undefined);
      const text = `/isomux-loop-worker ${task.id}\n${task.title}\n${ageLine(task.createdAt, edited, now)}`;
      const messaged = await office.message(text, worker.id);
      if (!messaged) out.errors.push(`message to ${worker.name} about ${task.id} failed; the tick retries it`);
      out.assigned.push({ worker: worker.name, taskId: task.id, messaged });
      break;
    }
  }
  return out;
}

// How long until a run that is due every everyMs, after the last one at
// lastAt (null: never ran). 0 when it is due now.
export function dueIn(lastAt: number | null, now: number, everyMs: number): number {
  return lastAt === null ? 0 : Math.max(0, lastAt + everyMs - now);
}

export type TickResult = { nudged: { worker: string; taskId: string }[]; main: number | null; errors: string[] };

export function workerTickText(taskId: string): string {
  return (
    `/isomux-loop-worker tick ${taskId}: if your work on it stopped short of its next hand-off, continue it. ` +
    "If you wait on your reviewer, check that it is working and nudge it if it stopped. Otherwise end the turn."
  );
}

// Workers 1..n get the nudge for any task they hold. A worker above n (after
// Nil lowered n) keeps it only while it holds a loop-tagged task, so it can
// finish; batch work outside the loop is untagged and gets no nudge.
export async function tick(office: Office, n: number): Promise<TickResult> {
  const out: TickResult = { nudged: [], main: null, errors: [] };
  const [tasks, agents] = await Promise.all([office.tasks(), office.agents()]);
  for (const w of workers(agents)) {
    const inLoop = WORKER_NAMES.indexOf(w.name) < n;
    const held = heldBy(tasks, w).filter((t) => inLoop || DISPATCH_CLASSES.includes(parseTag(t.title)?.class ?? ""));
    if (held.length === 0 || w.inFlightTurn) continue;
    if (await office.message(workerTickText(held[0].id), w.id))
      out.nudged.push({ worker: w.name, taskId: held[0].id });
    else out.errors.push(`tick message to ${w.name} failed`);
  }
  const merging = withState(tasks, "merging").length;
  const main = agents.find((a) => a.name === MAIN_NAME);
  if (merging > 0 && main && !main.inFlightTurn) {
    if (await office.message(`/isomux-main tick: ${merging} tasks wait to merge.`, main.id)) out.main = merging;
    else out.errors.push("tick message to Isomux Main failed");
  }
  return out;
}

export type Status = {
  // What dispatch takes: the ready tasks at the floor or higher.
  ready: Task[];
  // Ready tasks below the floor, which wait until it is lowered.
  belowFloor: number;
  holding: { worker: string; task: Task }[];
  freeWorkers: string[];
  merging: Task[];
};

export function status(agents: Agent[], tasks: Task[], n: number, floor: string | null = null): Status {
  const ready = readyQueue(tasks, floor);
  return {
    ready,
    belowFloor: readyQueue(tasks).length - ready.length,
    holding: holdings(agents, tasks).map((h) => ({ worker: h.worker.name, task: h.task })),
    freeWorkers: freeWorkers(agents, tasks, n).map((w) => w.name),
    merging: withState(tasks, "merging"),
  };
}

// Open tasks with no [<class> | <state>] tag and no card in the app (a
// proposal or packet not written to the board yet): the curator has not
// proposed them. P4 (backlog) is left out: it gets a card only when the
// curator proposes to promote it (Nil, 2026-10-19).
export function unclassified(tasks: Task[], cards: Set<string>): Task[] {
  return tasks
    .filter((t) => inRoom(t) && t.status === "open" && t.priority !== "P4" && parseTag(t.title) === null && !cards.has(t.id))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// Backlog tasks (P4, no card) the curator has not recommended and Nil has
// not kept: the curator wake asks for their recommendation (Isomux PM,
// 2026-10-23), so a new backlog task does not wait for a chance read.
export function unrecommended(backlog: Task[], hasRec: (id: string) => boolean, kept: (t: Task) => boolean): Task[] {
  return backlog.filter((t) => !hasRec(t.id) && !kept(t));
}

// The curator wake's one message; null when neither part has a task.
export function wakeText(found: string[], backlog: string[], api: string): string | null {
  if (!found.length && !backlog.length) return null;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (found.length)
    parts.push(
      `${n(found.length, "open task", "open tasks")} in the Isomux room ha${found.length === 1 ? "s" : "ve"} no tag and no card in the loop app; propose ${found.length === 1 ? "it" : "them"}: ${found.join(", ")}.`,
    );
  if (backlog.length)
    parts.push(
      `${n(backlog.length, "backlog (P4) task has", "backlog (P4) tasks have")} no recommendation; recommend ${backlog.length === 1 ? "it" : "them"} (POST /api/proposals with the P4 task as it is, any choice; it shows on the Backlog tab): ${backlog.join(", ")}.`,
    );
  return `/isomux-curator ${parts.join(" ")} API: curl -s ${api}/api/help`;
}

// The ids among taskIds that cannot carry a card, given every task of the
// room: gone (the room's list does not have it: another room, global or
// deleted) and closed (done or obsolete).
export function offBoard(taskIds: string[], tasks: Task[]): { gone: string[]; closed: string[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = { gone: [] as string[], closed: [] as string[] };
  for (const id of taskIds) {
    const t = byId.get(id);
    if (!t) out.gone.push(id);
    else if (t.status === "done" || t.status === "obsolete") out.closed.push(id);
  }
  return out;
}

// Undecided triage cards whose task closed (done or obsolete) or left the
// board: Nil should not triage them. A decided card stays: it is his.
export function staleCards(openCardIds: string[], tasks: Task[]): string[] {
  const { gone, closed } = offBoard(openCardIds, tasks);
  return openCardIds.filter((id) => gone.includes(id) || closed.includes(id));
}

// The log line for withdrawn cards, which tells the two causes apart.
export function withdrawLine(ids: string[], tasks: Task[]): string {
  const { gone, closed } = offBoard(ids, tasks);
  const parts: string[] = [];
  if (closed.length) parts.push(`closed (done or obsolete): ${closed.join(", ")}`);
  if (gone.length) parts.push(`gone from the room's task list: ${gone.join(", ")}`);
  return `withdrew cards; ${parts.join("; ")}`;
}

// Why POST /api/proposals refuses these tasks, or null when it takes them all.
// A card for a task outside the room is withdrawn at the next board read.
export function proposalRefusal(taskIds: string[], tasks: Task[], roomId: string): string | null {
  const { gone, closed } = offBoard(taskIds, tasks);
  const parts: string[] = [];
  if (gone.length)
    parts.push(`not in the loop's room (${roomId}): ${gone.join(", ")}. Move each task to the room (PATCH /api/tasks/<id> with its version and "roomId":"${roomId}") and propose again`);
  if (closed.length) parts.push(`closed (done or obsolete): ${closed.join(", ")}`);
  return parts.length ? `no proposals were taken; tasks ${parts.join("; tasks ")}` : null;
}
