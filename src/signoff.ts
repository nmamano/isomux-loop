// Sign-off before the push: a worker posts the copy and visible changes of a
// task at hand-off, Isomux Main marks it merged, and Nil approves or rejects
// it here. Only merged items show. A rejection asks Main for a revert; the
// item stays until Main reports the revert.

import { join } from "node:path";
import { checkTaskId, ImageDir, type Image } from "./images";
import { readJson, writeJson } from "./json-file";
import { ValidationError } from "./store";

export type CopyEntry = { where: string; old: string; new: string };
export type SignoffItem = {
  taskId: string;
  title: string;
  summary: string;
  copy: CopyEntry[];
  images: Image[];
  postedAt: number;
  merged: { commit: string; at: number } | null;
  decision: { approved: boolean; note: string; at: number } | null;
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

  addImage(taskId: string, bytes: Uint8Array, caption: string): Image {
    const i = this.state.items[taskId];
    if (!i) throw new ValidationError("no sign-off item for this task");
    const img = this.images.save(taskId, i.images, bytes, caption);
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

  approve(taskId: string): SignoffItem {
    const i = this.mergedItem(taskId);
    if (signoffState(i) === "rejected") throw new ValidationError("already rejected");
    i.decision = { approved: true, note: "", at: this.now() };
    this.save();
    return i;
  }

  // Checks only; the caller messages Main and then records the rejection.
  checkReject(taskId: string, raw: unknown): { item: SignoffItem; note: string } {
    const i = this.mergedItem(taskId);
    if (signoffState(i) === "rejected") throw new ValidationError("already rejected");
    const note = text((raw as Record<string, unknown> | null)?.note, "note", 4000).trim();
    if (!note) throw new ValidationError("a rejection needs a note");
    return { item: i, note };
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
