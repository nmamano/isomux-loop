import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sniff } from "../src/images";
import { PacketStore, packetState } from "../src/packets";
import { REVERT_HOLD_MS, REVERT_RETRY_MS } from "../src/config";
import type { Office, PatchResult, Task } from "../src/office";
import { guessAudience, sendDueReverts, SignoffStore, signoffState, undoDecision, withAudience } from "../src/signoff";
import { ValidationError } from "../src/store";
import { tempDir } from "./tmp";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const task = { title: "Pick a layout", priority: "P1" };
const packet = (over: Record<string, unknown> = {}) => ({
  taskId: "abc12345",
  question: "Which layout?",
  options: [
    { label: "Grid", cost: "1 day", recommended: true, decision: "go", note: "Build the grid." },
    { label: "List", cost: "2 h", decision: "design" },
  ],
  body: "## Findings\n- one",
  ...over,
});

describe("packets", () => {
  test("a packet takes 2-4 options, at most one recommended, each with a choice; the note defaults to the label", () => {
    const s = new PacketStore(tempDir());
    const opt = (label: string, over = {}) => ({ label, decision: "go", ...over });
    expect(() => s.put(packet({ options: [opt("A")] }), task)).toThrow(ValidationError);
    expect(() => s.put(packet({ options: [opt("A", { recommended: true }), opt("B", { recommended: true })] }), task)).toThrow(ValidationError);
    expect(() => s.put(packet({ options: [opt("A"), { label: "B" }] }), task)).toThrow(ValidationError);
    expect(() => s.put(packet({ options: [opt("A"), opt("B", { decision: "research more" })] }), task)).toThrow(ValidationError);
    expect(() => s.put(packet({ diffUrl: "javascript:alert(1)" }), task)).toThrow(ValidationError);
    const p = s.put(packet(), task);
    expect(p.options.map((o) => [o.decision, o.note])).toEqual([["go", "Build the grid."], ["design", "List"]]);
  });

  test("a packet is decided like a triage card; an option only fills it", () => {
    const s = new PacketStore(tempDir(), () => 7);
    s.put(packet(), task);
    expect(() => s.decide("abc12345", { choice: "Grid", note: "x" })).toThrow(ValidationError);
    expect(() => s.decide("abc12345", { choice: "design", note: "x" })).toThrow(ValidationError);
    expect(() => s.decide("abc12345", { choice: "go", priority: "P1", note: " " })).toThrow(ValidationError);
    expect(s.decide("abc12345", { choice: "obsolete", priority: "P1" }).decision).toEqual({ choice: "obsolete", priority: null, note: "", decidedAt: 7 });
    expect(s.decide("abc12345", { choice: "design", priority: "P2", preset: "Table" }).decision).toEqual({ choice: "design", priority: "P2", note: "", decidedAt: 7 });
    expect(s.decide("abc12345", { choice: "go", priority: "P0", note: "Grid, 3 columns", preset: "Grid" }).decision).toEqual({
      choice: "go",
      priority: "P0",
      note: "Grid, 3 columns",
      preset: "Grid",
      decidedAt: 7,
    });
    expect(s.pending().map((p) => p.taskId)).toEqual(["abc12345"]);
    expect(s.markApplied("abc12345", 6, true)).toBe(false);
    expect(s.markApplied("abc12345", 7, true)).toBe(true);
    expect(packetState(s.get("abc12345")!)).toBe("applied");
  });

  test("a packet stored before 2026-10-20 reads in the new shape", () => {
    const dir = tempDir();
    const old = (decision: unknown, undone?: unknown) => ({
      taskId: "abc12345", title: "t", priority: "P2", question: "q", body: "", images: [], createdAt: 1, applied: null, decision, undone,
      options: [{ label: "A: grid", cost: "", recommended: true }, { label: "B. Close, no change", cost: "", recommended: false }],
    });
    writeFileSync(join(dir, "packets.json"), JSON.stringify({
      abc12345: old({ choice: "A: grid", note: "3 columns", decidedAt: 5 }, { choice: "rescope", note: "smaller", decidedAt: 4 }),
      def67890: { ...old({ choice: "research more", note: "", decidedAt: 6 }), taskId: "def67890", priority: "P4" },
    }));
    const s = new PacketStore(dir);
    const a = s.get("abc12345")!;
    expect(a.options.map((o) => [o.decision, o.note])).toEqual([["go", "A: grid"], ["obsolete", "B. Close, no change"]]);
    expect(a.decision).toEqual({ choice: "go", priority: "P2", note: "A: grid\n\n3 columns", preset: "A: grid", decidedAt: 5 });
    expect(a.undone).toEqual({ choice: "design", priority: "P2", note: "smaller", decidedAt: 4 });
    expect(s.get("def67890")!.decision).toEqual({ choice: "design", priority: null, note: "", decidedAt: 6 });
    expect(JSON.parse(readFileSync(join(dir, "packets.json"), "utf8")).abc12345.decision.choice).toBe("go");
  });

  test("rewrite on a packet needs a note; the re-posted packet is open again", () => {
    const s = new PacketStore(tempDir(), () => 9);
    s.put(packet(), task);
    expect(() => s.decide("abc12345", { choice: "rewrite" })).toThrow(ValidationError);
    expect(s.decide("abc12345", { choice: "rewrite", priority: "P1", note: "shorter question" }).decision).toEqual({ choice: "rewrite", priority: null, note: "shorter question", decidedAt: 9 });
    s.markApplied("abc12345", 9, true);
    expect(packetState(s.get("abc12345")!)).toBe("applied");
    s.put(packet({ question: "Grid or list?" }), task);
    expect(packetState(s.get("abc12345")!)).toBe("open");
  });

  test("undo: before and after the apply; a report of an undone decision still counts", () => {
    let t = 1;
    const s = new PacketStore(tempDir(), () => t++);
    s.put(packet(), task);
    s.decide("abc12345", { choice: "obsolete" });
    const at = s.get("abc12345")!.decision!.decidedAt;
    s.undo("abc12345");
    expect(packetState(s.get("abc12345")!)).toBe("open");
    expect(s.markApplied("abc12345", at, true)).toBe(true);
    expect([packetState(s.get("abc12345")!), typeof s.get("abc12345")!.reopenedAt]).toEqual(["open", "number"]);
    s.decide("abc12345", { choice: "backlog" });
    s.markApplied("abc12345", s.get("abc12345")!.decision!.decidedAt, true);
    expect([packetState(s.get("abc12345")!), s.get("abc12345")!.reopenedAt]).toEqual(["applied", undefined]);
    s.undo("abc12345");
    expect([packetState(s.get("abc12345")!), typeof s.get("abc12345")!.reopenedAt]).toEqual(["open", "number"]);
  });

  test("remove: the curator withdraws an open or applied packet, never one whose decision waits", () => {
    const s = new PacketStore(tempDir(), () => 5);
    expect(s.remove("abc12345")).toBe("not_found");
    s.put(packet(), task);
    s.decide("abc12345", { choice: "obsolete" });
    expect(s.remove("abc12345")).toBe("pending");
    s.markApplied("abc12345", 5, false, "409");
    expect(s.remove("abc12345")).toBe("pending");
    s.undo("abc12345");
    expect([s.remove("abc12345"), s.get("abc12345")]).toEqual(["removed", undefined]);
  });

  test("withdraw: a packet whose task closed leaves with its images", () => {
    const dir = tempDir();
    const s = new PacketStore(dir);
    s.put(packet(), task);
    const file = join(dir, "images", "packets", "abc12345", s.addImage("abc12345", PNG, "shot").file);
    expect(existsSync(file)).toBe(true);
    expect(s.withdraw("abc12345")).toBe(true);
    expect([s.get("abc12345"), s.withdraw("abc12345"), existsSync(file)]).toEqual([undefined, false, false]);
    expect(new PacketStore(dir).get("abc12345")).toBeUndefined();
  });

  test("a new packet replaces the old one and its decision; it keeps the images unless told to clear them", () => {
    const dir = tempDir();
    const s = new PacketStore(dir);
    const file = join(dir, "images", "packets", "abc12345", "1.png");
    s.put(packet(), task);
    s.addImage("abc12345", PNG, "before");
    s.decide("abc12345", { choice: "obsolete" });
    const again = s.put(packet({ question: "Which layout, now?" }), task);
    expect([again.decision, again.images.map((i) => i.caption), existsSync(file)]).toEqual([null, ["before"], true]);
    expect(new PacketStore(dir).get("abc12345")!.question).toBe("Which layout, now?");
    expect(s.addImage("abc12345", PNG, "after").file).not.toBe("1.png");
    const cleared = s.put(packet({ clearImages: true }), task);
    expect([cleared.images.length, existsSync(file)]).toEqual([0, false]);
  });

  test("images: the type comes from the bytes; other bytes and path tricks are refused", () => {
    const s = new PacketStore(tempDir());
    s.put(packet(), task);
    expect(sniff(PNG)?.type).toBe("image/png");
    expect(() => s.addImage("abc12345", new TextEncoder().encode("<svg onload=x>"), "")).toThrow(ValidationError);
    expect(s.addImage("abc12345", PNG, "c").file).toBe("1.png");
    expect(s.images.read("abc12345", "../packets.json")).toBeNull();
    expect(s.images.read("..", "1.png")).toBeNull();
    expect(s.images.read("abc12345", "1.png")?.length).toBe(PNG.length);
  });
});

describe("sign-off", () => {
  const item = { taskId: "t1", title: "Docs line", copy: [{ where: "docs/features.md", old: "a", new: "b" }] };

  test("scout: a verdict on a merged item, suggestions by real entry index, a new post replaces the old", () => {
    let t = 1;
    const s = new SignoffStore(tempDir(), () => t++);
    s.put(item);
    expect(() => s.setScout("t1", { verdict: "stamp", reason: "copy only" })).toThrow(ValidationError);
    s.merged("t1", { commit: "aaaaaaa1" });
    expect(() => s.setScout("t1", { verdict: "approve", reason: "x" })).toThrow(ValidationError);
    expect(() => s.setScout("t1", { verdict: "look", reason: "" })).toThrow(ValidationError);
    expect(() => s.setScout("t1", { verdict: "look", reason: "x", suggestions: { copy: { "1": "no such entry" } } })).toThrow(ValidationError);
    expect(() => s.setScout("t1", { verdict: "look", reason: "x", suggestions: { images: { "0": "no images" } } })).toThrow(ValidationError);
    s.setScout("t1", { verdict: "pushback", reason: "breaks the 10-19 ruling", suggestions: { copy: { "0": '"Shorter."' } } });
    expect(s.get("t1")!.scout).toMatchObject({ verdict: "pushback", suggestions: { copy: { "0": '"Shorter."' }, images: {} } });
    s.setScout("t1", { verdict: "stamp", reason: "copy only" });
    expect(s.get("t1")!.scout).toMatchObject({ verdict: "stamp", reason: "copy only", suggestions: { copy: {}, images: {} } });
  });

  test("history: each decision keeps the verdict it had; an undone approval leaves it; a linked changes task shows", () => {
    let t = 1;
    const s = new SignoffStore(tempDir(), () => t++);
    for (const id of ["t1", "t2"]) s.put({ ...item, taskId: id });
    s.merged("t1", { commit: "aaaaaaa1" });
    s.merged("t2", { commit: "bbbbbbb2" });
    s.setScout("t1", { verdict: "stamp", reason: "copy only" });
    s.approve("t1");
    expect(s.history().map((h) => [h.taskId, h.approved, h.scout?.verdict])).toEqual([["t1", true, "stamp"]]);
    s.undo("t1");
    expect(s.history()).toEqual([]);
    s.approve("t1");
    s.linkEdits("t1", "fix1aaaa");
    s.recordReject("t2", "wrong tone");
    expect(s.history().map((h) => [h.taskId, h.approved, h.note, h.edits, h.scout?.verdict ?? null])).toEqual([
      ["t2", false, "wrong tone", undefined, null],
      ["t1", true, "", "fix1aaaa", "stamp"],
    ]);
    // The history outlives the item: a push go removes approved items.
    s.recordPushGo("aaaaaaa1");
    expect([s.get("t1"), s.history().length]).toEqual([undefined, 2]);
  });

  test("only merged items show; Main's merged call without an item still records the sha", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    expect(s.visible()).toEqual([]);
    expect(s.merged("other1", { commit: "aaaaaaa1" })).toEqual({ signoff: false });
    expect(s.merged("t1", { commit: "bbbbbbb2" })).toEqual({ signoff: true });
    expect(s.visible().map((i) => i.taskId)).toEqual(["t1"]);
    expect(s.meta().lastSha!.commit).toBe("bbbbbbb2");
    expect(() => s.merged("t1", { commit: "not a sha" })).toThrow(ValidationError);
  });

  test("push point: everything up to the first item that waits; later approvals wait for the next push", () => {
    const s = new SignoffStore(tempDir());
    for (const id of ["t1", "t2", "t4"]) s.put({ ...item, taskId: id });
    s.merged("t1", { commit: "aaaaaaa1" });
    s.merged("plain", { commit: "bbbbbbb2" });
    s.merged("t2", { commit: "ccccccc3" });
    s.merged("t4", { commit: "ddddddd4" });
    // t1 waits: nothing before it, so nothing to push.
    expect(s.pushCheck()).toMatchObject({ ok: false, sha: null });
    s.approve("t1");
    // Up to plain: t2 waits, so its merge and later ones stay behind.
    expect(s.pushCheck()).toMatchObject({ ok: true, sha: "bbbbbbb2", tasks: ["t1", "plain"], approved: ["t1"] });
    s.approve("t4");
    expect(s.pushCheck().sha).toBe("bbbbbbb2");
    expect(s.pushCheck().blockers.map((b) => b.taskId)).toEqual(["t2"]);
    s.recordPushGo("bbbbbbb2");
    // Only the approvals up to the push point leave; t4 waits behind t2.
    expect(s.visible().map((i) => i.taskId)).toEqual(["t2", "t4"]);
    expect(s.pushCheck()).toMatchObject({ ok: false, sha: "bbbbbbb2" });
    s.approve("t2");
    expect(s.pushCheck()).toMatchObject({ ok: true, sha: "ddddddd4", approved: ["t2", "t4"] });
    s.pushed({ commit: "bbbbbbb2" });
    expect(s.pushCheck().tasks).toEqual(["t2", "t4"]);
  });

  test("push point: an item approved with changes holds it back until its Sign-off changes task merges or closes", () => {
    const s = new SignoffStore(tempDir());
    for (const id of ["t1", "t2"]) s.put({ ...item, taskId: id });
    s.merged("before", { commit: "aaaaaaa1" });
    s.merged("t1", { commit: "bbbbbbb2" });
    s.merged("t2", { commit: "ccccccc3" });
    s.approve("t1", "fix1");
    s.approve("t2", "fix2");
    // t1 waits for fix1: the push stops before t1's merge.
    expect(s.pushCheck()).toMatchObject({ ok: true, sha: "aaaaaaa1", tasks: ["before"] });
    expect(s.pushCheck().blockers).toEqual([
      { taskId: "t1", state: "edits", seq: 2, edits: "fix1" },
      { taskId: "t2", state: "edits", seq: 3, edits: "fix2" },
    ]);
    // fix1 merges (Main reports it): t1 and fix1 may go, t2 still waits for fix2.
    s.merged("fix1", { commit: "ddddddd4" });
    expect(s.pushCheck().sha).toBe("bbbbbbb2");
    // fix2 closed on the board (done or obsolete) without a merge: nothing holds back.
    expect(s.pushCheck((id) => id === "fix2")).toMatchObject({ ok: true, sha: "ddddddd4", blockers: [] });
  });

  test("a changes task filed by hand: only for an approved item without one; then the push waits for it", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    expect(() => s.linkEdits("t1", "fix1aaaa")).toThrow(ValidationError);
    s.approve("t1");
    expect(s.pushCheck().sha).toBe("aaaaaaa1");
    expect(() => s.linkEdits("t1", "t1")).toThrow(ValidationError);
    s.linkEdits("t1", "fix1aaaa");
    expect(() => s.linkEdits("t1", "fix2aaaa")).toThrow(ValidationError);
    expect(s.pushCheck()).toMatchObject({ ok: false, sha: null, blockers: [{ taskId: "t1", state: "edits", edits: "fix1aaaa" }] });
  });

  test("push point: a rejected merge holds it back until its revert, and no point between them is used", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("before", { commit: "aaaaaaa1" });
    s.merged("t1", { commit: "bbbbbbb2" });
    s.merged("after", { commit: "ccccccc3" });
    s.recordReject("t1", "wrong tone");
    expect(s.pushCheck()).toMatchObject({ ok: true, sha: "aaaaaaa1" });
    expect(() => s.put(item)).toThrow(ValidationError);
    s.reverted("t1", { commit: "ddddddd4" });
    // After the revert: up to the revert, never to "after" alone (it holds t1 without its revert).
    expect(s.pushCheck()).toMatchObject({ ok: true, sha: "ddddddd4", tasks: ["before", "after"] });
    s.merged("later", { commit: "eeeeeee5" });
    expect(s.pushCheck().sha).toBe("eeeeeee5");
    s.pushed({ commit: "aaaaaaa1" });
    expect(s.pushCheck()).toMatchObject({ sha: "eeeeeee5", tasks: ["after", "later"] });
  });

  test("commit counts: distinct reported shas up to the push point and since the last push", () => {
    const s = new SignoffStore(tempDir());
    s.put({ ...item, taskId: "w" });
    s.merged("a", { commit: "aaaaaaa1" });
    // A task with no code is reported with the main sha of the time.
    s.merged("copy", { commit: "aaaaaaa1" });
    s.merged("b", { commit: "bbbbbbb2" });
    s.merged("w", { commit: "ccccccc3" });
    s.merged("c", { commit: "ddddddd4" });
    expect(s.pushCheck()).toMatchObject({ sha: "bbbbbbb2", tasks: ["a", "copy", "b"], commits: 2, unpushedCommits: 4 });
    s.pushed({ commit: "aaaaaaa1" });
    expect(s.pushCheck()).toMatchObject({ commits: 1, unpushedCommits: 3 });
  });

  test("push point: never the rejected merge itself while a later item waits, also after its revert", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.put({ ...item, taskId: "w" });
    s.merged("before", { commit: "aaaaaaa1" });
    s.merged("t1", { commit: "bbbbbbb2" });
    s.merged("w", { commit: "ccccccc3" });
    s.recordReject("t1", "wrong tone");
    s.reverted("t1", { commit: "ddddddd4" });
    // w waits, so the point stays before it; bbbbbbb2 would ship t1 without its revert.
    expect(s.pushCheck()).toMatchObject({ ok: true, sha: "aaaaaaa1", tasks: ["before"] });
  });

  test("every merge waits in Push until Main reports a push that includes it; a revert takes the task out", () => {
    const dir = tempDir();
    const s = new SignoffStore(dir);
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.merged("plain", { commit: "bbbbbbb2" });
    s.approve("t1");
    s.recordPushGo("bbbbbbb2");
    // The push go alone pushes nothing: Main reports the push.
    expect([...s.unpushedIds()].sort()).toEqual(["plain", "t1"]);
    s.merged("later", { commit: "ccccccc3" });
    s.merged("gone", { commit: "ddddddd4" });
    s.reverted("gone", { commit: "eeeeeee5" });
    expect(() => s.pushed({ commit: "fffffff6" })).toThrow(ValidationError);
    expect(s.pushed({ commit: "bbbbbbb2" }).pushed.sort()).toEqual(["plain", "t1"]);
    expect([...new SignoffStore(dir).unpushedIds()]).toEqual(["later"]);
    expect(s.pushed({ commit: "eeeeeee" }).pushed).toEqual(["later"]);
    expect(s.unpushedIds().size).toBe(0);
  });

  test("copy audience: as given, or guessed from where and marked guessed; other values are refused", () => {
    const s = new SignoffStore(tempDir());
    const it = s.put({ ...item, copy: [
      { where: "server/system-prompt.ts", old: "", new: "a" },
      { where: "ui/settings.tsx", old: "", new: "b" },
      { where: "GitHub comment on issue 12", old: "", new: "c", audience: "member" },
      { where: "server/agent-reference/tasks.md", old: "", new: "d", audience: "member" },
    ] });
    expect(it.copy.map((c) => [c.audience, Boolean(c.guessed)])).toEqual([["agent", true], ["member", true], ["member", false], ["member", false]]);
    expect(() => s.put({ ...item, copy: [{ where: "x", old: "", new: "y", audience: "robot" }] })).toThrow(ValidationError);
    // Where: member paths win over agent words; skills and the agent reference are for agents.
    expect(["ui/skills-panel.tsx", "~/.claude/skills/isomux-curator/SKILL.md", "isomux-curator skill", "docs/features.md", "shared/i18n/en.ts", "README.md"].map(guessAudience))
      .toEqual(["member", "agent", "agent", "member", "member", "member"]);
    // An entry stored before audiences existed is guessed when read.
    expect(withAudience({ where: "server/system-prompt.ts", old: "", new: "x" })).toMatchObject({ audience: "agent", guessed: true });
  });

  test("the unpushed list is in merge order; a merge the last push go included is marked sent", () => {
    const s = new SignoffStore(tempDir());
    s.merged("a", { commit: "aaaaaaa1" });
    s.merged("b", { commit: "bbbbbbb2" });
    expect(s.unpushedList().map((u) => [u.taskId, u.sent])).toEqual([["a", false], ["b", false]]);
    s.recordPushGo("aaaaaaa1");
    s.merged("c", { commit: "ccccccc3" });
    expect(s.unpushedList().map((u) => [u.taskId, u.sent])).toEqual([["a", true], ["b", false], ["c", false]]);
    s.pushed({ commit: "aaaaaaa1" });
    expect(s.unpushedList().map((u) => u.taskId)).toEqual(["b", "c"]);
  });

  test("data from before the push record: merged items that are not rejected count as not pushed", () => {
    const dir = tempDir();
    const old = new SignoffStore(dir);
    old.put(item);
    old.put({ ...item, taskId: "t2" });
    old.merged("t1", { commit: "aaaaaaa1" });
    old.merged("t2", { commit: "bbbbbbb2" });
    old.approve("t1");
    old.recordReject("t2", "no");
    const file = join(dir, "signoff.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.unpushed;
    delete raw.shas;
    delete raw.seq;
    writeFileSync(file, JSON.stringify(raw));
    const s = new SignoffStore(dir);
    expect([...s.unpushedIds()]).toEqual(["t1"]);
    expect(s.pushed({ commit: "bbbbbbb2" }).pushed).toEqual(["t1"]);
  });

  test("an approval can be undone, with its note back", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.approve("t1", "ed1", "shorter");
    const u = s.undo("t1");
    expect([signoffState(u.item), u.note]).toEqual(["waiting", "shorter"]);
    expect(() => s.undo("t1")).toThrow(ValidationError);
  });

  // Nil, 2026-10-24: the revert request waits REVERT_HOLD_MS, so a rejection can be undone.
  test("a rejection holds its revert request; undo takes it back until Main has it", async () => {
    let t = 1000;
    const dir = tempDir();
    const s = new SignoffStore(dir, () => t);
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.setComments("t1", { copy: { "0": "too long" } });
    const { note, typed } = s.checkReject("t1", { note: "Wrong page." });
    s.recordReject("t1", note, typed);
    const sent: string[] = [];
    const send = async (text: string) => (sent.push(text), true);
    t += REVERT_HOLD_MS - 1;
    expect(await sendDueReverts(s, send)).toEqual([]);
    // Undo inside the window: no request went, the item waits, the typed note comes back, the history drops it.
    const u = s.undo("t1");
    expect([signoffState(u.item), u.note, sent.length, s.history().length]).toEqual(["waiting", "Wrong page.", 0, 0]);
    expect(await sendDueReverts(s, send)).toEqual([]);

    // Reject again; the held request survives a restart and goes when due.
    s.recordReject("t1", note, typed);
    t += REVERT_HOLD_MS;
    const again = new SignoffStore(dir, () => t);
    expect(await sendDueReverts(again, send)).toEqual(["t1"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toStartWith("/isomux-main revert t1 (aaaaaaa1): ");
    expect(sent[0]).toContain("too long");
    expect(() => again.undo("t1")).toThrow(ValidationError);
    expect(signoffState(again.get("t1")!)).toBe("rejected");
    expect(await sendDueReverts(again, send)).toEqual([]);
    expect(again.reverted("t1", { commit: "ccccccc3" }).removed).toBe(true);
  });

  test("a revert request that fails is tried again later and can still be undone; one on its way cannot", async () => {
    let t = 1000;
    const s = new SignoffStore(tempDir(), () => t);
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.recordReject("t1", "no");
    t += REVERT_HOLD_MS;
    expect(await sendDueReverts(s, async () => false)).toEqual([]);
    expect(s.get("t1")!.decision!.revert).toMatchObject({ due: t + REVERT_RETRY_MS, error: expect.any(String) });
    expect(s.dueReverts()).toEqual([]);
    t += REVERT_RETRY_MS;
    expect(signoffState(s.undo("t1").item)).toBe("waiting");
    s.recordReject("t1", "no");
    t += REVERT_HOLD_MS;
    // An undo while the message is in flight is refused, and the request completes.
    let refused = false;
    const out = await sendDueReverts(s, async () => {
      try {
        s.undo("t1");
      } catch (err) {
        refused = err instanceof ValidationError;
      }
      return true;
    });
    expect([out, refused, signoffState(s.get("t1")!)]).toEqual([["t1"], true, "rejected"]);
    expect(s.get("t1")!.decision!.revert).toMatchObject({ sent: t });
  });

  test("a rejection stored before the hold was sent then: it is neither sent again nor undone", async () => {
    const dir = tempDir();
    const s = new SignoffStore(dir);
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.recordReject("t1", "no");
    const file = join(dir, "signoff.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.items.t1.decision.revert;
    delete raw.items.t1.decision.typed;
    writeFileSync(file, JSON.stringify(raw));
    const old = new SignoffStore(dir, () => Date.now() + 10 * REVERT_HOLD_MS);
    let sent = 0;
    expect(await sendDueReverts(old, async () => (sent++, true))).toEqual([]);
    expect(sent).toBe(0);
    expect(() => old.undo("t1")).toThrow(ValidationError);
  });

  // An office stub for the Sign-off changes task: its reads and patches.
  function editsBoard(task: Partial<Task> | "unreadable", patchStatus = 200) {
    const patches: { id: string; body: Record<string, unknown> }[] = [];
    const t: Task = { id: "ed1", title: "[go | ready] Sign-off changes: Docs line", description: "Nil's note: shorter", status: "open", createdAt: 1, version: "v1", ...(task === "unreadable" ? {} : task) };
    const office: Pick<Office, "task" | "patchTask"> = {
      async task(id) {
        if (task === "unreadable" || id !== "ed1") throw new Error("GET answered 500");
        return { ...t };
      },
      async patchTask(id, body): Promise<PatchResult> {
        patches.push({ id, body });
        return patchStatus === 200 ? { ok: true, task: { ...t, ...body } as Task } : { ok: false, status: patchStatus };
      },
    };
    return { office, patches };
  }
  function approvedWithEdits() {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.approve("t1", "ed1", "shorter");
    return s;
  }

  test("undo of an approval closes its unstarted Sign-off changes task as obsolete, with the reason first", async () => {
    const s = approvedWithEdits();
    const { office, patches } = editsBoard({});
    const out = await undoDecision(s, office, "t1", "2026-10-24");
    expect([signoffState(out.item), out.note, out.edits?.closed]).toEqual(["waiting", "shorter", true]);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ id: "ed1", body: { version: "v1", status: "obsolete" } });
    const d = String(patches[0].body.description);
    expect(d.indexOf("t1")).toBeLessThan(d.indexOf("Nil's note: shorter"));
    expect(d).toEndWith("Nil's note: shorter");
  });

  test("undo of an approval keeps a Sign-off changes task a worker has, and says why", async () => {
    const cases: [Partial<Task>, string][] = [
      [{ assignee: "Isomux Worker 2", status: "in_progress" }, "Isomux Worker 2"],
      [{ title: "[go | merging] Sign-off changes: Docs line" }, "worker"],
      [{ status: "in_progress" }, "worker"],
      [{ status: "done" }, "done"],
    ];
    for (const [task, why] of cases) {
      const s = approvedWithEdits();
      const { office, patches } = editsBoard(task);
      const out = await undoDecision(s, office, "t1", "2026-10-24");
      expect([signoffState(out.item), out.edits?.id, out.edits?.closed, patches.length]).toEqual(["waiting", "ed1", false, 0]);
      expect(out.edits!.why).toContain(why);
    }
    // Its merge was reported: kept, also while the board still shows it open.
    const s = approvedWithEdits();
    s.merged("ed1", { commit: "bbbbbbb2" });
    const { office, patches } = editsBoard({});
    expect((await undoDecision(s, office, "t1", "2026-10-24")).edits).toMatchObject({ closed: false });
    expect(patches).toHaveLength(0);
  });

  test("undo of an approval changes nothing when the board cannot read or close its Sign-off changes task", async () => {
    for (const [task, status] of [["unreadable", 200], [{}, 409]] as const) {
      const s = approvedWithEdits();
      const { office } = editsBoard(task, status);
      await expect(undoDecision(s, office, "t1", "2026-10-24")).rejects.toThrow(ValidationError);
      expect(signoffState(s.get("t1")!)).toBe("approved");
      expect(s.history()).toHaveLength(1);
    }
  });

  test("undo of a plain approval or a held rejection does not touch the board", async () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    const { office, patches } = editsBoard("unreadable");
    s.approve("t1");
    expect((await undoDecision(s, office, "t1", "2026-10-24")).edits).toBeNull();
    s.recordReject("t1", "no");
    expect(signoffState((await undoDecision(s, office, "t1", "2026-10-24")).item)).toBe("waiting");
    expect(patches).toHaveLength(0);
  });

  test("comments: per entry, validated, and only while the item waits", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    expect(() => s.setComments("t1", { copy: { "3": "x" } })).toThrow(ValidationError);
    expect(s.setComments("t1", { copy: { "0": " shorter " }, images: {} }).comments).toEqual({ copy: { "0": "shorter" }, images: {} });
    expect(s.commentLines(s.get("t1")!, false)).toEqual(["docs/features.md: shorter"]);
    s.approve("t1");
    expect(() => s.setComments("t1", { copy: { "0": "y" } })).toThrow(ValidationError);
  });

  test("approve with comments: approved with its Sign-off changes task, which the push waits for", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    expect(s.checkApprove("t1").filesTask).toBe(false);
    s.setComments("t1", { copy: { "0": '"Agents ask on the Asks page."' } });
    expect(s.checkApprove("t1").filesTask).toBe(true);
    const a = s.approve("t1", "ed1");
    expect([signoffState(a), a.decision!.edits]).toEqual(["approved", "ed1"]);
    expect(s.pushCheck()).toMatchObject({ ok: false, sha: null });
    expect(s.pushCheck().reason).toContain("ed1");
    expect(s.pushCheck((id) => id === "ed1")).toMatchObject({ ok: true, reason: "", sha: "aaaaaaa1", approved: ["t1"] });
    s.recordPushGo("aaaaaaa1");
    expect(s.visible()).toEqual([]);
  });

  test("approve with a note: it files a Sign-off changes task with the note word for word, and the history keeps it", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    // No note and no comments: a plain approval, also without a body.
    expect(s.checkApprove("t1")).toMatchObject({ note: "", filesTask: false });
    expect(s.checkApprove("t1", { note: "   " })).toMatchObject({ note: "", filesTask: false });
    expect(() => s.checkApprove("t1", { note: 5 })).toThrow(ValidationError);
    const note = "Fine for now.\nLater: the whole page reads like a manual; cut it by half.";
    const check = s.checkApprove("t1", { note: "  " + note + "\n" });
    expect([check.note, check.filesTask]).toEqual([note, true]);
    const description = s.editsDescription(check.item, check.note, "2026-10-23");
    expect(description).toContain(note);
    expect(description).toContain("aaaaaaa1");
    s.approve("t1", "ed1", check.note);
    expect(s.history().map((h) => [h.taskId, h.approved, h.note, h.edits])).toEqual([["t1", true, note, "ed1"]]);
  });

  test("a rejection note carries the comments", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.setComments("t1", { copy: { "0": "too long" } });
    expect(s.checkReject("t1", { note: "Wrong page." })).toMatchObject({ note: "Wrong page. Comments: docs/features.md: too long", typed: "Wrong page." });
  });

  test("before/after pairs: one image per side, named pairs only on sign-off, one comment per pair", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    expect(s.addImage("t1", PNG, "old", "Asks page", "before")).toMatchObject({ pair: "Asks page", side: "before" });
    expect(() => s.addImage("t1", PNG, "", "Asks page", "before")).toThrow(ValidationError);
    expect(() => s.addImage("t1", PNG, "", "Asks page", "middle")).toThrow(ValidationError);
    expect(() => s.addImage("t1", PNG, "", "<b>", "after")).toThrow(ValidationError);
    s.addImage("t1", PNG, "new", "Asks page", "after");
    s.addImage("t1", PNG, "lone");
    s.setComments("t1", { images: { "0": "too much padding" } });
    expect(s.commentLines(s.get("t1")!, false)).toEqual(['screenshots "Asks page" (before and after): too much padding']);
  });

  test("a pair's one field: a suggestion or comment on either image is on its first image, also in data saved before", () => {
    const dir = tempDir();
    const s = new SignoffStore(dir);
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.addImage("t1", PNG, "lone");
    s.addImage("t1", PNG, "old", "Asks page", "before");
    s.addImage("t1", PNG, "new", "Asks page", "after");
    s.setScout("t1", { verdict: "look", reason: "x", suggestions: { images: { "0": "crop", "2": "too much padding" } } });
    expect(s.get("t1")!.scout!.suggestions.images).toEqual({ "0": "crop", "1": "too much padding" });
    s.setComments("t1", { images: { "1": "a", "2": "b" } });
    expect(s.get("t1")!.comments!.images).toEqual({ "1": "a\nb" });
    // An item saved with the after image's index, as before the fold.
    const file = join(dir, "signoff.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.items.t1.scout.suggestions.images = { "2": "too much padding" };
    raw.items.t1.comments.images = { "2": "b" };
    writeFileSync(file, JSON.stringify(raw));
    const again = new SignoffStore(dir).get("t1")!;
    expect([again.scout!.suggestions.images, again.comments!.images]).toEqual([{ "1": "too much padding" }, { "1": "b" }]);
  });
});
