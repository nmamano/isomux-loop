import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sniff } from "../src/images";
import { NOTE_ONLY, PacketStore, packetState } from "../src/packets";
import { guessAudience, SignoffStore, signoffState, withAudience } from "../src/signoff";
import { ValidationError } from "../src/store";
import { tempDir } from "./tmp";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const task = { title: "Pick a layout", priority: "P1" };
const packet = (over: Record<string, unknown> = {}) => ({
  taskId: "abc12345",
  question: "Which layout?",
  options: [
    { label: "Grid", cost: "1 day", recommended: true },
    { label: "List", cost: "2 h" },
  ],
  body: "## Findings\n- one",
  ...over,
});

describe("packets", () => {
  test("a packet takes 2-4 options, at most one recommended, no reserved labels", () => {
    const s = new PacketStore(tempDir());
    expect(() => s.put(packet({ options: [{ label: "A" }] }), task)).toThrow(ValidationError);
    expect(() => s.put(packet({ options: [{ label: "A", recommended: true }, { label: "B", recommended: true }] }), task)).toThrow(ValidationError);
    expect(() => s.put(packet({ options: [{ label: "A" }, { label: "obsolete" }] }), task)).toThrow(ValidationError);
    expect(() => s.put(packet({ diffUrl: "javascript:alert(1)" }), task)).toThrow(ValidationError);
    expect(s.put(packet(), task).title).toBe("Pick a layout");
  });

  test("a decision names an option, obsolete, research more, or no option with a note", () => {
    const dir = tempDir();
    const s = new PacketStore(dir, () => 7);
    s.put(packet(), task);
    expect(() => s.decide("abc12345", { choice: "Table" })).toThrow(ValidationError);
    expect(() => s.decide("abc12345", { choice: "rescope", note: "smaller" })).toThrow(ValidationError);
    expect(() => s.decide("abc12345", { choice: NOTE_ONLY, note: " " })).toThrow(ValidationError);
    s.decide("abc12345", { choice: NOTE_ONLY, note: "smaller" });
    // A decision stored as rescope before 2026-10-19 reads as no option, note kept.
    const file = join(dir, "packets.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.abc12345.decision.choice = "rescope";
    writeFileSync(file, JSON.stringify(raw));
    expect(new PacketStore(dir).get("abc12345")!.decision).toMatchObject({ choice: NOTE_ONLY, note: "smaller" });
    expect(s.decide("abc12345", { choice: "research more" }).decision!.choice).toBe("research more");
    expect(s.decide("abc12345", { choice: "List", note: "cheaper" }).decision).toEqual({ choice: "List", note: "cheaper", decidedAt: 7 });
    expect(s.pending().map((p) => p.taskId)).toEqual(["abc12345"]);
    expect(s.markApplied("abc12345", 6, true)).toBe(false);
    expect(s.markApplied("abc12345", 7, true)).toBe(true);
    expect(packetState(s.get("abc12345")!)).toBe("applied");
  });

  test("undo: before and after the apply; a report of an undone decision still counts", () => {
    let t = 1;
    const s = new PacketStore(tempDir(), () => t++);
    s.put(packet(), task);
    s.decide("abc12345", { choice: "Grid" });
    const at = s.get("abc12345")!.decision!.decidedAt;
    s.undo("abc12345");
    expect(packetState(s.get("abc12345")!)).toBe("open");
    expect(s.markApplied("abc12345", at, true)).toBe(true);
    expect([packetState(s.get("abc12345")!), typeof s.get("abc12345")!.reopenedAt]).toEqual(["open", "number"]);
    s.decide("abc12345", { choice: "List" });
    s.markApplied("abc12345", s.get("abc12345")!.decision!.decidedAt, true);
    expect([packetState(s.get("abc12345")!), s.get("abc12345")!.reopenedAt]).toEqual(["applied", undefined]);
    s.undo("abc12345");
    expect([packetState(s.get("abc12345")!), typeof s.get("abc12345")!.reopenedAt]).toEqual(["open", "number"]);
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

  test("a new packet replaces the old one, its decision and its images", () => {
    const dir = tempDir();
    const s = new PacketStore(dir);
    s.put(packet(), task);
    s.addImage("abc12345", PNG, "before");
    s.decide("abc12345", { choice: "Grid" });
    expect(existsSync(join(dir, "images", "packets", "abc12345", "1.png"))).toBe(true);
    const again = s.put(packet({ question: "Which layout, now?" }), task);
    expect([again.decision, again.images.length]).toEqual([null, 0]);
    expect(existsSync(join(dir, "images", "packets", "abc12345", "1.png"))).toBe(false);
    expect(new PacketStore(dir).get("abc12345")!.question).toBe("Which layout, now?");
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

  test("an approval can be undone; a rejection cannot", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.approve("t1");
    expect(signoffState(s.undo("t1"))).toBe("waiting");
    s.recordReject("t1", "no");
    expect(() => s.undo("t1")).toThrow(ValidationError);
    expect(() => s.approve("t1")).toThrow(ValidationError);
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

  test("approve with comments: approved with its edits task, does not block the push, cannot be undone", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    expect(s.checkApprove("t1").hasComments).toBe(false);
    s.setComments("t1", { copy: { "0": '"Agents ask on the Asks page."' } });
    expect(s.checkApprove("t1").hasComments).toBe(true);
    const a = s.approve("t1", "ed1");
    expect([signoffState(a), a.decision!.edits]).toEqual(["approved", "ed1"]);
    expect(() => s.undo("t1")).toThrow(ValidationError);
    expect(s.pushCheck()).toMatchObject({ ok: true, reason: "", sha: "aaaaaaa1", approved: ["t1"] });
    s.recordPushGo("aaaaaaa1");
    expect(s.visible()).toEqual([]);
  });

  test("a rejection note carries the comments", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.merged("t1", { commit: "aaaaaaa1" });
    s.setComments("t1", { copy: { "0": "too long" } });
    expect(s.checkReject("t1", { note: "Wrong page." }).note).toBe("Wrong page. Comments: docs/features.md: too long");
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
});
