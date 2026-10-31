import { describe, expect, test } from "bun:test";
import { changes, NewTasks, newTasksText, unreported, waits, type Reported } from "../src/new-tasks";
import type { Office, Task } from "../src/office";
import { tempDir } from "./tmp";

const ROOM = "e6818e47";
let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq++;
  return { id: `n${seq}`, title: `Task ${seq}`, description: "", status: "open", priority: "P2", createdAt: seq, roomId: ROOM, version: `v${seq}`, ...over };
}

function stub(tasks: Task[], deliver = true) {
  const messages: string[] = [];
  const targets: (string | undefined)[] = [];
  const office = {
    tasks: async () => tasks.map((t) => ({ ...t })),
    async message(text: string, to?: string) {
      messages.push(text);
      targets.push(to);
      return deliver;
    },
  } as unknown as Office;
  return { office, messages, targets };
}

// A store whose first run is behind it (the seed), with tasks reported once.
async function reportedOnce(tasks: Task[]) {
  const dir = tempDir();
  const s = new NewTasks(dir);
  const st = stub([...tasks]);
  const hidden = tasks.splice(0);
  await s.run(st.office);
  tasks.push(...hidden);
  const live = stub(tasks);
  await s.run(live.office);
  live.messages.length = 0;
  return { dir, s, st: live };
}

describe("new-task wake-up", () => {
  test("a task waits when open in the room, unassigned, P0-P3 and untagged", () => {
    expect(waits(task())).toBe(true);
    for (const over of [
      { title: "[go | ready] tagged" },
      { title: "[design | nil] tagged" },
      { assignee: "Isomux Worker 1" },
      { priority: "P4" },
      { priority: null },
      { status: "in_progress" },
      { status: "done" },
      { roomId: "other" },
    ])
      expect([over, waits(task(over))]).toEqual([over, false]);
  });

  test("unreported keeps the waiting tasks that were not reported, oldest first", () => {
    const keep = task();
    const p0 = task({ priority: "P0", createdAt: 0 });
    const seen = task();
    const reported: Reported = { [seen.id]: { version: seen.version, text: "", waiting: true } };
    expect(unreported([keep, task({ title: "[go | ready] x" }), seen, p0], reported).map((t) => t.id)).toEqual([p0.id, keep.id]);
  });

  test("the message is one line per task with the whole title, to the app's default target", async () => {
    const a = task({ title: "First  task\nwith a break" });
    const b = task({ title: "Second" });
    expect(newTasksText([a, b])).toBe(`/isomux-curator New tasks for triage: ${a.id} First task with a break\n${b.id} Second`);
    const tasks: Task[] = [];
    const dir = tempDir();
    const s = new NewTasks(dir);
    const o = stub(tasks);
    await s.run(o.office);
    tasks.push(a, b);
    expect((await s.run(o.office)).reported).toEqual([a.id, b.id]);
    expect([o.messages, o.targets]).toEqual([[newTasksText([a, b])], [undefined]]);
  });

  test("the first run takes what it finds as reported; later tasks are reported once, also after a restart", async () => {
    const dir = tempDir();
    const tasks = [task({ title: "Reported by Antifeed" })];
    const o = stub(tasks);
    expect(await new NewTasks(dir).run(o.office, 1)).toEqual({ at: 1, reported: [], changed: [], seeded: 1 });
    const fresh = task({ title: "Fresh" });
    tasks.push(fresh);
    const s = new NewTasks(dir);
    expect((await s.run(o.office)).reported).toEqual([fresh.id]);
    expect((await s.run(o.office)).reported).toEqual([]);
    expect((await new NewTasks(dir).run(o.office)).reported).toEqual([]);
    expect(o.messages).toHaveLength(1);
  });

  test("a failed message records nothing, so the next run sends the task again", async () => {
    const dir = tempDir();
    const tasks: Task[] = [];
    const down = stub(tasks, false);
    await new NewTasks(dir).run(down.office);
    const t = task();
    tasks.push(t);
    const s = new NewTasks(dir);
    expect(await s.run(down.office, 5)).toMatchObject({ reported: [], error: expect.any(String) });
    expect((await s.run(stub(tasks).office)).reported).toEqual([t.id]);
  });

  test("a task that stops waiting (assigned, tagged, P4, closed) is reported as stopped, once", async () => {
    const assigned = task({ title: "Assigned" });
    const tagged = task({ title: "Tagged" });
    const backlog = task({ title: "Backlog" });
    const closed = task({ title: "Closed" });
    const tasks = [assigned, tagged, backlog, closed];
    const { s, st } = await reportedOnce(tasks);
    assigned.assignee = "Isomux Worker 1";
    tagged.title = "[go | ready] Tagged";
    backlog.priority = "P4";
    tasks.splice(3, 1); // done: the listing no longer has it
    expect(await s.run(st.office, 3)).toEqual({ at: 3, reported: [], changed: [assigned.id, tagged.id, backlog.id, closed.id] });
    expect(st.messages).toEqual([
      `/isomux-curator Changed tasks: ${assigned.id} stopped | Assigned\n${tagged.id} stopped | [go | ready] Tagged\n${backlog.id} stopped | Backlog\n${closed.id} stopped | (not on the open board)`,
    ]);
    expect((await s.run(st.office)).changed).toEqual([]);
  });

  test("an edit of the title or description while it waits is reported; a new priority is not", async () => {
    const t = task({ title: "Old title" });
    const tasks = [t];
    const { s, st } = await reportedOnce(tasks);
    t.priority = "P1";
    t.version = "y1";
    expect((await s.run(st.office)).changed).toEqual([]);
    t.description = "More detail.";
    t.version = "y2";
    expect((await s.run(st.office)).changed).toEqual([t.id]);
    t.title = "New title";
    expect((await s.run(st.office)).changed).toEqual([t.id]);
    expect(st.messages).toEqual([`/isomux-curator Changed tasks: ${t.id} edited | Old title`, `/isomux-curator Changed tasks: ${t.id} edited | New title`]);
    expect((await s.run(st.office)).changed).toEqual([]);
  });

  test("a task that waits again is reported (its assignee removed, or its tag)", async () => {
    const t = task({ title: "Back" });
    const tasks = [t];
    const { s, st } = await reportedOnce(tasks);
    t.assignee = "Isomux Worker 2";
    await s.run(st.office);
    t.assignee = null;
    expect((await s.run(st.office)).changed).toEqual([t.id]);
    expect(st.messages.at(-1)).toBe(`/isomux-curator Changed tasks: ${t.id} waits again | Back`);
  });

  test("new and changed tasks go in one message, and a failed message records neither", async () => {
    const old = task({ title: "Old" });
    const tasks = [old];
    const { dir } = await reportedOnce(tasks);
    old.status = "obsolete";
    const fresh = task({ title: "Fresh" });
    tasks.push(fresh);
    const down = stub(tasks, false);
    expect(await new NewTasks(dir).run(down.office)).toMatchObject({ reported: [], changed: [], error: expect.any(String) });
    const up = stub(tasks);
    expect(await new NewTasks(dir).run(up.office, 9)).toEqual({ at: 9, reported: [fresh.id], changed: [old.id] });
    expect(up.messages).toEqual([`/isomux-curator New tasks for triage: ${fresh.id} Fresh\nChanged tasks: ${old.id} stopped | Old`]);
  });

  test("changes() reads only reported tasks", () => {
    expect(changes([task()], {})).toEqual([]);
  });

  test("an empty listing while reported tasks wait records nothing and reports no stops", async () => {
    const t = task({ title: "Still there" });
    const { dir } = await reportedOnce([t]);
    const empty = stub([]);
    await expect(new NewTasks(dir).run(empty.office)).rejects.toThrow("empty");
    expect(empty.messages).toEqual([]);
    expect((await new NewTasks(dir).run(stub([t]).office)).changed).toEqual([]);
  });

  test("an old store (id -> version) is taken as it is: the next run records what it sees and reports no change for it", async () => {
    const dir = tempDir();
    const tagged = task({ title: "[go | ready] decided since" });
    const waiting = task({ title: "Still waiting" });
    const gone = "n-gone";
    await Bun.write(`${dir}/new-tasks.json`, JSON.stringify({ [tagged.id]: "old1", [waiting.id]: "old2", [gone]: "old3" }));
    const tasks = [tagged, waiting];
    const fresh = task({ title: "Fresh" });
    tasks.push(fresh);
    const o = stub(tasks);
    const s = new NewTasks(dir);
    expect(await s.run(o.office)).toEqual({ at: expect.any(Number), reported: [fresh.id], changed: [] });
    waiting.description = "edited";
    expect((await new NewTasks(dir).run(o.office)).changed).toEqual([waiting.id]);
    expect(o.messages).toEqual([newTasksText([fresh]), `/isomux-curator Changed tasks: ${waiting.id} edited | Still waiting`]);
  });
});
