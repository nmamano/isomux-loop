// Dispatch and tick. The board is the loop's only state: every run reads it
// fresh and keeps nothing between runs.

import { MAIN_NAME, ROOM_ID, WORKER_NAMES } from "./config";
import type { Agent, Office, Task } from "./office";

const DISPATCH_CLASSES = ["auto", "decide"];
const LOOP_PRIORITIES = ["P0", "P1", "P2", "P3"];

export type Tag = { class: string; state: string; rest: string };

// `[auto | ready] Title` -> {class: "auto", state: "ready", rest: "Title"}
export function parseTag(title: string): Tag | null {
  const m = title.match(/^\[\s*([a-z]+)\s*\|\s*([^\]]*?)\s*\]\s*(.*)$/s);
  return m ? { class: m[1], state: m[2], rest: m[3] } : null;
}

function inRoom(t: Task): boolean {
  return t.roomId === undefined || t.roomId === ROOM_ID;
}

export function readyQueue(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => {
      const tag = parseTag(t.title);
      return (
        inRoom(t) &&
        t.status === "open" &&
        !t.assignee &&
        LOOP_PRIORITIES.includes(t.priority ?? "") &&
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

function heldBy(tasks: Task[], name: string): Task[] {
  return tasks
    .filter((t) => inRoom(t) && t.status === "in_progress" && t.assignee === name)
    .sort((a, b) => (a.priority ?? "").localeCompare(b.priority ?? "") || a.createdAt - b.createdAt);
}

export function holdings(agents: Agent[], tasks: Task[]): Holding[] {
  return workers(agents).flatMap((w) => heldBy(tasks, w.name).map((task) => ({ worker: w, task })));
}

// Only Workers 1..n take new tasks.
export function freeWorkers(agents: Agent[], tasks: Task[], n: number): Agent[] {
  return workers(agents, n).filter((w) => heldBy(tasks, w.name).length === 0);
}

export function withState(tasks: Task[], state: string): Task[] {
  return tasks.filter((t) => inRoom(t) && parseTag(t.title)?.state === state);
}

export type DispatchResult = {
  assigned: { worker: string; taskId: string; messaged: boolean }[];
  conflicts: string[];
  errors: string[];
};

export async function dispatch(office: Office, n: number): Promise<DispatchResult> {
  const out: DispatchResult = { assigned: [], conflicts: [], errors: [] };
  const [tasks, agents] = await Promise.all([office.tasks(), office.agents()]);
  const queue = readyQueue(tasks);
  for (const worker of freeWorkers(agents, tasks, n)) {
    while (queue.length > 0) {
      const task = queue.shift()!;
      const res = await office.patchTask(task.id, {
        version: task.version,
        assignee: worker.name,
        status: "in_progress",
      });
      if (!res.ok) {
        // 409: someone changed the task since our read; it is not ours to take.
        if (res.status === 409) out.conflicts.push(task.id);
        else out.errors.push(`PATCH ${task.id} answered ${res.status}`);
        continue;
      }
      const messaged = await office.message(`/isomux-loop-worker ${task.id}\n${task.title}`, worker.id);
      if (!messaged) out.errors.push(`message to ${worker.name} about ${task.id} failed; the tick retries it`);
      out.assigned.push({ worker: worker.name, taskId: task.id, messaged });
      break;
    }
  }
  return out;
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
    const held = heldBy(tasks, w.name).filter((t) => inLoop || DISPATCH_CLASSES.includes(parseTag(t.title)?.class ?? ""));
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
  ready: Task[];
  holding: { worker: string; task: Task }[];
  freeWorkers: string[];
  merging: Task[];
};

export function status(agents: Agent[], tasks: Task[], n: number): Status {
  return {
    ready: readyQueue(tasks),
    holding: holdings(agents, tasks).map((h) => ({ worker: h.worker.name, task: h.task })),
    freeWorkers: freeWorkers(agents, tasks, n).map((w) => w.name),
    merging: withState(tasks, "merging"),
  };
}

// Open tasks with no [<class> | <state>] tag and no card in the app (a
// proposal or packet not written to the board yet): the curator has not
// proposed them. P4 included; the curator proposes those too.
export function unclassified(tasks: Task[], cards: Set<string>): Task[] {
  return tasks
    .filter((t) => inRoom(t) && t.status === "open" && parseTag(t.title) === null && !cards.has(t.id))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// Undecided triage cards whose task closed (done or obsolete) or left the
// board: Nil should not triage them. A decided card stays: it is his.
export function staleCards(openCardIds: string[], tasks: Task[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return openCardIds.filter((id) => {
    const t = byId.get(id);
    return !t || t.status === "done" || t.status === "obsolete";
  });
}
