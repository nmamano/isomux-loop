// Sign-off before the push: a worker posts the copy and visible changes of a
// task at hand-off, Isomux Main marks it merged, and Nil approves or rejects
// it here. Only merged items show. A rejection asks Main for a revert; the
// item stays until Main reports the revert.

import { join } from "node:path";
import { checkTaskId, ImageDir, type Image } from "./images";
import { readJson, writeJson } from "./json-file";
import { ValidationError } from "./store";

export type CopyEntry = { where: string; old: string; new: string };
// Nil's per-entry comments: a note, or the exact new text in quotes.
export type Comments = { copy: Record<string, string>; images: Record<string, string> };
export type SignoffItem = {
  taskId: string;
  title: string;
  summary: string;
  copy: CopyEntry[];
  images: Image[];
  comments?: Comments;
  postedAt: number;
  merged: { commit: string; at: number } | null;
  // edits: the copy-edits task an approval with comments filed (Nil, 2026-10-19:
  // approve and request edits are one case, approved with 0 or more edits).
  decision: { approved: boolean; note: string; at: number; edits?: string } | null;
  reverted: { commit: string; at: number } | null;
};
export type SignoffState = "unmerged" | "waiting" | "approved" | "rejected";

type State = {
  items: Record<string, SignoffItem>;
  // The main sha from Main's latest merged or reverted call, and the last one
  // Nil gave a push go for.
  lastSha: { commit: string; at: number } | null;
  lastPushGo: { commit: string; at: number } | null;
};

export function signoffState(i: SignoffItem): SignoffState {
  if (!i.merged) return "unmerged";
  if (!i.decision) return "waiting";
  return i.decision.approved ? "approved" : "rejected";
}

function text(v: unknown, field: string, max: number, required = true): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ValidationError(`${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string`);
  if (v.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return v;
}

function commitOf(raw: unknown): string {
  const c = text((raw as Record<string, unknown> | null)?.commit, "commit", 64);
  if (!/^[0-9a-f]{7,64}$/.test(c)) throw new ValidationError("commit must be a git sha");
  return c;
}

export class SignoffStore {
  private file: string;
  private state: State;
  readonly images: ImageDir;

  constructor(
    dataDir: string,
    private now: () => number = Date.now,
  ) {
    this.file = join(dataDir, "signoff.json");
    this.state = readJson<State>(this.file, { items: {}, lastSha: null, lastPushGo: null });
    this.images = new ImageDir(join(dataDir, "images", "signoff"));
  }

  private save(): void {
    writeJson(this.file, this.state);
  }

  // A new post replaces the task's item, unless Nil rejected it and Main has
  // not reverted it yet: that revert must happen first.
  put(raw: unknown): SignoffItem {
    const r = (raw ?? {}) as Record<string, unknown>;
    const taskId = checkTaskId(text(r.taskId, "taskId", 64));
    const old = this.state.items[taskId];
    if (old && signoffState(old) === "rejected")
      throw new ValidationError("Nil rejected this task's last item; Isomux Main must report the revert first");
    const copy = r.copy === undefined ? [] : r.copy;
    if (!Array.isArray(copy) || copy.length > 50) throw new ValidationError("copy must be an array of at most 50 entries");
    const item: SignoffItem = {
      taskId,
      title: text(r.title, "title", 500),
      summary: text(r.summary, "summary", 20_000, false),
      copy: copy.map((c, n) => {
        const x = (c ?? {}) as Record<string, unknown>;
        return {
          where: text(x.where, `copy[${n}].where`, 500),
          old: text(x.old, `copy[${n}].old`, 100_000, false),
          new: text(x.new, `copy[${n}].new`, 100_000),
        };
      }),
      images: [],
      postedAt: this.now(),
      merged: null,
      decision: null,
      reverted: null,
    };
    this.images.clear(taskId);
    this.state.items[taskId] = item;
    this.save();
    return item;
  }

  // pair and side are optional: a pair is one before and one after image.
  addImage(taskId: string, bytes: Uint8Array, caption: string, pair?: string | null, side?: string | null): Image {
    const i = this.state.items[taskId];
    if (!i) throw new ValidationError("no sign-off item for this task");
    if (pair || side) {
      if (!pair || !/^[A-Za-z0-9 _.-]{1,60}$/.test(pair)) throw new ValidationError("pair must be a short name (letters, digits, space, _ . -)");
      if (side !== "before" && side !== "after") throw new ValidationError("side must be before or after");
      if (i.images.some((im) => im.pair === pair && im.side === side)) throw new ValidationError(`pair "${pair}" already has its ${side} image`);
    }
    const img = this.images.save(taskId, i.images, bytes, caption);
    if (pair) Object.assign(img, { pair, side });
    i.images.push(img);
    this.save();
    return img;
  }

  // Main calls this after every merge, with or without an item: the sha is
  // what a push go names.
  merged(taskId: string, raw: unknown): { signoff: boolean } {
    checkTaskId(taskId);
    const commit = commitOf(raw);
    const at = this.now();
    this.state.lastSha = { commit, at };
    const i = this.state.items[taskId];
    // A re-merge (after a red CI, say) moves the item to the new commit.
    if (i && signoffState(i) !== "rejected") i.merged = { commit, at };
    this.save();
    return { signoff: Boolean(i) };
  }

  reverted(taskId: string, raw: unknown): { removed: boolean } {
    checkTaskId(taskId);
    const commit = commitOf(raw);
    this.state.lastSha = { commit, at: this.now() };
    const i = this.state.items[taskId];
    const removed = Boolean(i && signoffState(i) === "rejected");
    if (removed) {
      delete this.state.items[taskId];
      this.images.clear(taskId);
    }
    this.save();
    return { removed };
  }

  visible(): SignoffItem[] {
    return Object.values(this.state.items)
      .filter((i) => i.merged)
      .sort((a, b) => a.merged!.at - b.merged!.at);
  }

  get(taskId: string): SignoffItem | undefined {
    return this.state.items[taskId];
  }

  private mergedItem(taskId: string): SignoffItem {
    const i = this.state.items[taskId];
    if (!i || !i.merged) throw new ValidationError("no merged sign-off item for this task");
    return i;
  }

  // Saves Nil's comments as he types; only while the item waits for him.
  setComments(taskId: string, raw: unknown): SignoffItem {
    const i = this.mergedItem(taskId);
    if (signoffState(i) !== "waiting") throw new ValidationError("comments are only for an item that waits for you");
    const r = (raw ?? {}) as Record<string, unknown>;
    const pick = (v: unknown, count: number, what: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [k, t] of Object.entries((v ?? {}) as Record<string, unknown>)) {
        const n = Number(k);
        if (!Number.isInteger(n) || n < 0 || n >= count) throw new ValidationError(`no ${what} ${k}`);
        const s = text(t, `comment on ${what} ${k}`, 4000, false).trim();
        if (s) out[String(n)] = s;
      }
      return out;
    };
    i.comments = { copy: pick(r.copy, i.copy.length, "copy entry"), images: pick(r.images, i.images.length, "image") };
    this.save();
    return i;
  }

  // The comments as plain lines, for the revert note and the edits task.
  commentLines(i: SignoffItem, withCurrent: boolean): string[] {
    const c = i.comments ?? { copy: {}, images: {} };
    const lines: string[] = [];
    i.copy.forEach((e, n) => {
      const note = c.copy[String(n)];
      if (!note) return;
      lines.push(withCurrent ? `- ${e.where}\n  Current text: ${e.new}\n  Nil's comment: ${note}` : `${e.where}: ${note}`);
    });
    i.images.forEach((im, n) => {
      const note = c.images[String(n)];
      if (!note) return;
      // A pair's one comment is kept on its first image.
      const name = im.pair ? `screenshots "${im.pair}" (before and after)` : `image ${n + 1}${im.caption ? ` (${im.caption})` : ""}`;
      lines.push(withCurrent ? `- ${name}\n  Nil's comment: ${note}` : `${name}: ${note}`);
    });
    return lines;
  }

  // Approve. With comments the caller files a copy-edits task first and passes
  // its id; the merged commit still goes out with the next push go.
  checkApprove(taskId: string): { item: SignoffItem; hasComments: boolean } {
    const i = this.mergedItem(taskId);
    if (signoffState(i) !== "waiting") throw new ValidationError("only an item that waits for you can be approved");
    return { item: i, hasComments: this.commentLines(i, false).length > 0 };
  }

  approve(taskId: string, editsTaskId?: string): SignoffItem {
    const i = this.mergedItem(taskId);
    if (signoffState(i) !== "waiting") throw new ValidationError("only an item that waits for you can be approved");
    i.decision = { approved: true, note: "", at: this.now(), ...(editsTaskId ? { edits: editsTaskId } : {}) };
    this.save();
    return i;
  }

  // Checks only; the caller messages Main and then records the rejection.
  checkReject(taskId: string, raw: unknown): { item: SignoffItem; note: string } {
    const i = this.mergedItem(taskId);
    if (signoffState(i) !== "waiting") throw new ValidationError("only an item that waits for you can be rejected");
    const typed = text((raw as Record<string, unknown> | null)?.note, "note", 4000).trim();
    if (!typed) throw new ValidationError("a rejection needs a note");
    const comments = this.commentLines(i, false);
    return { item: i, note: comments.length ? `${typed} Comments: ${comments.join("; ")}` : typed };
  }

  recordReject(taskId: string, note: string): SignoffItem {
    const i = this.mergedItem(taskId);
    i.decision = { approved: false, note, at: this.now() };
    this.save();
    return i;
  }

  undo(taskId: string): SignoffItem {
    const i = this.mergedItem(taskId);
    if (signoffState(i) !== "approved") throw new ValidationError("only an approval can be undone");
    if (i.decision?.edits) throw new ValidationError(`the copy-edits task ${i.decision.edits} is filed; close it on the board instead`);
    i.decision = null;
    this.save();
    return i;
  }

  // Push go: no merged item undecided, no rejection waiting for its revert,
  // and a main sha newer than the last push go.
  pushCheck(): { ok: boolean; reason: string; sha: string | null; approved: string[] } {
    const items = this.visible();
    const approved = items.filter((i) => signoffState(i) === "approved").map((i) => i.taskId);
    const sha = this.state.lastSha?.commit ?? null;
    const waiting = items.filter((i) => signoffState(i) === "waiting").length;
    const rejected = items.filter((i) => signoffState(i) === "rejected").length;
    let reason = "";
    if (waiting) reason = `${waiting} item${waiting === 1 ? "" : "s"} still need${waiting === 1 ? "s" : ""} your approve or reject`;
    else if (rejected) reason = `${rejected} rejected item${rejected === 1 ? "" : "s"} wait${rejected === 1 ? "s" : ""} for Isomux Main's revert`;
    else if (!sha) reason = "Isomux Main has reported no merge yet";
    else if (this.state.lastPushGo?.commit === sha && approved.length === 0) reason = `main ${sha.slice(0, 8)} already has a push go`;
    return { ok: reason === "", reason, sha, approved };
  }

  // After Main got the message: approved items leave the list.
  recordPushGo(sha: string): void {
    for (const i of this.visible()) {
      if (signoffState(i) === "approved") {
        delete this.state.items[i.taskId];
        this.images.clear(i.taskId);
      }
    }
    this.state.lastPushGo = { commit: sha, at: this.now() };
    this.save();
  }

  meta(): { lastSha: State["lastSha"]; lastPushGo: State["lastPushGo"] } {
    return { lastSha: this.state.lastSha, lastPushGo: this.state.lastPushGo };
  }
}
