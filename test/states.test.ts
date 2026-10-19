import { describe, expect, test } from "bun:test";
import { ClosedTimes } from "../src/closed-times";
import type { Office, Task } from "../src/office";
import { classify, stateViews, type Card } from "../src/states";
import { tempDir } from "./tmp";

let seq = 0;
function task(over: Partial<Task> & { title: string }): Task {
  seq++;
  return { id: `s${seq}`, status: "open", priority: "P2", createdAt: seq, roomId: "e6818e47", version: `v${seq}`, ...over };
}

describe("classify", () => {
  test("each board shape lands in its one state", () => {
    const cases: [Partial<Task> & { title: string }, Card, string][] = [
      [{ title: "untagged" }, null, "filed"],
      [{ title: "untagged" }, "open", "triage"],
      [{ title: "untagged" }, "decided", "other"],
      [{ title: "[auto | ready] x" }, null, "ready"],
      [{ title: "[decide | ready] x", priority: "P0" }, null, "ready"],
      [{ title: "[taste | ready] x", priority: "P0" }, null, "other"],
      [{ title: "[auto | ready] x", status: "in_progress", assignee: "Isomux Worker 2" }, null, "working"],
      [{ title: "untagged batch", status: "in_progress", assignee: "Isomux Worker 3" }, null, "working"],
      [{ title: "[decide | nil] x" }, "open", "triage"],
      [{ title: "[auto | nil] x" }, null, "other"],
      [{ title: "[auto | merging] x", status: "in_progress" }, null, "merging"],
      [{ title: "[hold | nil] x" }, null, "hold"],
      [{ title: "[authority | nil] x" }, null, "hold"],
      [{ title: "[auto | ready] x", priority: "P4" }, null, "backlog"],
      [{ title: "untagged", priority: "P4" }, null, "backlog"],
      [{ title: "untagged", priority: "P4" }, "open", "triage"],
      [{ title: "untagged", priority: "P4" }, "decided", "other"],
      [{ title: "[auto | merging] x", status: "done" }, null, "done"],
      [{ title: "x", status: "obsolete" }, null, "obsolete"],
      [{ title: "[auto | soak until 10-25] x" }, null, "other"],
      [{ title: "[auto | ready] x", assignee: "Isomux PM" }, null, "other"],
      [{ title: "untagged", status: "in_progress", assignee: "Isomux Lead" }, null, "other"],
    ];
    for (const [over, card, state] of cases) expect([over.title, classify(task(over), card)]).toEqual([over.title, state]);
    // A merged task whose sign-off item waits counts there, though the board says done.
    expect(classify(task({ title: "[auto | merging] x", status: "done" }), null, true)).toBe("signoff");
  });
});

describe("state views", () => {
  test("counts every task once; done lists the last 20 by close time, unknown times last", () => {
    const done = Array.from({ length: 25 }, (_, i) => task({ title: `d${i}`, status: "done" }));
    const open = [task({ title: "a" }), task({ title: "b", priority: "P1" })];
    const times = new Map(done.slice(0, 24).map((t, i) => [t.id, 1000 + i]));
    const v = stateViews([...done, ...open], new Map(), (t) => times.get(t.id));
    expect(v.done.count).toBe(25);
    expect(v.done.tasks.length).toBe(20);
    expect(v.done.tasks[0].title).toBe("d23");
    expect(v.done.tasks[0].closedAt).toBe(1023);
    expect(v.filed.tasks.map((t) => t.title)).toEqual(["b", "a"]);
    const total = Object.values(v).reduce((n, s) => n + s.count, 0);
    expect(total).toBe(27);
  });

  test("the Triage state is exactly the open cards, whatever the board says of their tasks", () => {
    // Every board shape that has a state of its own, each with an open card.
    const withCard = [
      task({ title: "[auto | ready] x", status: "in_progress", assignee: "Isomux Worker 1" }),
      task({ title: "[auto | ready] x" }),
      task({ title: "[auto | merging] x", status: "in_progress" }),
      task({ title: "[hold | nil] x" }),
      task({ title: "untagged", priority: "P4" }),
      task({ title: "[auto | merging] x", status: "done" }),
    ];
    const decided = task({ title: "untagged" });
    const plain = task({ title: "[auto | ready] y", status: "in_progress", assignee: "Isomux Worker 1" });
    const cards = new Map<string, Card>([...withCard.map((t) => [t.id, "open"] as [string, Card]), [decided.id, "decided"]]);
    const v = stateViews([...withCard, decided, plain], cards, () => undefined, new Set([withCard[5].id]));
    const openCards = [...cards].filter(([, c]) => c === "open").map(([id]) => id);
    expect(v.triage.count).toBe(openCards.length);
    expect(v.triage.tasks.map((t) => t.id).sort()).toEqual(openCards.sort());
    expect(v.working.tasks.map((t) => t.id)).toEqual([plain.id]);
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
