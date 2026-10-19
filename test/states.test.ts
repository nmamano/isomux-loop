import { describe, expect, test } from "bun:test";
import { ClosedTimes } from "../src/closed-times";
import type { Office, Task } from "../src/office";
import { classify, stateViews } from "../src/states";
import { tempDir } from "./tmp";

let seq = 0;
function task(over: Partial<Task> & { title: string }): Task {
  seq++;
  return { id: `s${seq}`, status: "open", priority: "P2", createdAt: seq, roomId: "e6818e47", version: `v${seq}`, ...over };
}

describe("classify", () => {
  test("each board shape lands in its one state", () => {
    const cases: [Partial<Task> & { title: string }, boolean, string][] = [
      [{ title: "untagged" }, false, "filed"],
      [{ title: "untagged" }, true, "proposed"],
      [{ title: "[auto | ready] x" }, false, "ready"],
      [{ title: "[decide | ready] x", priority: "P0" }, false, "ready"],
      [{ title: "[taste | ready] x", priority: "P0" }, false, "other"],
      [{ title: "[auto | ready] x", status: "in_progress", assignee: "Isomux Worker 2" }, false, "working"],
      [{ title: "untagged batch", status: "in_progress", assignee: "Isomux Worker 3" }, false, "working"],
      [{ title: "[decide | nil] x" }, true, "proposed"],
      [{ title: "[auto | nil] x" }, false, "other"],
      [{ title: "[auto | merging] x", status: "in_progress" }, false, "merging"],
      [{ title: "[authority | nil] x" }, false, "never"],
      [{ title: "[auto | ready] x", priority: "P4" }, false, "backlog"],
      [{ title: "untagged", priority: "P4" }, false, "backlog"],
      [{ title: "untagged", priority: "P4" }, true, "proposed"],
      [{ title: "[auto | merging] x", status: "done" }, false, "done"],
      [{ title: "x", status: "obsolete" }, false, "obsolete"],
      [{ title: "[auto | soak until 10-25] x" }, false, "other"],
      [{ title: "[auto | ready] x", assignee: "Isomux PM" }, false, "other"],
      [{ title: "untagged", status: "in_progress", assignee: "Isomux Lead" }, false, "other"],
    ];
    for (const [over, proposed, state] of cases) expect([over.title, classify(task(over), proposed)]).toEqual([over.title, state]);
    // A merged task whose sign-off item waits counts there, though the board says done.
    expect(classify(task({ title: "[auto | merging] x", status: "done" }), false, true)).toBe("signoff");
  });
});

describe("state views", () => {
  test("counts every task once; done lists the last 20 by close time, unknown times last", () => {
    const done = Array.from({ length: 25 }, (_, i) => task({ title: `d${i}`, status: "done" }));
    const open = [task({ title: "a" }), task({ title: "b", priority: "P1" })];
    const times = new Map(done.slice(0, 24).map((t, i) => [t.id, 1000 + i]));
    const v = stateViews([...done, ...open], new Set(), (t) => times.get(t.id));
    expect(v.done.count).toBe(25);
    expect(v.done.tasks.length).toBe(20);
    expect(v.done.tasks[0].title).toBe("d23");
    expect(v.done.tasks[0].closedAt).toBe(1023);
    expect(v.filed.tasks.map((t) => t.title)).toEqual(["b", "a"]);
    const total = Object.values(v).reduce((n, s) => n + s.count, 0);
    expect(total).toBe(27);
  });
});

describe("close times", () => {
  test("read once per task version, kept on disk, re-read when the version changes", async () => {
    const reads: string[] = [];
    const office = {
      async closedAt(id: string) {
        reads.push(id);
        return 500;
      },
    } as unknown as Office;
    const dir = tempDir();
    const t = task({ title: "x", status: "done" });
    const open = task({ title: "y" });
    const c = new ClosedTimes(dir, office);
    expect(await c.fill([t, open])).toBe(1);
    expect(c.get(t)).toBe(500);
    const again = new ClosedTimes(dir, office);
    expect(again.missing([t, open])).toEqual([]);
    expect(again.get({ ...t, version: "changed" })).toBeUndefined();
    await again.fill([{ ...t, version: "changed" }]);
    expect(reads).toEqual([t.id, t.id]);
  });
});
