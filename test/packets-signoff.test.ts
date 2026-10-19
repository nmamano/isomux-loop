import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sniff } from "../src/images";
import { PacketStore, packetState } from "../src/packets";
import { SignoffStore, signoffState } from "../src/signoff";
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

  test("a decision names an option or rescope/obsolete/research more; rescope needs a note", () => {
    const s = new PacketStore(tempDir(), () => 7);
    s.put(packet(), task);
    expect(() => s.decide("abc12345", { choice: "Table" })).toThrow(ValidationError);
    expect(() => s.decide("abc12345", { choice: "rescope" })).toThrow(ValidationError);
    expect(s.decide("abc12345", { choice: "research more" }).decision!.choice).toBe("research more");
    expect(s.decide("abc12345", { choice: "List", note: "cheaper" }).decision).toEqual({ choice: "List", note: "cheaper", decidedAt: 7 });
    expect(s.pending().map((p) => p.taskId)).toEqual(["abc12345"]);
    expect(s.markApplied("abc12345", 6, true)).toBe(false);
    expect(s.markApplied("abc12345", 7, true)).toBe(true);
    expect(packetState(s.get("abc12345")!)).toBe("applied");
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

  test("push go waits for every decision and every revert, then removes the approved items", () => {
    const s = new SignoffStore(tempDir());
    s.put(item);
    s.put({ ...item, taskId: "t2" });
    s.merged("t1", { commit: "aaaaaaa1" });
    s.merged("t2", { commit: "bbbbbbb2" });
    expect(s.pushCheck().ok).toBe(false);
    s.approve("t1");
    expect(() => s.checkReject("t2", { note: " " })).toThrow(ValidationError);
    s.recordReject("t2", "wrong tone");
    expect(s.pushCheck()).toMatchObject({ ok: false });
    expect(() => s.put({ ...item, taskId: "t2" })).toThrow(ValidationError);
    expect(s.reverted("t2", { commit: "ccccccc3" })).toEqual({ removed: true });
    const check = s.pushCheck();
    expect(check).toEqual({ ok: true, reason: "", sha: "ccccccc3", approved: ["t1"] });
    s.recordPushGo(check.sha!);
    expect(s.visible()).toEqual([]);
    expect(s.pushCheck().ok).toBe(false);
    s.merged("t3", { commit: "ddddddd4" });
    expect(s.pushCheck()).toMatchObject({ ok: true, sha: "ddddddd4", approved: [] });
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
    expect(s.pushCheck()).toEqual({ ok: true, reason: "", sha: "aaaaaaa1", approved: ["t1"] });
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
