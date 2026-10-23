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

  test("a P4 task's proposal is its backlog recommendation, never a card; a decision reported applied drops it", () => {
    const { store, clock } = setup();
    const p4 = (id: string, over: Record<string, unknown>) => ({ ...proposal(id, over), task: { ...proposal(id).task, priority: "P4" } });
    const out = store.propose([p4("stay", { choice: "backlog", priority: "P1" }), p4("gone", { choice: "obsolete" }), p4("up", { choice: "design", priority: "P3", effort: "S" })]);
    expect([out.recommended, out.created]).toEqual([["stay", "gone", "up"], []]);
    expect(["stay", "gone", "up"].map((id) => store.get(id))).toEqual([undefined, undefined, undefined]);
    expect(store.recommendation("stay")).toMatchObject({ choice: "backlog", priority: null });
    expect(store.recommendation("up")).toMatchObject({ choice: "design", priority: "P3", effort: "S" });
    // A newer one replaces it.
    store.propose([p4("up", { choice: "go", priority: "P2" })]);
    expect(store.recommendation("up")!.choice).toBe("go");
    // Nil decides: the card's proposal is the recommendation; it stays until the apply.
    const i = store.bringIn(proposal("up").task as never, "up", { choice: "obsolete", note: "done elsewhere" });
    expect([i.proposal.choice, i.proposal.why, i.decision!.choice]).toEqual(["go", "needed for the pilot", "obsolete"]);
    expect(store.propose([p4("up", { choice: "hold", priority: "P3" })]).skipped).toEqual(["up"]);
    expect(store.recommendation("up")!.choice).toBe("go");
    clock.advance(5);
    store.markApplied([{ taskId: "up", decidedAt: i.decision!.decidedAt, ok: false, error: "board down" }]);
    expect(store.recommendation("up")).toBeDefined();
    store.markApplied([{ taskId: "up", decidedAt: i.decision!.decidedAt, ok: true }]);
    expect(store.recommendation("up")).toBeUndefined();
    expect(store.recommendation("stay")).toBeDefined();
  });

  test("decide from the backlog: go, design or hold at P0-P3, backlog or obsolete; refused when a card is open", () => {
    const { store } = setup();
    const snap = { title: "Old idea", description: "", priority: "P4" as const, createdBy: "Nil", createdAt: 1 };
    expect(() => store.bringIn(snap, "b1", { choice: "go", priority: "P4" })).toThrow(ValidationError);
    expect(() => store.bringIn(snap, "b1", { choice: "rewrite", note: "x" })).toThrow(ValidationError);
    const i = store.bringIn(snap, "b1", { choice: "design", priority: "P2", note: "now matters" });
    expect([itemState(i), i.decision!.choice, i.decision!.priority, i.decision!.note, i.fromBacklog]).toEqual(["decided", "design", "P2", "now matters", true]);
    expect(store.pending().map((x) => x.taskId)).toEqual(["b1"]);
    expect(() => store.bringIn(snap, "b1", { choice: "go", priority: "P1" })).toThrow(ValidationError);
    expect(store.bringIn(snap, "b2", { choice: "obsolete", priority: "P2", note: "dup of b1" }).decision).toMatchObject({ choice: "obsolete", priority: null, note: "dup of b1" });
    expect(store.bringIn(snap, "b3", { choice: "backlog" }).decision).toMatchObject({ choice: "backlog", priority: null });
    // Undo before the apply: no card, back on the Backlog tab.
    expect(store.undo("b2")).toEqual({ withdrawn: true });
    expect(store.get("b2")).toBeUndefined();
  });

  test("back from hold: an open card holding the task where it is, until the curator proposes it", () => {
    const { store } = setup();
    const snap = { title: "[hold | nil] Big idea", description: "", priority: "P1" as const, createdBy: "Nil", createdAt: 1 };
    const i = store.reopenHold(snap, "h1");
    expect([itemState(i), i.proposal.choice, i.proposal.priority, i.fromHold]).toEqual(["open", "hold", "P1", true]);
    expect(store.reopenHold({ ...snap, priority: null }, "h2").proposal.priority).toBe("P3");
    expect(() => store.reopenHold(snap, "h1")).toThrow(ValidationError);
    // The curator's proposal replaces the placeholder and keeps the mark.
    expect(store.propose([proposal("h1", { choice: "design", priority: "P2" })]).updated).toEqual(["h1"]);
    expect([store.get("h1")!.proposal.choice, store.get("h1")!.fromHold]).toEqual(["design", true]);
    // Taken back before a decision: no card.
    expect(store.withdraw("h2")).toBe(true);
    // Nil decides: a normal triage decision for the curator.
    store.decide("h1", { choice: "go", priority: "P1", note: "" });
    expect(store.pending().map((x) => x.taskId)).toEqual(["h1"]);
    // After the apply, a new proposal is an ordinary card.
    store.markApplied([{ taskId: "h1", decidedAt: store.get("h1")!.decision!.decidedAt, ok: true }]);
    store.propose([proposal("h1")]);
    expect(store.get("h1")!.fromHold).toBeUndefined();
    // A task whose earlier card was applied can come back from hold.
    store.propose([proposal("h3", { choice: "hold" })]);
    store.decide("h3", { choice: "hold", priority: "P2", note: "" });
    store.markApplied([{ taskId: "h3", decidedAt: store.get("h3")!.decision!.decidedAt, ok: true }]);
    expect(itemState(store.reopenHold(snap, "h3"))).toBe("open");
  });


  // Nil, 2026-10-23: a task he keeps in the backlog does not come back as if new.
  test("a backlog keep marks the task kept, and the curator's next recommendation for it is skipped until it changes", () => {
    const { store, clock, dir } = setup();
    const snap = { title: "Old idea", description: "d", priority: "P4" as const, createdBy: "Nil", createdAt: 1 };
    const rec = { taskId: "k", task: snap, proposal: { choice: "backlog", priority: null, why: "still not now" } };
    store.propose([rec]);
    const i = store.bringIn(snap, "k", { choice: "backlog" });
    expect(store.keptMark("k", "Old idea", "d")).toBeUndefined();
    clock.advance(10);
    store.markApplied([{ taskId: "k", decidedAt: i.decision!.decidedAt, ok: true }]);
    const at = clock.now();
    expect(store.keptMark("k", "Old idea", "d", at - 1)).toEqual({ at, by: "Nil" });
    // The curator's write added Nil's note; the first read after the apply records that text.
    clock.advance(10);
    expect(store.keptMark("k", "Old idea", "Nil: keep.\nd")).toMatchObject({ at, by: "Nil" });
    expect(store.propose([{ ...rec, task: { ...snap, description: "Nil: keep.\nd" } }])).toMatchObject({ kept: ["k"], recommended: [] });
    expect(store.recommendation("k")).toBeUndefined();
    // Survives a reload.
    expect(new Store(dir, clock.now).keptMark("k", "Old idea", "Nil: keep.\nd")).toMatchObject({ at });
    // The task changed: no longer kept, and the curator's recommendation counts.
    expect(store.keptMark("k", "Old idea, now urgent", "Nil: keep.\nd")).toBeUndefined();
    expect(store.propose([rec]).recommended).toEqual(["k"]);
  });

  test("a kept task changed on the board takes the curator's recommendation; a decision other than backlog ends the mark", () => {
    const { store, clock } = setup();
    const snap = { title: "Old idea", description: "d", priority: "P4" as const, createdBy: "Nil", createdAt: 1 };
    const keep = (id: string) => {
      const d = store.bringIn(snap, id, { choice: "backlog" }).decision!.decidedAt;
      store.markApplied([{ taskId: id, decidedAt: d, ok: true }]);
      clock.advance(10);
      store.keptMark(id, "Old idea", "d");
    };
    keep("a");
    expect(store.propose([{ taskId: "a", task: { ...snap, title: "Old idea (scoped)" }, proposal: { choice: "go", priority: "P2", why: "now cheap" } }]).recommended).toEqual(["a"]);
    expect(store.keptMark("a", "Old idea (scoped)", "d")).toBeUndefined();
    keep("b");
    const d = store.bringIn(snap, "b", { choice: "go", priority: "P1" }).decision!.decidedAt;
    store.markApplied([{ taskId: "b", decidedAt: d, ok: true }]);
    expect(store.keptMark("b", "Old idea", "d")).toBeUndefined();
    // A failed apply changes nothing; a triage card demoted to backlog is kept too.
    store.propose([proposal("c")]);
    store.decide("c", { choice: "backlog", note: "" });
    store.markApplied([{ taskId: "c", decidedAt: store.get("c")!.decision!.decidedAt, ok: false, error: "board down" }]);
    expect(store.keptMark("c", "Task c", "d")).toBeUndefined();
    store.decide("c", { choice: "backlog", note: "" });
    store.markApplied([{ taskId: "c", decidedAt: store.get("c")!.decision!.decidedAt, ok: true }]);
    expect(store.keptMark("c", "Task c", "d", 0)).toMatchObject({ by: "Nil" });
  });


  test("the one-time backfill keeps the tasks whose latest applied decision, card or packet, was backlog", () => {
    const { store, clock, dir } = setup();
    const apply = (id: string, choice: string) => {
      store.propose([proposal(id)]);
      store.decide(id, { choice, priority: choice === "go" ? "P1" : null, note: "" });
      store.markApplied([{ taskId: id, decidedAt: store.get(id)!.decision!.decidedAt, ok: true }]);
      clock.advance(10);
    };
    apply("old", "backlog");
    const oldAt = store.get("old")!.applied!.at;
    apply("go", "go");
    apply("pkt", "go");
    apply("later", "backlog");
    // Kept marks predate this store: start from the file without them.
    const raw = JSON.parse(readFileSync(join(dir, "triage.json"), "utf8"));
    delete raw.kept;
    writeFileSync(join(dir, "triage.json"), JSON.stringify(raw));
    const s2 = new Store(dir, clock.now);
    s2.noteApplied("later", "backlog");
    const laterAt = s2.keptMark("later", "x", "y", 0)!.at;
    const out = s2.backfillKept([
      { taskId: "pkt", choice: "backlog", at: clock.now() },
      { taskId: "go", choice: "backlog", at: 0 },
      { taskId: "p2", choice: "backlog", at: 5 },
    ]);
    expect(out.sort()).toEqual(["old", "p2", "pkt"]);
    expect(s2.keptMark("old", "x", "y", 0)).toEqual({ at: oldAt, by: "Nil" });
    expect(s2.keptMark("go", "x", "y", 0)).toBeUndefined();
    expect(s2.keptMark("later", "x", "y", 0)!.at).toBe(laterAt);
    // Once only, also after a reload.
    s2.noteApplied("pkt", "go");
    expect(new Store(dir, clock.now).backfillKept([{ taskId: "pkt", choice: "backlog", at: clock.now() + 1 }])).toEqual([]);
    expect(new Store(dir, clock.now).keptMark("pkt", "x", "y", 0)).toBeUndefined();
  });

});
