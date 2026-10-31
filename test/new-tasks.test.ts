import { describe, expect, test } from "bun:test";
import { NewTasks, newTasksText, unreported } from "../src/new-tasks";
import type { Office, Task } from "../src/office";
import { tempDir } from "./tmp";

const ROOM = "e6818e47";
let seq = 0;
function task(over: Partial<Task> & { title: string }): Task {
  seq++;
  return { id: `n${seq}`, status: "open", priority: "P2", createdAt: seq, roomId: ROOM, version: `v${seq}`, ...over };
}

function stub(tasks: Task[], deliver = true) {
  const messages: (string | undefined)[] = [];
  const office = {
    tasks: async () => tasks.map((t) => ({ ...t })),
    async message(text: string, to?: string) {
      messages.push(text, to);
      return deliver;
    },
  } as unknown as Office;
  return { office, messages };
}

describe("new-task wake-up", () => {
  test("only open, untagged P0-P3 tasks of the room that were not reported, oldest first", () => {
    const keep = task({ title: "Keep" });
    const p0 = task({ title: "Urgent", priority: "P0", createdAt: 0 });
    const others = [
      task({ title: "[go | ready] tagged" }),
      task({ title: "Backlog", priority: "P4" }),
      task({ title: "No priority", priority: null }),
      task({ title: "Working", status: "in_progress" }),
      task({ title: "Other room", roomId: "other" }),
      task({ title: "Seen" }),
    ];
    const seen = others[others.length - 1];
    expect(unreported([keep, ...others, p0], { [seen.id]: seen.version }).map((t) => t.id)).toEqual([p0.id, keep.id]);
  });

  test("the message is one line per task with the whole title, to the app's default target", async () => {
    const a = task({ title: "First  task\nwith a break" });
    const b = task({ title: "Second" });
    expect(newTasksText([a, b])).toBe(`/isomux-curator New tasks for triage: ${a.id} First task with a break\n${b.id} Second`);
    const dir = tempDir();
    const tasks: Task[] = [];
    const { office, messages } = stub(tasks);
    const s = new NewTasks(dir);
    await s.run(office);
    tasks.push(a, b);
    expect((await s.run(office)).reported).toEqual([a.id, b.id]);
    expect(messages).toEqual([newTasksText([a, b]), undefined]);
  });

  test("the first run takes what it finds as reported; later tasks are reported once, also after a restart", async () => {
    const dir = tempDir();
    const old = task({ title: "Reported by Antifeed" });
    const tasks = [old];
    const { office, messages } = stub(tasks);
    expect(await new NewTasks(dir).run(office, 1)).toEqual({ at: 1, reported: [], seeded: 1 });
    const fresh = task({ title: "Fresh" });
    tasks.push(fresh);
    const s = new NewTasks(dir);
    expect((await s.run(office)).reported).toEqual([fresh.id]);
    expect((await s.run(office)).reported).toEqual([]);
    expect((await new NewTasks(dir).run(office)).reported).toEqual([]);
    expect(messages.filter((m) => m !== undefined)).toHaveLength(1);
  });

  test("a failed message records nothing, so the next run sends the task again", async () => {
    const dir = tempDir();
    const tasks: Task[] = [];
    const down = stub(tasks, false);
    await new NewTasks(dir).run(down.office);
    const t = task({ title: "Lost?" });
    tasks.push(t);
    const s = new NewTasks(dir);
    expect(await s.run(down.office, 5)).toMatchObject({ reported: [], error: expect.any(String) });
    const up = stub(tasks);
    expect((await s.run(up.office)).reported).toEqual([t.id]);
  });
});
