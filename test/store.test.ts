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
  proposal: { priority: "P1", class: "auto", outcome: "keep", why: "needed for the pilot", ...over },
});
const decision = { priority: "P1", class: "auto", outcome: "keep", note: "" };

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

  test("a decision changed after the curator read it stays pending", () => {
    const { store, clock } = setup();
    store.propose([proposal("a")]);
    store.decide("a", decision);
    const readAt = store.get("a")!.decision!.decidedAt;
    clock.advance(1000);
    store.decide("a", { ...decision, outcome: "obsolete" });
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

  test("a failed apply stays pending and shows as failed", () => {
    const { store } = setup();
    store.propose([proposal("a")]);
    store.decide("a", decision);
    const decidedAt = store.get("a")!.decision!.decidedAt;
    store.markApplied([{ taskId: "a", decidedAt, ok: false, error: "409 stale version" }]);
    expect(itemState(store.get("a")!)).toBe("failed");
    expect(store.pending().map((i) => i.taskId)).toEqual(["a"]);
  });

  test("no rescope outcome: a keep carries the new title and scope; stored rescope cards migrate to keep", () => {
    const { store, dir } = setup();
    expect(() => store.propose([proposal("a", { outcome: "rescope", scope: "smaller" })])).toThrow(ValidationError);
    store.propose([proposal("a", { scope: "smaller" }), proposal("b")]);
    store.decide("b", decision);
    expect(store.get("a")!.proposal.scope).toBe("smaller");
    const file = join(dir, "triage.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.items.a.proposal.outcome = "rescope";
    raw.items.b.decision.outcome = "rescope";
    writeFileSync(file, JSON.stringify(raw));
    const again = new Store(dir);
    expect([again.get("a")!.proposal.outcome, again.get("a")!.proposal.scope, again.get("b")!.decision!.outcome]).toEqual(["keep", "smaller", "keep"]);
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

  test("a P4 task gets a card only to promote it", () => {
    const { store } = setup();
    const p4 = (id: string, priority: string) => ({ ...proposal(id, { priority }), task: { ...proposal(id).task, priority: "P4" } });
    const out = store.propose([p4("stay", "P4"), p4("up", "P3")]);
    expect([out.refused, out.created]).toEqual([["stay"], ["up"]]);
    expect(store.get("stay")).toBeUndefined();
  });

  test("bring in from the backlog: a decided card at P0-P3, refused when a card is open", () => {
    const { store } = setup();
    const snap = { title: "Old idea", description: "", priority: "P4" as const, createdBy: "Nil", createdAt: 1 };
    expect(() => store.bringIn(snap, "b1", { priority: "P4", class: "auto" })).toThrow(ValidationError);
    const i = store.bringIn(snap, "b1", { priority: "P2", class: "design", note: "now matters" });
    expect([itemState(i), i.decision!.priority, i.decision!.class, i.decision!.outcome, i.decision!.note]).toEqual(["decided", "P2", "design", "keep", "now matters"]);
    expect(store.pending().map((x) => x.taskId)).toEqual(["b1"]);
    expect(() => store.bringIn(snap, "b1", { priority: "P1", class: "auto" })).toThrow(ValidationError);
  });

  test("the class decide is now design: stored cards migrate, new ones take design only", () => {
    const { store, dir } = setup();
    store.propose([proposal("old", { class: "design" })]);
    store.decide("old", { ...decision, class: "design" });
    const file = join(dir, "triage.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.items.old.proposal.class = "decide";
    raw.items.old.decision.class = "decide";
    writeFileSync(file, JSON.stringify(raw));
    const again = new Store(dir);
    expect([again.get("old")!.proposal.class, again.get("old")!.decision!.class]).toEqual(["design", "design"]);
    expect(() => again.propose([proposal("new", { class: "decide" })])).toThrow(ValidationError);
  });

  test("the class authority is now hold: stored cards migrate, new ones take hold only", () => {
    const { store, dir } = setup();
    store.propose([proposal("old", { class: "hold" })]);
    store.decide("old", { ...decision, class: "hold" });
    const file = join(dir, "triage.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.items.old.proposal.class = "authority";
    raw.items.old.decision.class = "authority";
    writeFileSync(file, JSON.stringify(raw));
    const again = new Store(dir);
    expect([again.get("old")!.proposal.class, again.get("old")!.decision!.class]).toEqual(["hold", "hold"]);
    expect(JSON.parse(readFileSync(file, "utf8")).items.old.proposal.class).toBe("hold");
    expect(() => again.propose([proposal("new", { class: "authority" })])).toThrow(ValidationError);
  });
});
