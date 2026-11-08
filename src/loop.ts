// Dispatch and tick. The board is the loop's only state: every run reads it
// fresh and keeps nothing between runs.

import { DECIDER, LOOP_PRIORITIES, MAIN_NAME, ROOM_ID, WORKER_NAMES } from "./config";
import type { Agent, Office, Task } from "./office";
import type { Author } from "./returns";

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

// Smart dispatch (Nil, 2026-11-06, board task 168fe215): two tasks that
// change the same code area do not run at once. A task names its areas in
// one description line, "Areas: server/agent-manager, ui/chat" (paths or
// short names, comma-separated); the Curator writes it at triage, a worker
// may correct it. Two areas overlap when they are equal or one is a folder
// of the other. A task with no Areas line overlaps nothing.
export function areasOf(t: Task): string[] {
  const m = (t.description ?? "").match(/^[ \t]*areas:[ \t]*(.*)$/im);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((a) => a.trim().toLowerCase().replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean);
}

export function areasOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => x === y || x.startsWith(y + "/") || y.startsWith(x + "/")));
}

// The tasks a new task must not overlap: held (in progress) or merging.
function active(tasks: Task[]): Task[] {
  return tasks.filter((t) => inRoom(t) && (t.status === "in_progress" || parseTag(t.title)?.state === "merging"));
}

// The first of others that shares an area with t, or undefined.
export function blockerOf(t: Task, others: Task[]): Task | undefined {
  const mine = areasOf(t);
  if (!mine.length) return undefined;
  return others.find((x) => x.id !== t.id && areasOverlap(mine, areasOf(x)));
}

// The state dispatch gives a ready task that waits for an overlapping task,
// and takes back to ready when that task is no longer in progress.
const WAITS = /^waits for (\S+)$/;
export const waitsState = (id: string) => `waits for ${id}`;

export function retag(title: string, state: string): string {
  const t = parseTag(title)!;
  return `[${t.class} | ${state}] ${t.rest}`;
}

// Open loop tasks that dispatch set to wait, with the blocker they name.
export function areaWaits(tasks: Task[]): { task: Task; blocker: string }[] {
  return tasks.flatMap((t) => {
    const tag = parseTag(t.title);
    const m = tag && DISPATCH_CLASSES.includes(tag.class) ? tag.state.match(WAITS) : null;
    return m && inRoom(t) && t.status === "open" && !t.assignee ? [{ task: t, blocker: m[1] }] : [];
  });
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

// Only Workers 1..n take new tasks, and only those with no task in progress
// and no open ask for Nil (Nil, 2026-11-08, board task 1158cd7e: a worker
// that waits on him for one task must not take another of his tasks).
// waits: worker id -> its oldest open ask for Nil.
export function freeWorkers(agents: Agent[], tasks: Task[], n: number, waits: Map<string, string> = new Map()): Agent[] {
  return workers(agents, n).filter((w) => heldBy(tasks, w).length === 0 && !waits.has(w.id));
}

// Each of Workers 1..n with an open ask for Nil, by id, with that ask's id.
// An unreadable ask log leaves the worker out and names it in errors: the
// worker then counts as free, as before this rule.
export async function nilAsks(office: Pick<Office, "openAsks">, agents: Agent[], n: number, errors: string[] = []): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!office.openAsks) return out;
  for (const w of workers(agents, n)) {
    try {
      const ask = (await office.openAsks(w.id)).find((a) => a.members.includes(DECIDER));
      if (ask) out.set(w.id, ask.id);
    } catch (err) {
      errors.push(`open asks of ${w.name} unreadable (${err instanceof Error ? err.message : String(err)}); it counts as free`);
    }
  }
  return out;
}

export function withState(tasks: Task[], state: string): Task[] {
  return tasks.filter((t) => inRoom(t) && parseTag(t.title)?.state === state);
}

export type DispatchResult = {
  assigned: { worker: string; taskId: string; messaged: boolean }[];
  conflicts: string[];
  // Ready tasks the server refused because their holder is a killed agent.
  killed: string[];
  // Free workers left out because they were in a turn: a clear would cut it.
  inTurn: string[];
  // Ready tasks set to wait for an overlapping task, and waiting tasks set
  // back to ready (smart dispatch).
  waits?: { taskId: string; blocker: string }[];
  readied?: string[];
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

// The live agent a packet's author names (by id when the record has one), or
// undefined when that author is gone.
export function liveAuthor(author: Author | undefined, agents: Agent[]): Agent | undefined {
  if (!author || !WORKER_NAMES.includes(author.name)) return undefined;
  return agents.find((a) => (author.agentId ? a.id === author.agentId : a.name === author.name));
}

// Each worker starts its task in a fresh conversation: dispatch clears it
// first, and leaves out a worker in a turn or one whose clear failed, so no
// task lands on top of earlier work (Isomux PM, 2026-11-05). The next
// dispatch tries it again.
// returnTo: who wrote the task's design packet. Such a task goes back to its
// author, also a worker above n, and waits while the author holds another
// task; only a gone author lets another worker take it (task 8307e0fb).
export async function dispatch(
  office: Office,
  n: number,
  now = Date.now(),
  floor: string | null = null,
  returnTo: (taskId: string) => Author | undefined = () => undefined,
): Promise<DispatchResult> {
  const out: DispatchResult = { assigned: [], conflicts: [], killed: [], inTurn: [], waits: [], readied: [], errors: [] };
  const [tasks, agents] = await Promise.all([office.tasks(), office.agents()]);
  const running = active(tasks);

  // Smart dispatch: the state part of the tag says why a task waits, and
  // follows the board. A 409 means someone changed the task: the next run
  // reads it again.
  async function setState(t: Task, state: string): Promise<boolean> {
    const res = await office.patchTask(t.id, { version: t.version, title: retag(t.title, state) });
    if (!res.ok && res.status !== 409) out.errors.push(`PATCH ${t.id} (state ${state}) answered ${res.status}`);
    return res.ok;
  }
  for (const { task, blocker } of areaWaits(tasks)) {
    const b = blockerOf(task, running);
    if (!b) {
      if (await setState(task, "ready")) out.readied!.push(task.id);
    } else if (b.id !== blocker && (await setState(task, waitsState(b.id)))) out.waits!.push({ taskId: task.id, blocker: b.id });
  }
  const parked = new Set<string>();
  for (const t of readyQueue(tasks)) {
    const b = blockerOf(t, running);
    if (!b) continue;
    parked.add(t.id);
    if (await setState(t, waitsState(b.id))) out.waits!.push({ taskId: t.id, blocker: b.id });
  }
  const queue = readyQueue(tasks, floor).filter((t) => !parked.has(t.id));
  // Tasks this run gave out: a later task that overlaps one stays ready, and
  // the next run sets it to wait.
  const given: Task[] = [];
  const author = new Map(queue.map((t) => [t.id, liveAuthor(returnTo(t.id), agents)]));
  const busy = new Set(workers(agents).filter((w) => heldBy(tasks, w).length > 0).map((w) => w.id));

  // Clears the worker's conversation once per dispatch; true when it is clear.
  const cleared = new Map<string, boolean>();
  async function clear(worker: Agent): Promise<boolean> {
    const done = cleared.get(worker.id);
    if (done !== undefined) return done;
    let ok = false;
    if (worker.inFlightTurn || worker.pendingPrompt) out.inTurn.push(worker.name);
    else {
      const res = await office.newConversation(worker.id);
      ok = res.ok;
      if (!ok) out.errors.push(`new conversation for ${worker.name} answered ${res.status}; it gets no task until one succeeds`);
    }
    cleared.set(worker.id, ok);
    return ok;
  }

  // One claim; true when the worker got the task.
  async function claim(worker: Agent, task: Task): Promise<boolean> {
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
      return false;
    }
    busy.add(worker.id);
    given.push(task);
    // An unreadable history leaves the edit out, not the dispatch.
    const edited = await office.lastEdited(task.id).catch(() => undefined);
    const text = `/isomux-loop-worker ${task.id}\n${task.title}\n${ageLine(task.createdAt, edited, now)}`;
    const messaged = await office.message(text, worker.id);
    if (!messaged) out.errors.push(`message to ${worker.name} about ${task.id} failed; the tick retries it`);
    out.assigned.push({ worker: worker.name, taskId: task.id, messaged });
    return true;
  }

  // A free author takes its own task first, before any new one.
  for (const task of queue) {
    const w = author.get(task.id);
    if (w && !busy.has(w.id) && !blockerOf(task, given) && (await clear(w))) await claim(w, task);
  }
  // The rest go in queue order; a task whose author lives waits for it.
  const rest = queue.filter((t) => !author.get(t.id));
  const waits = rest.length ? await nilAsks(office, agents, n, out.errors) : new Map<string, string>();
  for (const worker of freeWorkers(agents, tasks, n, waits)) {
    if (busy.has(worker.id)) continue;
    if (rest.length === 0) break;
    if (!(await clear(worker))) continue;
    while (rest.length > 0) {
      const t = rest.shift()!;
      if (!blockerOf(t, given) && (await claim(worker, t))) break;
    }
  }
  return out;
}

// How long until a run that is due every everyMs, after the last one at
// lastAt (null: never ran). 0 when it is due now.
export function dueIn(lastAt: number | null, now: number, everyMs: number): number {
  return lastAt === null ? 0 : Math.max(0, lastAt + everyMs - now);
}

// push: the push point the tick woke Isomux Main for, or null.
// scout: the sign-off items the tick told the Scout about (batchAsks).
export type TickResult = { nudged: { worker: string; taskId: string }[]; main: number | null; push?: string | null; scout?: string[]; errors: string[] };

// The push point the tick wakes Isomux Main for (Isomux PM, 2026-11-01): Main
// pushes signed-off push points on its own at the tick (Nil, 2026-10-31), so
// the app wakes it when push.ok holds at a sha that is not on origin/main.
// Once per sha: woken is the last sha the tick woke Main for.
export function pushToWake(check: { ok: boolean; sha: string | null }, woken: string | null, onOrigin: (sha: string) => boolean): string | null {
  if (!check.ok || !check.sha || check.sha === woken || onOrigin(check.sha)) return null;
  return check.sha;
}

export function pushWakeText(sha: string): string {
  return (
    `/isomux-main tick: push point ${sha} is signed off and not on origin/main (GET /api/signoff push.ok). ` +
    "Push it as your skill's push step says; if merged server changes wait for a restart, push after it."
  );
}

export function workerTickText(taskId: string): string {
  return (
    `/isomux-loop-worker tick ${taskId}: if your work on it stopped short of its next hand-off, continue it. ` +
    "If you wait on your reviewer, check that it is working and nudge it if it stopped. Otherwise end the turn."
  );
}

// Workers 1..n get the nudge for any task they hold. A worker above n (after
// Nil lowered n) keeps it only while it holds a loop-tagged task, so it can
// finish; batch work outside the loop is untagged and gets no nudge.
// push: a push point to wake Isomux Main for (pushToWake). Main gets it even
// when busy, as a queued message, so the wake is not lost.
export async function tick(office: Office, n: number, push: string | null = null): Promise<TickResult> {
  const out: TickResult = { nudged: [], main: null, push: null, errors: [] };
  const [tasks, agents] = await Promise.all([office.tasks(), office.agents()]);
  for (const w of workers(agents)) {
    const inLoop = WORKER_NAMES.indexOf(w.name) < n;
    // A task in state nil waits only on Nil's ask: a tick there costs a turn
    // that only finds the ask still open (board task e76eb0c9, 2026-11-03).
    const held = heldBy(tasks, w).filter(
      (t) => (inLoop || DISPATCH_CLASSES.includes(parseTag(t.title)?.class ?? "")) && parseTag(t.title)?.state !== "nil",
    );
    if (held.length === 0 || w.inFlightTurn) continue;
    if (await office.message(workerTickText(held[0].id), w.id))
      out.nudged.push({ worker: w.name, taskId: held[0].id });
    else out.errors.push(`tick message to ${w.name} failed`);
  }
  const merging = withState(tasks, "merging").length;
  const main = agents.find((a) => a.name === MAIN_NAME);
  const toMerge = merging > 0 && main && !main.inFlightTurn;
  if (main && (toMerge || push)) {
    const text = [toMerge ? `/isomux-main tick: ${merging} tasks wait to merge.` : "", push ? pushWakeText(push) : ""].filter(Boolean).join("\n");
    if (await office.message(text, main.id)) {
      if (toMerge) out.main = merging;
      out.push = push;
    } else out.errors.push("tick message to Isomux Main failed");
  } else if (push) out.errors.push("Isomux Main is not in the office: no push wake");
  return out;
}

export type Status = {
  // What dispatch takes: the ready tasks at the floor or higher.
  ready: Task[];
  // Ready tasks that wait for their packet's author: task id -> worker name.
  returnTo: Record<string, string>;
  // Ready tasks below the floor, which wait until it is lowered.
  belowFloor: number;
  holding: { worker: string; task: Task }[];
  freeWorkers: string[];
  // Workers without a task that wait on Nil: they take no new task.
  waitsOnNil: { worker: string; ask: string }[];
  merging: Task[];
  // Tasks that wait for an overlapping task (smart dispatch): id, the
  // blocker, and the task's areas.
  areaWaits: { id: string; blocker: string; areas: string[] }[];
};

export function status(
  agents: Agent[],
  tasks: Task[],
  n: number,
  floor: string | null = null,
  returnTo: (taskId: string) => Author | undefined = () => undefined,
  waits: Map<string, string> = new Map(),
): Status {
  const ready = readyQueue(tasks, floor);
  const back = ready.flatMap((t) => {
    const w = liveAuthor(returnTo(t.id), agents);
    return w ? [[t.id, w.name] as const] : [];
  });
  return {
    ready,
    returnTo: Object.fromEntries(back),
    belowFloor: readyQueue(tasks).length - ready.length,
    holding: holdings(agents, tasks).map((h) => ({ worker: h.worker.name, task: h.task })),
    freeWorkers: freeWorkers(agents, tasks, n, waits).map((w) => w.name),
    waitsOnNil: workers(agents, n).flatMap((w) => (waits.has(w.id) && heldBy(tasks, w).length === 0 ? [{ worker: w.name, ask: waits.get(w.id)! }] : [])),
    merging: withState(tasks, "merging"),
    areaWaits: areaWaits(tasks).map(({ task, blocker }) => ({ id: task.id, blocker, areas: areasOf(task) })),
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
