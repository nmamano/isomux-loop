import { describe, expect, test } from "bun:test";
import { ageLine, areasOf, areasOverlap, dispatch, dueIn, freeWorkers, holdings, nilAsks, siteToWake, parseTag, proposalRefusal, pushToWake, readyQueue, staleCards, status, tick, unclassified, unrecommended, wakeText, withdrawLine } from "../src/loop";
import type { Agent, Office, PatchResult, Task } from "../src/office";
import type { Author } from "../src/returns";

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
  // Every clear, claim and message in order; clearStatus makes a clear fail.
  const calls: string[] = [];
  const clearStatus: Record<string, number> = {};
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
    lastAssignee: async () => null,
    agents: async () => agents,
    async patchTask(id, body): Promise<PatchResult> {
      patches.push({ id, body });
      if (body.title !== undefined) {
        calls.push(`retitle ${id}`);
        const t = tasks.find((x) => x.id === id)!;
        if (conflict.includes(id) || body.version !== t.version) return { ok: false, status: 409 };
        Object.assign(t, { title: body.title, version: t.version + "+" });
        return { ok: true, task: t };
      }
      calls.push(`claim ${id} ${String(body.assignee)}`);
      if (conflict.includes(id)) return { ok: false, status: 409 };
      if (killed.includes(id)) return { ok: false, status: 409, killed: true };
      const t = tasks.find((x) => x.id === id)!;
      if (body.version !== t.version) return { ok: false, status: 409 };
      Object.assign(t, { assignee: body.assignee, status: body.status, version: t.version + "+" });
      return { ok: true, task: t };
    },
    async message(text, to) {
      messages.push({ text, to });
      calls.push(`message ${to}`);
      return true;
    },
    async newConversation(id) {
      calls.push(`clear ${id}`);
      const status = clearStatus[id] ?? 204;
      return { ok: status === 204, status };
    },
  };
  return { office, messages, patches, calls, clearStatus };
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

describe("priority floor", () => {
  test("dispatch takes only ready tasks at the floor or higher; status counts the rest; no floor takes all", async () => {
    const p0 = task({ title: "[go | ready] p0", priority: "P0" });
    const p1 = task({ title: "[go | ready] p1", priority: "P1" });
    const p2 = task({ title: "[go | ready] p2", priority: "P2" });
    const p3 = task({ title: "[go | ready] p3", priority: "P3" });
    const all = [p3, p2, p1, p0];
    expect(readyQueue(all, "P1").map((t) => t.id)).toEqual([p0.id, p1.id]);
    expect(readyQueue(all, "P0").map((t) => t.id)).toEqual([p0.id]);
    expect(readyQueue(all, null).map((t) => t.id)).toEqual([p0.id, p1.id, p2.id, p3.id]);
    const st = status([], all, 2, "P1");
    expect([st.ready.map((t) => t.id), st.belowFloor]).toEqual([[p0.id, p1.id], 2]);
    expect(status([], all, 2).belowFloor).toBe(0);

    // Three free workers, floor P1: two take P0 and P1, the third gets nothing.
    const agents = [agent("Isomux Worker 1"), agent("Isomux Worker 2"), agent("Isomux Worker 3")];
    const { office, messages } = stubOffice(all, agents);
    const res = await dispatch(office, 3, NOW, "P1");
    expect(res.assigned.map((x) => [x.worker, x.taskId])).toEqual([
      ["Isomux Worker 1", p0.id],
      ["Isomux Worker 2", p1.id],
    ]);
    expect(messages).toHaveLength(2);
    expect([p2.assignee, p3.assignee]).toEqual([undefined, undefined]);
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

  test("each worker's conversation is cleared once, before its claim and its message; with no ready task, nobody is cleared", async () => {
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const b = task({ title: "[go | ready] B", priority: "P2" });
    const c = task({ title: "[go | ready] C", priority: "P3" });
    const { office, calls } = stubOffice([a, b, c], [agent("Isomux Worker 1"), agent("Isomux Worker 2")], [a.id]);
    await dispatch(office, 2, NOW);
    // Worker 1 loses A to a 409 and takes B without a second clear.
    expect(calls).toEqual([
      "clear id-Isomux Worker 1",
      `claim ${a.id} Isomux Worker 1`,
      `claim ${b.id} Isomux Worker 1`,
      "message id-Isomux Worker 1",
      "clear id-Isomux Worker 2",
      `claim ${c.id} Isomux Worker 2`,
      "message id-Isomux Worker 2",
    ]);
    const idle = stubOffice([task({ title: "[design | nil] D" })], [agent("Isomux Worker 1")]);
    await dispatch(idle.office, 2, NOW);
    expect(idle.calls).toEqual([]);
  });

  test("a free worker in a turn or on a pending prompt is not cleared and gets no task; the next free worker takes it", async () => {
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const prompted = { ...agent("Isomux Worker 2"), pendingPrompt: "permission" };
    const { office, calls } = stubOffice([a], [agent("Isomux Worker 1", true), prompted, agent("Isomux Worker 3")]);
    const res = await dispatch(office, 3, NOW);
    expect(res.inTurn).toEqual(["Isomux Worker 1", "Isomux Worker 2"]);
    expect(calls).toEqual(["clear id-Isomux Worker 3", `claim ${a.id} Isomux Worker 3`, "message id-Isomux Worker 3"]);
  });

  test("a failed clear leaves the worker without a task, reports the status, and the next worker takes it", async () => {
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const { office, calls, clearStatus } = stubOffice([a], [agent("Isomux Worker 1"), agent("Isomux Worker 2")]);
    clearStatus["id-Isomux Worker 1"] = 403;
    const res = await dispatch(office, 2, NOW);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain("Isomux Worker 1");
    expect(res.errors[0]).toContain("403");
    expect(res.assigned).toEqual([{ worker: "Isomux Worker 2", taskId: a.id, messaged: true }]);
    expect(calls).toEqual(["clear id-Isomux Worker 1", "clear id-Isomux Worker 2", `claim ${a.id} Isomux Worker 2`, "message id-Isomux Worker 2"]);
  });

  test("a task back to its author: the author is cleared first; an author in a turn keeps it waiting", async () => {
    const own = task({ title: "[go | ready] own", priority: "P1" });
    const back = (id: string) => (id === own.id ? { name: "Isomux Worker 1" } : undefined);
    const free = stubOffice([own], [agent("Isomux Worker 1"), agent("Isomux Worker 2")]);
    await dispatch(free.office, 2, NOW, null, back);
    expect(free.calls).toEqual(["clear id-Isomux Worker 1", `claim ${own.id} Isomux Worker 1`, "message id-Isomux Worker 1"]);
    const again = task({ title: "[go | ready] own", priority: "P1" });
    const turn = stubOffice([again], [agent("Isomux Worker 1", true), agent("Isomux Worker 2")]);
    const res = await dispatch(turn.office, 2, NOW, null, (id) => (id === again.id ? { name: "Isomux Worker 1" } : undefined));
    expect([res.inTurn, turn.calls]).toEqual([["Isomux Worker 1"], []]);
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

  // Board task 1158cd7e (Nil, 2026-11-08): Worker 1 waited on Nil for one of
  // his tasks and still got the next one, so both ran through one agent.
  test("a worker with an open ask for Nil gets no new task; the next free worker in order takes it", async () => {
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const b = task({ title: "[go | ready] B", priority: "P2" });
    const w = [1, 2, 3].map((k) => agent(`Isomux Worker ${k}`));
    const { office, calls } = stubOffice([a, b], w);
    const asks: Record<string, { id: string; members: string[] }[]> = {
      [w[0].id]: [{ id: "ask1", members: ["Nil"] }],
      [w[1].id]: [{ id: "ask2", members: ["Someone Else"] }],
    };
    office.openAsks = async (id) => asks[id] ?? [];
    const res = await dispatch(office, 3, NOW);
    expect(res.assigned.map((x) => [x.worker, x.taskId])).toEqual([["Isomux Worker 2", a.id], ["Isomux Worker 3", b.id]]);
    expect(calls.some((c) => c.includes(w[0].id))).toBe(false);
    // Once Nil answers, the worker is free again.
    expect(freeWorkers(w, [], 3, await nilAsks(office, w, 3)).map((x) => x.name)).toEqual(["Isomux Worker 2", "Isomux Worker 3"]);
    asks[w[0].id] = [];
    expect(freeWorkers(w, [], 3, await nilAsks(office, w, 3)).map((x) => x.name)).toEqual(w.map((x) => x.name));
  });

  // Board task 1612d805 (2026-11-10): the pitch video was tagged with Worker 1
  // and had no assignee, so dispatch gave Worker 1 two other tasks.
  test("a task tagged with a worker, or assigned to it while open, keeps it busy; the status page names it", async () => {
    const w = [1, 2, 3].map((k) => agent(`Isomux Worker ${k}`));
    const video = task({ title: "[go | with Isomux Worker 1] Video" });
    const mails = task({ title: "[design | ready] Mails", assignee: "Isomux Worker 2" });
    const other = task({ title: "[go | with Isomux Worker 3] Old", status: "done" });
    const a = task({ title: "[go | ready] A", priority: "P1" });
    const { office } = stubOffice([video, mails, other, a], w);
    const res = await dispatch(office, 3, NOW);
    expect(res.assigned.map((x) => [x.worker, x.taskId])).toEqual([["Isomux Worker 3", a.id]]);
    const s = status(w, [video, mails, other], 3);
    expect([s.freeWorkers, s.heldOutside, s.holding]).toEqual([["Isomux Worker 3"], [{ worker: "Isomux Worker 1", task: video.id }, { worker: "Isomux Worker 2", task: mails.id }], []]);
    // The tick leaves a task held outside the loop alone.
    const t = stubOffice([video, mails], w);
    expect((await tick(t.office, 3)).nudged).toEqual([]);
  });

  test("an unreadable ask log is reported, and the worker counts as free", async () => {
    const w1 = agent("Isomux Worker 1");
    const errors: string[] = [];
    const waits = await nilAsks({ openAsks: async () => { throw new Error("GET answered 500"); } }, [w1], 2, errors);
    expect([waits.size, errors.length]).toEqual([0, 1]);
    expect(errors[0]).toContain("Isomux Worker 1");
  });

  test("a merging task (in progress, no assignee) does not hold its worker", () => {
    const merging = task({ title: "[go | merging] M", status: "in_progress" });
    expect(freeWorkers([agent("Isomux Worker 1")], [merging], 2).map((a) => a.name)).toEqual(["Isomux Worker 1"]);
  });
});

describe("back to the packet's author", () => {
  const w = (n: number) => agent(`Isomux Worker ${n}`);
  const by = (map: Record<string, Author>) => (id: string) => map[id];

  test("a free author gets its task back, before a new task and also above n; the others take the rest in order", async () => {
    const fresh = task({ title: "[go | ready] fresh", priority: "P0" });
    const own3 = task({ title: "[go | ready] own3", priority: "P3" });
    const own1 = task({ title: "[design | ready] own1", priority: "P3" });
    const next = task({ title: "[go | ready] next", priority: "P1" });
    const { office, messages } = stubOffice([fresh, own3, own1, next], [w(1), w(2), w(3)]);
    const res = await dispatch(office, 2, NOW, null, by({ [own3.id]: { name: "Isomux Worker 3", agentId: "id-Isomux Worker 3" }, [own1.id]: { name: "Isomux Worker 1" } }));
    expect(res.assigned.map((x) => [x.worker, x.taskId])).toEqual([
      ["Isomux Worker 3", own3.id],
      ["Isomux Worker 1", own1.id],
      ["Isomux Worker 2", fresh.id],
    ]);
    expect(messages.map((m) => [m.to, m.text.split("\n")[0]])).toContainEqual(["id-Isomux Worker 3", `/isomux-loop-worker ${own3.id}`]);
    expect(next.assignee).toBeUndefined();
  });

  test("a busy author's task waits for it; no other worker takes it", async () => {
    const held = task({ title: "[go | ready] held", status: "in_progress", assignee: "Isomux Worker 1" });
    const own = task({ title: "[go | ready] own", priority: "P0" });
    const other = task({ title: "[go | ready] other", priority: "P2" });
    const returnTo = by({ [own.id]: { name: "Isomux Worker 1" } });
    const { office } = stubOffice([held, own, other], [w(1), w(2)]);
    const res = await dispatch(office, 2, NOW, null, returnTo);
    expect(res.assigned.map((x) => [x.worker, x.taskId])).toEqual([["Isomux Worker 2", other.id]]);
    expect(own.assignee).toBeUndefined();
    expect(status([w(1), w(2)], [held, own], 2, null, returnTo).returnTo).toEqual({ [own.id]: "Isomux Worker 1" });
    // A task tagged with the author outside the loop keeps it busy too (board task 1612d805).
    const video = task({ title: "[go | with Isomux Worker 1] video" });
    const own2 = task({ title: "[go | ready] own2", priority: "P0" });
    const t = stubOffice([video, own2], [w(1), w(2)]);
    expect((await dispatch(t.office, 2, NOW, null, by({ [own2.id]: { name: "Isomux Worker 1" } }))).assigned).toEqual([]);
  });

  test("a gone author (no live agent with its id, or not a loop worker) lets any free worker take the task", async () => {
    const replaced = task({ title: "[go | ready] replaced", priority: "P1" });
    const outsider = task({ title: "[go | ready] outsider", priority: "P2" });
    const returnTo = by({ [replaced.id]: { name: "Isomux Worker 1", agentId: "killed-id" }, [outsider.id]: { name: "Isomux PM" } });
    const agents = [w(1), w(2), agent("Isomux PM")];
    expect(status(agents, [replaced, outsider], 2, null, returnTo).returnTo).toEqual({});
    const { office } = stubOffice([replaced, outsider], agents);
    const res = await dispatch(office, 2, NOW, null, returnTo);
    expect(res.assigned.map((x) => [x.worker, x.taskId])).toEqual([
      ["Isomux Worker 1", replaced.id],
      ["Isomux Worker 2", outsider.id],
    ]);
  });

  test("a 409 on the author's own task leaves the author free to take a new one", async () => {
    const own = task({ title: "[go | ready] own", priority: "P0" });
    const other = task({ title: "[go | ready] other", priority: "P2" });
    const { office } = stubOffice([own, other], [w(1)], [own.id]);
    const res = await dispatch(office, 2, NOW, null, by({ [own.id]: { name: "Isomux Worker 1" } }));
    expect([res.conflicts, res.assigned.map((x) => [x.worker, x.taskId])]).toEqual([[own.id], [["Isomux Worker 1", other.id]]]);
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

describe("smart dispatch", () => {
  const areas = (a: string) => `Some text.\nAreas: ${a}\n`;

  test("areas: one description line, comma-separated; equal or folder-of overlaps", () => {
    expect(areasOf(task({ title: "x", description: "Why.\n  areas: Server/Agent-Manager/, ./ui/chat\nMore." }))).toEqual(["server/agent-manager", "ui/chat"]);
    expect(areasOf(task({ title: "x", description: "No areas named." }))).toEqual([]);
    expect(areasOverlap(["server"], ["server/agent-manager.ts"])).toBe(true);
    expect(areasOverlap(["server/agent-manager"], ["server/agent-manager"])).toBe(true);
    expect(areasOverlap(["server/agent"], ["server/agent-manager"])).toBe(false);
    expect(areasOverlap(["ui/chat"], ["server/chat"])).toBe(false);
  });

  test("a ready task that overlaps a task in progress waits, with the reason in its tag; an unrelated one starts", async () => {
    const running = task({ title: "[go | ready] refactor A", status: "in_progress", assignee: "Isomux Worker 1", description: areas("server/agent-manager") });
    const merging = task({ title: "[go | merging] B", status: "in_progress", description: areas("ui/chat") });
    const same = task({ title: "[go | ready] refactor C", priority: "P0", description: areas("server/agent-manager/queue.ts") });
    const chat = task({ title: "[design | ready] D", description: areas("ui") });
    const free = task({ title: "[go | ready] E", description: areas("server/tasks") });
    const { office } = stubOffice([running, merging, same, chat, free], [agent("Isomux Worker 1"), agent("Isomux Worker 2"), agent("Isomux Worker 3")]);
    const res = await dispatch(office, 3);
    expect(res.assigned.map((a) => a.taskId)).toEqual([free.id]);
    expect(res.waits).toEqual([
      { taskId: same.id, blocker: running.id },
      { taskId: chat.id, blocker: merging.id },
    ]);
    expect(same.title).toBe(`[go | waits for ${running.id}] refactor C`);
    expect(chat.title).toBe(`[design | waits for ${merging.id}] D`);
    expect(same.status).toBe("open");
  });

  test("two ready tasks that overlap: the first starts, the other stays ready and waits from the next run", async () => {
    const one = task({ title: "[go | ready] one", description: areas("server") });
    const two = task({ title: "[go | ready] two", description: areas("server/x") });
    const tasks = [one, two];
    const { office } = stubOffice(tasks, [agent("Isomux Worker 1"), agent("Isomux Worker 2")]);
    expect((await dispatch(office, 2)).assigned.map((a) => a.taskId)).toEqual([one.id]);
    expect(two.title).toBe("[go | ready] two");
    expect((await dispatch(office, 2)).waits).toEqual([{ taskId: two.id, blocker: one.id }]);
  });

  test("a waiting task goes back to ready when its blocker leaves, or names the new one", async () => {
    const a = task({ title: "[go | ready] A", status: "in_progress", assignee: "Isomux Worker 1", description: areas("server") });
    const w = task({ title: `[go | waits for ${a.id}] W`, description: areas("server/x") });
    const tasks = [a, w];
    const { office } = stubOffice(tasks, [agent("Isomux Worker 1"), agent("Isomux Worker 2")]);
    // Still running: nothing changes.
    const still = await dispatch(office, 2);
    expect([still.waits, still.readied, still.assigned]).toEqual([[], [], []]);
    // A merged; another overlapping task runs now: W names it.
    a.status = "done";
    const b = task({ title: "[go | ready] B", status: "in_progress", assignee: "Isomux Worker 1", description: areas("server/x/y.ts") });
    tasks.push(b);
    expect((await dispatch(office, 2)).waits).toEqual([{ taskId: w.id, blocker: b.id }]);
    // B done too: W is ready again, and the next run gives it out.
    b.status = "done";
    expect((await dispatch(office, 2)).readied).toEqual([w.id]);
    expect(w.title).toBe("[go | ready] W");
    expect((await dispatch(office, 2)).assigned.map((x) => x.taskId)).toEqual([w.id]);
  });

  test("a task without an Areas line neither waits nor holds another back", async () => {
    const running = task({ title: "[go | ready] A", status: "in_progress", assignee: "Isomux Worker 1" });
    const r = task({ title: "[go | ready] R", description: areas("server") });
    const { office } = stubOffice([running, r], [agent("Isomux Worker 1"), agent("Isomux Worker 2")]);
    expect((await dispatch(office, 2)).assigned.map((a) => a.taskId)).toEqual([r.id]);
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

  test("wakes Isomux Main once per signed-off push point that is not on origin/main", () => {
    const none = () => false;
    expect(pushToWake({ ok: true, sha: "aaa" }, null, none)).toBe("aaa");
    expect(pushToWake({ ok: true, sha: "aaa" }, "aaa", none)).toBeNull();
    expect(pushToWake({ ok: true, sha: "bbb" }, "aaa", none)).toBe("bbb");
    expect(pushToWake({ ok: false, sha: "bbb" }, "aaa", none)).toBeNull();
    expect(pushToWake({ ok: true, sha: null }, null, none)).toBeNull();
    expect(pushToWake({ ok: true, sha: "bbb" }, "aaa", (sha) => sha === "bbb")).toBeNull();
  });

  // Board task 4a99bf16: a signed-off site-only merge goes out alone.
  test("the tick wakes Isomux Main once for each site-only merge in push.site", async () => {
    const site = [{ taskId: "s1", commit: "bbbbbbb2cc" }, { taskId: "s2", commit: "ccccccc3dd" }];
    const t = stubOffice([], [agent("Isomux Main", true)]);
    const res = await tick(t.office, 2, null, siteToWake(site, ["s2:ccccccc3dd"]));
    expect(res.site).toEqual(["s1:bbbbbbb2cc"]);
    expect(t.messages.map((x) => x.to)).toEqual(["id-Isomux Main"]);
    expect(t.messages[0].text).toContain("s1 (bbbbbbb2cc)");
    expect(t.messages[0].text).not.toContain("s2");
    expect(siteToWake(site, ["s1:bbbbbbb2cc", "s2:ccccccc3dd"])).toEqual([]);
  });

  test("the push wake reaches Isomux Main also when it is busy, with the merge count when it is idle", async () => {
    const m = task({ title: "[go | merging] three", status: "in_progress" });
    const busy = stubOffice([m], [agent("Isomux Main", true)]);
    const res = await tick(busy.office, 2, "abc123");
    expect([res.push, res.main]).toEqual(["abc123", null]);
    expect(busy.messages.map((x) => x.to)).toEqual(["id-Isomux Main"]);
    expect(busy.messages[0].text).toContain("abc123");
    const idle = stubOffice([m], [agent("Isomux Main")]);
    const both = await tick(idle.office, 2, "abc123");
    expect([both.push, both.main]).toEqual(["abc123", 1]);
    expect(idle.messages).toHaveLength(1);
    expect(idle.messages[0].text).toContain("abc123");
    expect(idle.messages[0].text).toContain("1 tasks wait to merge");
    const absent = await tick(stubOffice([m], []).office, 2, "abc123");
    expect(absent.push).toBeNull();
    expect(absent.errors).toHaveLength(1);
  });

  test("skips a task that waits on Nil (state nil), and nudges the worker's other task", async () => {
    const waitsOnNil = task({ title: "[go | nil] waits", status: "in_progress", assignee: "Isomux Worker 1" });
    const designNil = task({ title: "[design | nil] waits", status: "in_progress", assignee: "Isomux Worker 2" });
    const other = task({ title: "[go | ready] other", status: "in_progress", assignee: "Isomux Worker 2" });
    const { office, messages } = stubOffice([waitsOnNil, designNil, other], [agent("Isomux Worker 1"), agent("Isomux Worker 2")]);
    const res = await tick(office, 2);
    expect(res.nudged).toEqual([{ worker: "Isomux Worker 2", taskId: other.id }]);
    expect(messages.map((m) => m.to)).toEqual(["id-Isomux Worker 2"]);
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

  test("a worker without a task that waits on Nil is not free, and says which ask; a holder is not listed twice", () => {
    const h = task({ title: "[go | ready] h", status: "in_progress", assignee: "Isomux Worker 1" });
    const w = [1, 2, 3].map((k) => agent(`Isomux Worker ${k}`));
    const s = status(w, [h], 3, null, () => undefined, new Map([[w[0].id, "ask0"], [w[1].id, "ask1"]]));
    expect([s.freeWorkers, s.waitsOnNil]).toEqual([["Isomux Worker 3"], [{ worker: "Isomux Worker 2", ask: "ask1" }]]);
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

  test("the withdraw line names closed and gone tasks under their own cause", () => {
    const done = task({ title: "b", status: "done" });
    const obsolete = task({ title: "c", status: "obsolete" });
    const line = withdrawLine([done.id, "gone1", obsolete.id], [done, obsolete]);
    const [, closedPart, gonePart] = line.split("; ");
    expect(closedPart).toContain(done.id);
    expect(closedPart).toContain(obsolete.id);
    expect(closedPart).not.toContain("gone1");
    expect(gonePart).toContain("gone1");
    expect(gonePart).not.toContain(done.id);
    // The two causes carry different labels.
    expect(closedPart.split(":")[0]).not.toEqual(gonePart.split(":")[0]);
    // One cause only: no empty part for the other.
    expect(withdrawLine(["gone1"], []).split("; ")).toHaveLength(2);
    expect(withdrawLine([done.id], [done]).split("; ")).toHaveLength(2);
  });
});

describe("proposal refusal", () => {
  test("takes tasks open or in progress in the room", () => {
    const open = task({ title: "a" });
    const working = task({ title: "b", status: "in_progress" });
    const backlog = task({ title: "c", priority: "P4" });
    expect(proposalRefusal([open.id, working.id, backlog.id], [open, working, backlog], ROOM)).toBeNull();
  });

  test("refuses a task the room's list does not have, naming it and the room", () => {
    const open = task({ title: "a" });
    const msg = proposalRefusal([open.id, "global1"], [open], ROOM);
    expect(msg).not.toBeNull();
    expect(msg).toContain("global1");
    expect(msg).toContain(ROOM);
    expect(msg).not.toContain(open.id);
  });

  test("refuses a closed task for another cause than a task outside the room", () => {
    const done = task({ title: "a", status: "done" });
    const closedMsg = proposalRefusal([done.id], [done], ROOM)!;
    const goneMsg = proposalRefusal([done.id], [], ROOM)!;
    expect(closedMsg).toContain(done.id);
    expect(goneMsg).toContain(done.id);
    expect(closedMsg).not.toContain(ROOM);
    expect(goneMsg).toContain(ROOM);
  });
});
