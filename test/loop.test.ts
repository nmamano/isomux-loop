import { describe, expect, test } from "bun:test";
import { ageLine, dispatch, dueIn, freeWorkers, holdings, parseTag, readyQueue, staleCards, status, tick, unclassified, unrecommended, wakeText } from "../src/loop";
import type { Agent, Office, PatchResult, Task } from "../src/office";

const ROOM = "e6818e47";
const NOW = Date.UTC(2026, 9, 20, 12);
let seq = 0;
function task(over: Partial<Task> & { title: string }): Task {
  seq++;
  return { id: `t${seq}`, status: "open", priority: "P2", createdAt: seq, roomId: ROOM, version: `v${seq}`, ...over };
}
function agent(name: string, busy = false): Agent {
  return { id: `id-${name}`, name, roomId: ROOM, inFlightTurn: busy ? { startedAt: 1 } : null };
}

// An office stub that applies PATCHes to its task list, with optional 409s.
function stubOffice(tasks: Task[], agents: Agent[], conflict: string[] = [], edits: Record<string, number> = {}, brokenHistory = "", killed: string[] = []) {
  const messages: { text: string; to?: string }[] = [];
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const office: Office = {
    tasks: async () => tasks.map((t) => ({ ...t })),
    allTasks: async () => tasks.map((t) => ({ ...t })),
    task: async (id) => ({ ...tasks.find((t) => t.id === id)! }),
    createTask: async () => {
      throw new Error("not used");
    },
    closedAt: async () => null,
    lastEdited: async (id) => {
      if (id === brokenHistory) throw new Error("GET /history answered 500");
      return edits[id] ?? null;
    },
    agents: async () => agents,
    async patchTask(id, body): Promise<PatchResult> {
      patches.push({ id, body });
      if (conflict.includes(id)) return { ok: false, status: 409 };
      if (killed.includes(id)) return { ok: false, status: 409, killed: true };
      const t = tasks.find((x) => x.id === id)!;
      if (body.version !== t.version) return { ok: false, status: 409 };
      Object.assign(t, { assignee: body.assignee, status: body.status, version: t.version + "+" });
      return { ok: true, task: t };
    },
    async message(text, to) {
      messages.push({ text, to });
      return true;
    },
  };
  return { office, messages, patches };
}

describe("tags", () => {
  test("parse class, state and the rest of the title", () => {
    expect(parseTag("[go | ready] Fix it")).toEqual({ class: "go", state: "ready", rest: "Fix it" });
    expect(parseTag("[decide|soak until 10-25] X")).toEqual({ class: "decide", state: "soak until 10-25", rest: "X" });
    expect(parseTag("Fix it")).toBeNull();
  });
});

describe("due in", () => {
  test("a run is due everyMs after the last one, at once when that is past or it never ran", () => {
    expect(dueIn(null, 5_000, 3_600_000)).toBe(0);
    expect(dueIn(1_000, 1_000 + 600_000, 3_600_000)).toBe(3_000_000);
    expect(dueIn(1_000, 1_000 + 3_600_000, 3_600_000)).toBe(0);
    expect(dueIn(1_000, 1_000 + 9_000_000, 3_600_000)).toBe(0);
  });
});

describe("ready queue", () => {
  test("only open, unassigned P0-P3 tasks tagged ready in a dispatch class, by priority then age", () => {
    const tasks = [
      task({ title: "[go | ready] p2 old", priority: "P2" }),
      task({ title: "[go | ready] p1 newer", priority: "P1" }),
      task({ title: "[auto | ready] p3 old name", priority: "P3" }),
      task({ title: "[taste | ready] no taste class any more", priority: "P0" }),
      task({ title: "[decide | ready] p1 newest", priority: "P1" }),
      task({ title: "[design | ready] p0 design", priority: "P0" }),
      task({ title: "[go | ready] p4", priority: "P4" }),
      task({ title: "[go | nil] parked", priority: "P0" }),
      task({ title: "[hold | ready] on hold", priority: "P0" }),
      task({ title: "[go | ready] taken", priority: "P0", assignee: "Isomux Worker 1" }),
      task({ title: "[go | ready] in progress", priority: "P0", status: "in_progress" }),
      task({ title: "untagged", priority: "P0" }),
      task({ title: "[go | ready] other room", priority: "P0", roomId: "other" }),
      task({ title: "[go | ready] no priority", priority: null }),
    ];
    expect(readyQueue(tasks).map((t) => t.title)).toEqual([
      "[design | ready] p0 design",
      "[go | ready] p1 newer",
      "[decide | ready] p1 newest",
      "[go | ready] p2 old",
      "[auto | ready] p3 old name",
    ]);
  });
});

describe("dispatch", () => {
  test("each free worker gets the next ready task, claimed with the read version, and a message", async () => {
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const b = task({ title: "[go | ready] B", priority: "P2" });
    const c = task({ title: "[go | ready] C", priority: "P3" });
    const agents = [agent("Isomux Worker 1"), agent("Isomux Worker 2"), agent("Isomux Reviewer 1")];
    const { office, messages, patches } = stubOffice([a, b, c], agents);
    const res = await dispatch(office, 2, NOW);
    expect(res.assigned).toEqual([
      { worker: "Isomux Worker 1", taskId: a.id, messaged: true },
      { worker: "Isomux Worker 2", taskId: b.id, messaged: true },
    ]);
    expect(patches[0]).toEqual({ id: a.id, body: { version: "v" + a.id.slice(1), assignee: "Isomux Worker 1", status: "in_progress" } });
    expect(messages).toEqual([
      { text: `/isomux-loop-worker ${a.id}\n${a.title}\n${ageLine(a.createdAt, null, NOW)}`, to: "id-Isomux Worker 1" },
      { text: `/isomux-loop-worker ${b.id}\n${b.title}\n${ageLine(b.createdAt, null, NOW)}`, to: "id-Isomux Worker 2" },
    ]);
    expect(c.assignee).toBeUndefined();
  });

  test("the message gives the task's age and its last description edit; a failed history read leaves the edit out", async () => {
    const day = 86_400_000;
    const a = task({ title: "[go | ready] A", priority: "P1", createdAt: NOW - 50 * day });
    const b = task({ title: "[go | ready] B", priority: "P2", createdAt: NOW - 1000 });
    const { office, messages } = stubOffice([a, b], [agent("Isomux Worker 1"), agent("Isomux Worker 2")], [], { [a.id]: NOW - 3 * day - 1000 }, b.id);
    await dispatch(office, 2, NOW);
    expect(messages.map((m) => m.text.split("\n")[2])).toEqual([
      "Filed 50 days ago (2026-08-31); description last edited 3 days ago (2026-10-17).",
      "Filed today (2026-10-20).",
    ]);
    expect(ageLine(NOW - day - 1, null, NOW)).toBe("Filed 1 day ago (2026-10-19); no description edit on record.");
  });

  test("a worker that holds a task, and a worker outside the loop's names, get nothing", async () => {
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const held = task({ title: "[go | ready] held", status: "in_progress", assignee: "Isomux Worker 2" });
    const agents = [agent("Isomux Worker 2"), agent("Isomux Worker 3")];
    const { office, messages } = stubOffice([a, held], agents);
    expect((await dispatch(office, 2)).assigned).toEqual([]);
    expect(messages).toEqual([]);
  });

  test("a 409 skips the task and the worker takes the next one", async () => {
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const b = task({ title: "[go | ready] B", priority: "P2" });
    const { office, messages } = stubOffice([a, b], [agent("Isomux Worker 1")], [a.id]);
    const res = await dispatch(office, 2);
    expect(res.conflicts).toEqual([a.id]);
    expect(res.assigned.map((x) => x.taskId)).toEqual([b.id]);
    expect(messages.map((m) => m.text.split("\n")[0])).toEqual([`/isomux-loop-worker ${b.id}`]);
  });

  test("a new worker with a killed worker's name does not hold its task: it counts as free and gets no tick for it", async () => {
    const w1 = agent("Isomux Worker 1");
    const dead = task({ title: "[go | ready] dead", status: "in_progress", assignee: "Isomux Worker 1", assigneeAgentId: "killed-id" });
    expect(holdings([w1], [dead])).toEqual([]);
    expect(freeWorkers([w1], [dead], 2).map((a) => a.name)).toEqual(["Isomux Worker 1"]);
    const { office, messages } = stubOffice([dead], [w1]);
    expect((await tick(office, 2)).nudged).toEqual([]);
    expect(messages).toEqual([]);
    // Its own id, or no id at all (an older row), still holds it.
    for (const t of [{ ...dead, assigneeAgentId: w1.id }, { ...dead, assigneeAgentId: undefined }])
      expect(freeWorkers([w1], [t], 2)).toEqual([]);
  });

  test("a 409 for a killed holder is reported as such, not as a conflict, and the worker takes the next task", async () => {
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const b = task({ title: "[go | ready] B", priority: "P2" });
    const { office } = stubOffice([a, b], [agent("Isomux Worker 1")], [], {}, "", [a.id]);
    const res = await dispatch(office, 2, NOW);
    expect([res.killed, res.conflicts, res.assigned.map((x) => x.taskId)]).toEqual([[a.id], [], [b.id]]);
  });

  test("a worker missing from the agent list gets nothing", async () => {
    const a = task({ title: "[go | ready] A" });
    const { office, messages } = stubOffice([a], [agent("Isomux Worker 7"), agent("Some Worker 1")]);
    expect((await dispatch(office, 2)).assigned).toEqual([]);
    expect(messages).toEqual([]);
  });

  test("a merging task (in progress, no assignee) does not hold its worker", () => {
    const merging = task({ title: "[go | merging] M", status: "in_progress" });
    expect(freeWorkers([agent("Isomux Worker 1")], [merging], 2).map((a) => a.name)).toEqual(["Isomux Worker 1"]);
  });
});

describe("worker count", () => {
  test("only Workers 1..n take new tasks", async () => {
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const b = task({ title: "[go | ready] B", priority: "P2" });
    const { office } = stubOffice([a, b], [agent("Isomux Worker 1"), agent("Isomux Worker 2")]);
    expect((await dispatch(office, 1)).assigned.map((x) => x.worker)).toEqual(["Isomux Worker 1"]);
    expect(b.assignee).toBeUndefined();
  });

  test("after lowering n, a worker above it keeps its tick while it holds a loop task; batch work gets none", async () => {
    const loopTask = task({ title: "[go | ready] loop", status: "in_progress", assignee: "Isomux Worker 2" });
    const batchTask = task({ title: "Batch task", status: "in_progress", assignee: "Isomux Worker 3" });
    const inLoopBatch = task({ title: "Batch task in the loop range", status: "in_progress", assignee: "Isomux Worker 1" });
    const agents = [agent("Isomux Worker 1"), agent("Isomux Worker 2"), agent("Isomux Worker 3")];
    const { office, messages } = stubOffice([loopTask, batchTask, inLoopBatch], agents);
    const res = await tick(office, 1);
    expect(res.nudged.map((x) => x.worker)).toEqual(["Isomux Worker 1", "Isomux Worker 2"]);
    expect(messages.some((m) => m.to === "id-Isomux Worker 3")).toBe(false);
  });
});

describe("tick", () => {
  test("nudges idle workers that hold a task and Isomux Main when tasks wait to merge", async () => {
    const t1 = task({ title: "[go | ready] one", status: "in_progress", assignee: "Isomux Worker 1" });
    const t2 = task({ title: "[go | ready] two", status: "in_progress", assignee: "Isomux Worker 2" });
    const m = task({ title: "[go | merging] three", status: "in_progress" });
    const agents = [agent("Isomux Worker 1"), agent("Isomux Worker 2", true), agent("Isomux Worker 3"), agent("Isomux Main")];
    const { office, messages } = stubOffice([t1, t2, m], agents);
    const res = await tick(office, 2);
    expect(res.nudged).toEqual([{ worker: "Isomux Worker 1", taskId: t1.id }]);
    expect(res.main).toBe(1);
    expect(messages.map((x) => x.to)).toEqual(["id-Isomux Worker 1", "id-Isomux Main"]);
    expect(messages[0].text.startsWith(`/isomux-loop-worker tick ${t1.id}:`)).toBe(true);
    expect(messages[1].text).toBe("/isomux-main tick: 1 tasks wait to merge.");
  });

  test("skips Isomux Main when it is busy or absent", async () => {
    const m = task({ title: "[go | merging] three", status: "in_progress" });
    for (const agents of [[agent("Isomux Main", true)], []]) {
      const { office, messages } = stubOffice([m], agents);
      expect((await tick(office, 2)).main).toBeNull();
      expect(messages).toEqual([]);
    }
  });
});

describe("status", () => {
  test("ready queue, holders, free workers and merging", () => {
    const r = task({ title: "[go | ready] r" });
    const h = task({ title: "[go | ready] h", status: "in_progress", assignee: "Isomux Worker 1" });
    const m = task({ title: "[go | merging] m", status: "in_progress" });
    const p = task({ title: "[decide | nil] p" });
    const s = status([agent("Isomux Worker 1"), agent("Isomux Worker 2")], [r, h, m, p], 2);
    expect(s.ready.map((t) => t.id)).toEqual([r.id]);
    expect(s.holding.map((x) => [x.worker, x.task.id])).toEqual([["Isomux Worker 1", h.id]]);
    expect(s.freeWorkers).toEqual(["Isomux Worker 2"]);
    expect(s.merging.map((t) => t.id)).toEqual([m.id]);
  });
});

describe("curator wake", () => {
  test("open, untagged P0-P3 tasks without a card, oldest first; P4 left out", () => {
    const a = task({ title: "new idea" });
    const b = task({ title: "backlog idea", priority: "P4" });
    const tasks = [
      b,
      a,
      task({ title: "[go | ready] tagged" }),
      task({ title: "has a card" }),
      task({ title: "batch work", status: "in_progress", assignee: "Isomux Worker 3" }),
      task({ title: "closed", status: "done" }),
      task({ title: "elsewhere", roomId: "other" }),
    ];
    const card = tasks[3].id;
    expect(unclassified(tasks, new Set([card])).map((t) => t.title)).toEqual([a.title]);
  });
});

describe("curator wake", () => {
  test("backlog tasks with no recommendation and not kept are asked for one", () => {
    const [rec, kept, fresh] = [task({ title: "r", priority: "P4" }), task({ title: "k", priority: "P4" }), task({ title: "f", priority: "P4" })];
    expect(unrecommended([rec, kept, fresh], (id) => id === rec.id, (t) => t.id === kept.id).map((t) => t.title)).toEqual(["f"]);
  });

  test("one message per run: the propose part, the recommend part, or both; none when both are empty", () => {
    const api = "http://127.0.0.1:1";
    expect(wakeText([], [], api)).toBeNull();
    const both = wakeText(["a1", "a2"], ["b1"], api)!;
    expect(both.startsWith("/isomux-curator ")).toBe(true);
    // Each part names its ids, propose before recommend, and the API help ends it.
    const propose = both.indexOf("propose");
    const recommend = both.indexOf("recommend");
    expect(propose).toBeGreaterThan(0);
    expect(recommend).toBeGreaterThan(propose);
    expect(both.slice(propose, recommend)).toContain("a1, a2");
    expect(both.slice(recommend)).toContain("b1");
    expect(both.endsWith(`${api}/api/help`)).toBe(true);
    const only = wakeText([], ["b1", "b2"], api)!;
    expect([only.includes("propose"), only.includes("b1, b2")]).toEqual([false, true]);
    expect(wakeText(["a1"], [], api)!.includes("recommend")).toBe(false);
  });
});

describe("stale cards", () => {
  test("cards whose task is done, obsolete or gone; open and in-progress tasks keep theirs", () => {
    const open = task({ title: "a" });
    const done = task({ title: "b", status: "done" });
    const obsolete = task({ title: "c", status: "obsolete" });
    const working = task({ title: "d", status: "in_progress" });
    const ids = [open.id, done.id, obsolete.id, working.id, "gone1"];
    expect(staleCards(ids, [open, done, obsolete, working])).toEqual([done.id, obsolete.id, "gone1"]);
  });
});
