import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, ValidationError, itemState } from "../src/store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const dir = mkdtempSync(join(tmpdir(), "loop-store-"));
  dirs.push(dir);
  return { store: new Store(dir, clock.now), clock, dir };
}

const proposal = (taskId: string, over: Record<string, unknown> = {}) => ({
  taskId,
  task: { title: `Task ${taskId}`, description: "d", priority: "P2", createdBy: "Isomux PM", createdAt: 5 },
  proposal: { choice: "go", priority: "P1", why: "needed for the pilot", ...over },
});
const decision = { choice: "go", priority: "P1", note: "" };

describe("store", () => {
  test("proposal, decision and apply move an item through its states", () => {
    const { store } = setup();
    store.propose([proposal("a")]);
    expect(itemState(store.get("a")!)).toBe("open");
    store.decide("a", decision);
    expect(store.pending().map((i) => i.taskId)).toEqual(["a"]);
    const decidedAt = store.get("a")!.decision!.decidedAt;
    expect(store.markApplied([{ taskId: "a", decidedAt, ok: true }])).toEqual({ recorded: ["a"], stale: [] });
    expect(itemState(store.get("a")!)).toBe("applied");
    expect(store.pending()).toEqual([]);
  });

  test("effort is optional; when given it is S, M, L or XL, with a short why", () => {
    const { store } = setup();
    store.propose([proposal("a"), proposal("b", { effort: "L", effortWhy: "server and UI, a live run" })]);
    expect(store.get("a")!.proposal.effort).toBeUndefined();
    expect(store.get("b")!.proposal).toMatchObject({ effort: "L", effortWhy: "server and UI, a live run" });
    expect(() => store.propose([proposal("c", { effort: "XXL" })])).toThrow(ValidationError);
    expect(() => store.propose([proposal("c", { effort: "S", effortWhy: "x".repeat(301) })])).toThrow(ValidationError);
  });

  test("a decision changed after the curator read it stays pending", () => {
    const { store, clock } = setup();
    store.propose([proposal("a")]);
    store.decide("a", decision);
    const readAt = store.get("a")!.decision!.decidedAt;
    clock.advance(1000);
    store.decide("a", { ...decision, choice: "obsolete" });
    expect(store.markApplied([{ taskId: "a", decidedAt: readAt, ok: true }]).stale).toEqual(["a"]);
    expect(itemState(store.get("a")!)).toBe("decided");
  });

  test("a new proposal never overwrites a decision that is not applied", () => {
    const { store } = setup();
    store.propose([proposal("a")]);
    store.decide("a", decision);
    expect(store.propose([proposal("a", { priority: "P3" })]).skipped).toEqual(["a"]);
    expect(store.get("a")!.proposal.priority).toBe("P1");
  });

  test("a new proposal reopens an applied item", () => {
    const { store } = setup();
    store.propose([proposal("a")]);
    store.decide("a", decision);
    store.markApplied([{ taskId: "a", decidedAt: store.get("a")!.decision!.decidedAt }]);
    expect(store.propose([proposal("a", { priority: "P3" })]).updated).toEqual(["a"]);
    expect(itemState(store.get("a")!)).toBe("open");
  });

  test("rewrite: Nil's answer only, with a note and no priority; the curator's next proposal opens the card again", () => {
    const { store } = setup();
    expect(() => store.propose([proposal("a", { choice: "rewrite", priority: null })])).toThrow(ValidationError);
    store.propose([proposal("a")]);
    expect(() => store.decide("a", { choice: "rewrite", note: " " })).toThrow(ValidationError);
    store.decide("a", { choice: "rewrite", priority: "P1", note: "say what breaks for a member" });
    const d = store.get("a")!.decision!;
    expect([d.choice, d.priority]).toEqual(["rewrite", null]);
    expect(store.pending().map((i) => i.taskId)).toEqual(["a"]);
    store.markApplied([{ taskId: "a", decidedAt: d.decidedAt, ok: true }]);
    expect(store.propose([proposal("a", { why: "rewritten as asked" })]).updated).toEqual(["a"]);
    expect([itemState(store.get("a")!), store.get("a")!.proposal.why]).toEqual(["open", "rewritten as asked"]);
  });

  test("a failed apply stays pending and shows as failed", () => {
    const { store } = setup();
    store.propose([proposal("a")]);
    store.decide("a", decision);
    const decidedAt = store.get("a")!.decision!.decidedAt;
    store.markApplied([{ taskId: "a", decidedAt, ok: false, error: "409 stale version" }]);
    expect(itemState(store.get("a")!)).toBe("failed");
    expect(store.pending().map((i) => i.taskId)).toEqual(["a"]);
  });

  test("undo: back in Triage before and after the apply; a report of an undone decision still counts", () => {
    const { store, clock } = setup();
    store.propose([proposal("a"), proposal("b")]);
    store.decide("a", { choice: "obsolete", note: "dup" });
    expect(itemState(store.undo("a") as never)).toBe("open");
    expect(store.get("a")!.reopenedAt).toBeUndefined();
    // The curator read the decision before the undo, then reports it.
    const undoneAt = store.get("a")!.undone!.decidedAt;
    expect(store.markApplied([{ taskId: "a", decidedAt: undoneAt, ok: true }]).recorded).toEqual(["a"]);
    expect([itemState(store.get("a")!), typeof store.get("a")!.reopenedAt]).toEqual(["open", "number"]);
    // After the apply: undo reopens the card.
    store.decide("b", decision);
    clock.advance(10);
    store.markApplied([{ taskId: "b", decidedAt: store.get("b")!.decision!.decidedAt, ok: true }]);
    expect(itemState(store.get("b")!)).toBe("applied");
    store.undo("b");
    expect([itemState(store.get("b")!), typeof store.get("b")!.reopenedAt]).toEqual(["open", "number"]);
    expect(() => store.undo("b")).toThrow(ValidationError);
    // His next decision applies as usual and clears the mark.
    store.decide("b", { choice: "design", priority: "P2", note: "" });
    store.markApplied([{ taskId: "b", decidedAt: store.get("b")!.decision!.decidedAt, ok: true }]);
    expect([itemState(store.get("b")!), store.get("b")!.reopenedAt]).toEqual(["applied", undefined]);
  });

  test("undo of a Bring in: back to the Backlog before the apply, back in Triage after it", () => {
    const { store } = setup();
    const snap = { title: "Old idea", description: "", priority: "P4" as const, createdBy: "Nil", createdAt: 1 };
    store.bringIn(snap, "b1", { choice: "go", priority: "P2" });
    expect(store.undo("b1")).toEqual({ withdrawn: true });
    expect(store.get("b1")).toBeUndefined();
    store.bringIn(snap, "b1", { choice: "go", priority: "P2" });
    store.markApplied([{ taskId: "b1", decidedAt: store.get("b1")!.decision!.decidedAt, ok: true }]);
    store.undo("b1");
    expect(itemState(store.get("b1")!)).toBe("open");
  });

  test("one notification per burst, after the quiet time", () => {
    const { store, clock } = setup();
    store.propose([proposal("a"), proposal("b")]);
    store.decide("a", decision);
    expect(store.shouldNotify(180_000)).toBe(false);
    clock.advance(180_000);
    expect(store.shouldNotify(180_000)).toBe(true);
    store.markNotified();
    expect(store.shouldNotify(180_000)).toBe(false);
    clock.advance(1000);
    store.decide("b", decision);
    clock.advance(180_000);
    expect(store.shouldNotify(180_000)).toBe(true);
  });

  test("state survives a reload", () => {
    const { store, dir } = setup();
    store.propose([proposal("a")]);
    store.decide("a", decision);
    const again = new Store(dir);
    expect(itemState(again.get("a")!)).toBe("decided");
  });

  test("open items list by proposed priority, then task age", () => {
    const { store } = setup();
    store.propose([
      { ...proposal("old-p2", { priority: "P2" }), task: { ...proposal("x").task, createdAt: 1 } },
      { ...proposal("new-p1", { priority: "P1" }), task: { ...proposal("x").task, createdAt: 9 } },
      { ...proposal("old-p1", { priority: "P1" }), task: { ...proposal("x").task, createdAt: 2 } },
    ]);
    expect(store.list("open").map((i) => i.taskId)).toEqual(["old-p1", "new-p1", "old-p2"]);
  });

  test("one choice: go, design and hold need P0-P3; backlog and obsolete carry no priority", () => {
    const { store } = setup();
    expect(() => store.propose([proposal("a", { priority: "P4" })])).toThrow(ValidationError);
    expect(() => store.propose([proposal("a", { priority: undefined })])).toThrow(ValidationError);
    expect(() => store.propose([proposal("a", { choice: "auto" })])).toThrow(ValidationError);
    store.propose([proposal("a", { choice: "backlog", priority: "P1" }), proposal("b", { choice: "hold", scope: "smaller" })]);
    expect([store.get("a")!.proposal.priority, store.get("b")!.proposal.scope]).toEqual([null, "smaller"]);
    expect(() => store.decide("a", { choice: "design", note: "" })).toThrow(ValidationError);
    expect(store.decide("a", { choice: "obsolete", priority: "P2", note: "" }).decision).toMatchObject({ choice: "obsolete", priority: null });
    expect(store.decide("a", { choice: "design", priority: "P3", note: "" }).decision).toMatchObject({ choice: "design", priority: "P3" });
  });

  test("cards stored as class + outcome migrate to one choice on load", () => {
    const { store, dir } = setup();
    const old: [Record<string, unknown>, string, string | null][] = [
      [{ priority: "P1", class: "auto", outcome: "keep" }, "go", "P1"],
      [{ priority: "P2", class: "decide", outcome: "keep" }, "design", "P2"],
      [{ priority: "P0", class: "taste", outcome: "keep" }, "design", "P0"],
      [{ priority: "P3", class: "authority", outcome: "keep" }, "hold", "P3"],
      [{ priority: "P4", class: "auto", outcome: "keep" }, "backlog", null],
      [{ priority: "P1", class: "auto", outcome: "obsolete" }, "obsolete", null],
    ];
    store.propose(old.map((_, n) => proposal(`t${n}`)));
    store.decide("t0", decision);
    const file = join(dir, "triage.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    old.forEach(([shape], n) => (raw.items[`t${n}`].proposal = { ...shape, why: "w", title: n === 1 ? "New title" : undefined }));
    raw.items.t0.decision = { priority: "P2", class: "decide", outcome: "keep", note: "x", decidedAt: 1 };
    writeFileSync(file, JSON.stringify(raw));
    const again = new Store(dir);
    expect(old.map((_, n): (string | null)[] => [again.get(`t${n}`)!.proposal.choice, again.get(`t${n}`)!.proposal.priority])).toEqual(old.map(([, c, pr]) => [c, pr]));
    expect(again.get("t1")!.proposal.title).toBe("New title");
    expect(again.get("t0")!.decision).toEqual({ choice: "design", priority: "P2", note: "x", decidedAt: 1 });
    const saved = JSON.parse(readFileSync(file, "utf8")).items.t0.proposal;
    expect(["class" in saved, "outcome" in saved, saved.choice]).toEqual([false, false, "go"]);
  });

  test("a P4 task gets a card only to promote it", () => {
    const { store } = setup();
    const p4 = (id: string, over: Record<string, unknown>) => ({ ...proposal(id, over), task: { ...proposal(id).task, priority: "P4" } });
    const out = store.propose([p4("stay", { choice: "backlog" }), p4("gone", { choice: "obsolete" }), p4("up", { choice: "design", priority: "P3" })]);
    expect([out.refused, out.created]).toEqual([["stay", "gone"], ["up"]]);
    expect(store.get("stay")).toBeUndefined();
  });

  test("bring in from the backlog: a decided card at P0-P3, refused when a card is open", () => {
    const { store } = setup();
    const snap = { title: "Old idea", description: "", priority: "P4" as const, createdBy: "Nil", createdAt: 1 };
    expect(() => store.bringIn(snap, "b1", { choice: "go", priority: "P4" })).toThrow(ValidationError);
    expect(() => store.bringIn(snap, "b1", { choice: "backlog", priority: "P2" })).toThrow(ValidationError);
    const i = store.bringIn(snap, "b1", { choice: "design", priority: "P2", note: "now matters" });
    expect([itemState(i), i.decision!.choice, i.decision!.priority, i.decision!.note]).toEqual(["decided", "design", "P2", "now matters"]);
    expect(store.pending().map((x) => x.taskId)).toEqual(["b1"]);
    expect(() => store.bringIn(snap, "b1", { choice: "go", priority: "P1" })).toThrow(ValidationError);
  });

});
