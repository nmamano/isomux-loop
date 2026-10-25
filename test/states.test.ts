import { describe, expect, test } from "bun:test";
import { ClosedTimes } from "../src/closed-times";
import type { Office, Task } from "../src/office";
import { belowFloor, classify, holdTask, latestNote, stateViews, type Card } from "../src/states";
import { tempDir } from "./tmp";

let seq = 0;
function task(over: Partial<Task> & { title: string }): Task {
  seq++;
  return { id: `s${seq}`, status: "open", priority: "P2", createdAt: seq, roomId: "e6818e47", version: `v${seq}`, ...over };
}

describe("classify", () => {
  test("a loop worker's task whose holder id is not live is held by a killed worker; no id, or no agent list, stays working", () => {
    const live = new Set(["w1-new"]);
    const held = (over: Partial<Task>) => task({ title: "[go | ready] x", status: "in_progress", assignee: "Isomux Worker 1", ...over });
    expect(classify(held({ assigneeAgentId: "w1-old" }), null, false, false, live)).toBe("killed");
    expect(classify(held({ assigneeAgentId: "w1-new" }), null, false, false, live)).toBe("working");
    expect(classify(held({}), null, false, false, live)).toBe("working");
    expect(classify(held({ assigneeAgentId: "w1-old" }), null)).toBe("working");
    expect(classify(held({ assigneeAgentId: "lead-old", assignee: "Isomux Lead", title: "untagged" }), null, false, false, live)).toBe("other");
    expect(stateViews([held({ assigneeAgentId: "w1-old" })], new Map(), () => undefined, new Set(), new Set(), live).killed.count).toBe(1);
  });

  test("each board shape lands in its one state", () => {
    const cases: [Partial<Task> & { title: string }, Card, string][] = [
      [{ title: "untagged" }, null, "filed"],
      [{ title: "untagged" }, "open", "triage"],
      [{ title: "untagged" }, "decided", "decided"],
      [{ title: "[go | ready] x", status: "in_progress", assignee: "Isomux Worker 1" }, "decided", "decided"],
      [{ title: "[go | ready] x" }, null, "ready"],
      [{ title: "[auto | ready] x" }, null, "ready"],
      [{ title: "[design | ready] x", priority: "P0" }, null, "ready"],
      [{ title: "[decide | ready] x", priority: "P0" }, null, "ready"],
      [{ title: "[taste | ready] x", priority: "P0" }, null, "other"],
      [{ title: "[go | ready] x", status: "in_progress", assignee: "Isomux Worker 2" }, null, "working"],
      [{ title: "untagged batch", status: "in_progress", assignee: "Isomux Worker 3" }, null, "working"],
      [{ title: "[decide | nil] x" }, "open", "triage"],
      [{ title: "[go | nil] x" }, null, "other"],
      [{ title: "[go | merging] x", status: "in_progress" }, null, "merging"],
      [{ title: "[hold | nil] x" }, null, "hold"],
      [{ title: "[authority | nil] x" }, null, "hold"],
      [{ title: "[go | ready] x", priority: "P4" }, null, "backlog"],
      [{ title: "untagged", priority: "P4" }, null, "backlog"],
      [{ title: "untagged", priority: "P4" }, "open", "triage"],
      [{ title: "untagged", priority: "P4" }, "decided", "decided"],
      [{ title: "[go | merging] x", status: "done" }, null, "done"],
      [{ title: "x", status: "obsolete" }, null, "obsolete"],
      [{ title: "[go | soak until 10-25] x" }, null, "other"],
      [{ title: "[go | ready] x", assignee: "Isomux PM" }, null, "other"],
      [{ title: "untagged", status: "in_progress", assignee: "Isomux Lead" }, null, "other"],
    ];
    for (const [over, card, state] of cases) expect([over.title, classify(task(over), card)]).toEqual([over.title, state]);
    // A merged task whose sign-off item waits counts there, though the board says done.
    expect(classify(task({ title: "[go | merging] x", status: "done" }), null, true)).toBe("signoff");
    // Merged and not pushed: Push, after Sign-off; a task back at work is not in Push.
    expect(classify(task({ title: "x", status: "done" }), null, false, true)).toBe("push");
    expect(classify(task({ title: "x", status: "done" }), null, true, true)).toBe("signoff");
    expect(classify(task({ title: "[go | ready] x" }), null, false, true)).toBe("ready");
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
      task({ title: "[go | ready] x", status: "in_progress", assignee: "Isomux Worker 1" }),
      task({ title: "[go | ready] x" }),
      task({ title: "[go | merging] x", status: "in_progress" }),
      task({ title: "[hold | nil] x" }),
      task({ title: "untagged", priority: "P4" }),
      task({ title: "[go | merging] x", status: "done" }),
    ];
    const decided = task({ title: "untagged", status: "in_progress", assignee: "Isomux Worker 1" });
    const plain = task({ title: "[go | ready] y", status: "in_progress", assignee: "Isomux Worker 1" });
    const cards = new Map<string, Card>([...withCard.map((t) => [t.id, "open"] as [string, Card]), [decided.id, "decided"]]);
    const v = stateViews([...withCard, decided, plain], cards, () => undefined, new Set([withCard[5].id]));
    const openCards = [...cards].filter(([, c]) => c === "open").map(([id]) => id);
    expect(v.triage.count).toBe(openCards.length);
    expect(v.triage.tasks.map((t) => t.id).sort()).toEqual(openCards.sort());
    expect(v.working.tasks.map((t) => t.id)).toEqual([plain.id]);
    // The Decided state is exactly the decided cards, the same way.
    expect(v.decided.tasks.map((t) => t.id)).toEqual([decided.id]);
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

describe("belowFloor", () => {
  test("counts the Ready tasks below the floor, the floor itself not; no floor counts none", () => {
    const ready = stateViews(
      ["P0", "P1", "P1", "P2", "P3"].map((priority) => task({ title: "[go | ready] x", priority })),
      new Map(),
      () => undefined,
    ).ready;
    expect(ready.count).toBe(5);
    expect([belowFloor(ready, "P0"), belowFloor(ready, "P1"), belowFloor(ready, "P3"), belowFloor(ready, null)]).toEqual([4, 2, 0, 0]);
  });
});

describe("on hold", () => {
  test("why a task is on hold: the state part of its tag and the latest dated note, which wins over later undated paragraphs", () => {
    const t = task({
      title: "[hold | waits for Nil] x",
      priority: "P1",
      description: "Scope.\n\nNil, 2026-10-10: P0.\n\nIsomux PM, 2026-10-11: parked until Nil picks a date.\n\nEvidence: logs (read 2026-10-12): none.",
    });
    expect(holdTask(t)).toMatchObject({ id: t.id, priority: "P1", reason: "waits for Nil", note: "Isomux PM, 2026-10-11: parked until Nil picks a date." });
  });

  test("with no dated note the latest note is the last paragraph; an empty description has none", () => {
    expect(latestNote("Scope.\n\n  \nBut also the other projects.\n")).toBe("But also the other projects.");
    expect(latestNote("")).toBe("");
  });
});
