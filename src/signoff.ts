// Sign-off before the push: a worker posts the copy and visible changes of a
// task at hand-off, Isomux Main marks it merged, and Nil approves or rejects
// it here. Only merged items show. A rejection asks Main for a revert; the
// item stays until Main reports the revert. The revert request waits
// REVERT_HOLD_MS first, so Nil can undo the rejection (Nil, 2026-10-24).

import { join } from "node:path";
import { REVERT_HOLD_MS, REVERT_RETRY_MS } from "./config";
import { checkTaskId, ImageDir, type Image } from "./images";
import { readJson, writeJson } from "./json-file";
import type { Office, Task } from "./office";
import { ValidationError } from "./store";

// audience (Nil, 2026-10-20): "member" for what a person reads (UI, site,
// docs, emails, GitHub comments), "agent" for what agents read (system
// prompt, agent reference, skills, API errors, logs). Without it the app
// guesses from where, and says so (guessed).
export type Audience = "member" | "agent";
export type CopyEntry = { where: string; old: string; new: string; audience?: Audience; guessed?: boolean };

// Member paths first (a UI file about skills is still UI), then agent ones.
const MEMBER_WHERE = /(^|[\/\s])(ui|site|docs)\/|shared\/i18n/i;
const AGENT_WHERE = /system-prompt|agent-reference|\bskills?\b|SKILL\.md/i;
export function guessAudience(where: string): Audience {
  return !MEMBER_WHERE.test(where) && AGENT_WHERE.test(where) ? "agent" : "member";
}
// An entry stored before audiences existed gets the guess when it is read.
export function withAudience(c: CopyEntry): CopyEntry {
  return c.audience ? c : { ...c, audience: guessAudience(c.where), guessed: true };
}
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
  // seq: the merge's place in Main's report order (missing on older items).
  merged: { commit: string; at: number; seq?: number } | null;
  // edits: the Sign-off changes task an approval with comments filed (Nil,
  // 2026-10-19: approve and request edits are one case, approved with 0 or
  // more edits). editsMerged: when Main reported that task's merge.
  // typed: what Nil wrote in the note (a rejection's note adds his comments).
  // revert: a rejection's request to Main, held until due; sent when Main got
  // it. A rejection stored before the hold has none: it was sent at once.
  decision: {
    approved: boolean;
    note: string;
    typed?: string;
    at: number;
    edits?: string;
    editsMerged?: number;
    revert?: { due: number; sent?: number; error?: string };
  } | null;
  reverted: { commit: string; at: number } | null;
  scout?: Scout;
};
export type SignoffState = "unmerged" | "waiting" | "approved" | "rejected";

// Isomux Sign-off Scout's prediction (Nil, 2026-10-21): stamp = he approves
// as is, look = normal review, pushback = something seems off. Suggestions
// are comments he may write, by entry index; the page never fills a field.
export const VERDICTS = ["stamp", "look", "pushback"] as const;
export type Scout = {
  verdict: (typeof VERDICTS)[number];
  reason: string;
  suggestions: Comments;
  at: number;
};
// One of Nil's sign-off decisions with the Scout's verdict, kept after the
// item leaves the list, so the Scout can compare.
export type PastDecision = {
  taskId: string;
  title: string;
  commit: string;
  approved: boolean;
  note: string;
  comments: Comments;
  edits?: string;
  scout: Scout | null;
  at: number;
};
const HISTORY_MAX = 300;

type State = {
  items: Record<string, SignoffItem>;
  // The main sha from Main's latest merged or reverted call, and the last one
  // Nil gave a push go for.
  lastSha: { commit: string; at: number } | null;
  lastPushGo: { commit: string; at: number } | null;
  // Every merge Main reported that is not pushed yet, by task (an item or
  // not), and every sha Main reported since the last push, in order: a push
  // of one sha takes everything reported up to it (Nil, 2026-10-19).
  unpushed?: Record<string, { commit: string; at: number; seq: number }>;
  shas?: { commit: string; seq: number }[];
  seq?: number;
  // A rejected merge and its revert (Nil, 2026-10-20): a push point between
  // them would ship the merge without its revert.
  spans?: { from: number; to: number }[];
  history?: PastDecision[];
};

export type PushCheck = {
  ok: boolean;
  reason: string;
  // The push point: the newest reported sha with every item merged at or
  // before it approved (or nothing to sign off), and not inside a span.
  sha: string | null;
  seq: number | null;
  approved: string[];
  // Every merge the push point takes, item or not.
  tasks: string[];
  // Distinct commits Main reported (merges and reverts) up to the push point,
  // and all of them since the last push. A task with no code is reported with
  // the main sha of the time, so it adds no commit.
  commits: number;
  unpushedCommits: number;
  // Items that hold the push point back, oldest first: it stays before them.
  // "edits": approved with comments, and its Sign-off changes task (edits) is
  // neither merged nor closed (Nil, 2026-10-21: a "remove this before it
  // ships" comment must not go out with the next push).
  blockers: { taskId: string; state: "waiting" | "rejected" | "edits"; seq: number; edits?: string }[];
};

export function signoffState(i: SignoffItem): SignoffState {
  if (!i.merged) return "unmerged";
  if (!i.decision) return "waiting";
  return i.decision.approved ? "approved" : "rejected";
}

// A before/after pair has one comment field, on its first image: a comment or
// suggestion keyed on either image of the pair moves there (both texts, if
// both images have one).
export function onPairFirst(images: Image[], byIndex: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(byIndex)) {
    const im = images[Number(k)];
    const key = im?.pair ? String(images.findIndex((x) => x.pair === im.pair)) : k;
    out[key] = out[key] ? out[key] + "\n" + t : t;
  }
  return out;
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

// A short sha matches its long form either way.
function sameSha(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
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

  // resolve: a reported sha to the full sha of a commit in main's repository,
  // or null when it names none (Isomux PM, 2026-10-27: a wrong short sha
  // became an unresolvable push point).
  constructor(
    dataDir: string,
    private now: () => number = Date.now,
    private resolve: (sha: string) => string | null = (sha) => sha,
  ) {
    this.file = join(dataDir, "signoff.json");
    this.state = readJson<State>(this.file, { items: {}, lastSha: null, lastPushGo: null });
    this.images = new ImageDir(join(dataDir, "images", "signoff"));
    if (!this.state.unpushed) this.seedUnpushed();
    // Keys stored before the fold below (Nil, 2026-10-23: a suggestion on a
    // pair's after image showed in no field).
    for (const i of Object.values(this.state.items)) {
      if (i.comments) i.comments.images = onPairFirst(i.images, i.comments.images);
      if (i.scout) i.scout.suggestions.images = onPairFirst(i.images, i.scout.suggestions.images);
    }
  }

  // Data from before the push record: merged items that are not rejected,
  // then Main's last sha, count as not pushed.
  private seedUnpushed(): void {
    this.state.unpushed = {};
    this.state.shas = [];
    this.state.seq = 0;
    for (const i of this.visible())
      if (signoffState(i) !== "rejected") this.record(i.taskId, i.merged!.commit, i.merged!.at);
    if (this.state.lastSha) this.state.shas.push({ commit: this.state.lastSha.commit, seq: ++this.state.seq });
    this.save();
  }

  private record(taskId: string | null, commit: string, at: number): void {
    const seq = (this.state.seq = (this.state.seq ?? 0) + 1);
    if (taskId) this.state.unpushed![taskId] = { commit, at, seq };
    this.state.shas!.push({ commit, seq });
  }

  // Task ids merged and not pushed yet.
  unpushedIds(): Set<string> {
    return new Set(Object.keys(this.state.unpushed ?? {}));
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
        if (x.audience !== undefined && x.audience !== "member" && x.audience !== "agent")
          throw new ValidationError(`copy[${n}].audience must be member or agent`);
        return withAudience({
          where: text(x.where, `copy[${n}].where`, 500),
          old: text(x.old, `copy[${n}].old`, 100_000, false),
          new: text(x.new, `copy[${n}].new`, 100_000),
          ...(x.audience ? { audience: x.audience as Audience } : {}),
        });
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

  private resolved(raw: unknown): string {
    const sha = commitOf(raw);
    const full = this.resolve(sha);
    if (!full) throw new ValidationError(`commit ${sha} is not a commit in main's repository; report the sha git rev-parse gives`);
    return full;
  }

  // Main calls this after every merge, with or without an item: the sha is
  // what a push go names.
  merged(taskId: string, raw: unknown): { signoff: boolean } {
    checkTaskId(taskId);
    const commit = this.resolved(raw);
    const i = this.state.items[taskId];
    const u = this.state.unpushed?.[taskId];
    if (u && sameSha(u.commit, commit)) {
      // The same merge reported again (an item posted after the first
      // report): it keeps its place in push order.
      if (i && signoffState(i) !== "rejected") i.merged = { commit: u.commit, at: u.at, seq: u.seq };
      this.save();
      return { signoff: Boolean(i) };
    }
    const at = this.now();
    this.state.lastSha = { commit, at };
    this.record(taskId, commit, at);
    // A re-merge (after a red CI, say) moves the item to the new commit.
    if (i && signoffState(i) !== "rejected") i.merged = { commit, at, seq: this.state.seq };
    // This merge may be the Sign-off changes task an approval waits for.
    for (const x of Object.values(this.state.items)) if (x.decision?.edits === taskId && !x.decision.editsMerged) x.decision.editsMerged = at;
    this.save();
    return { signoff: Boolean(i) };
  }

  reverted(taskId: string, raw: unknown): { removed: boolean } {
    checkTaskId(taskId);
    const commit = this.resolved(raw);
    this.state.lastSha = { commit, at: this.now() };
    // The revert commit goes out with the next push; the task itself left
    // main and goes back to ready.
    const i = this.state.items[taskId];
    const removed = Boolean(i && signoffState(i) === "rejected");
    const from = removed ? this.itemSeq(i!) : null;
    this.record(null, commit, this.now());
    if (from !== null) (this.state.spans ??= []).push({ from, to: this.state.seq! });
    delete this.state.unpushed![taskId];
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
    i.comments = { copy: pick(r.copy, i.copy.length, "copy entry"), images: onPairFirst(i.images, pick(r.images, i.images.length, "image")) };
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

  // Approve. With comments or a note (Nil, 2026-10-23: his notes must never be
  // lost) the caller files a Sign-off changes task first and passes its id; the
  // push waits until that task is merged or closed.
  checkApprove(taskId: string, raw?: unknown): { item: SignoffItem; note: string; filesTask: boolean } {
    const i = this.mergedItem(taskId);
    if (signoffState(i) !== "waiting") throw new ValidationError("only an item that waits for you can be approved");
    const note = text((raw as Record<string, unknown> | null)?.note, "note", 4000, false).trim();
    return { item: i, note, filesTask: Boolean(note) || this.commentLines(i, false).length > 0 };
  }

  // The Sign-off changes task's description: Nil's note word for word, then his comments.
  editsDescription(i: SignoffItem, note: string, day: string): string {
    return [
      `Changes Nil asked for when he approved this at sign-off in the loop app (${day}): copy, or anything else he commented on. The push waits for this task: the merged commit does not go out until this task is merged or closed. The changes come as their own commit with their own sign-off item.`,
      `Source task: ${i.taskId}. Merged commit: ${i.merged!.commit}.`,
      "",
      "Rule: Nil's quoted text goes in verbatim; for a note, make the change it asks for and create a sign-off item for it.",
      ...(note ? ["", "Nil's note (written in the note field when he approved):", note] : []),
      "",
      ...this.commentLines(i, true),
    ].join("\n");
  }

  approve(taskId: string, editsTaskId?: string, note = ""): SignoffItem {
    const i = this.mergedItem(taskId);
    if (signoffState(i) !== "waiting") throw new ValidationError("only an item that waits for you can be approved");
    i.decision = { approved: true, note, at: this.now(), ...(editsTaskId ? { edits: editsTaskId } : {}) };
    this.remember(i);
    this.save();
    return i;
  }

  // A Sign-off changes task filed by hand for an approved item (Isomux
  // Curator, 2026-10-21): the push waits for it as for one Approve filed.
  linkEdits(taskId: string, editsTaskId: string): SignoffItem {
    const i = this.mergedItem(taskId);
    checkTaskId(editsTaskId);
    if (signoffState(i) !== "approved") throw new ValidationError("only an approved item takes a Sign-off changes task");
    if (i.decision!.edits) throw new ValidationError(`the item already waits for ${i.decision!.edits}`);
    if (editsTaskId === taskId) throw new ValidationError("an item cannot wait for its own task");
    i.decision = { ...i.decision!, edits: editsTaskId };
    const past = (this.state.history ?? []).find((x) => x.taskId === taskId && x.at === i.decision!.at);
    if (past) past.edits = editsTaskId;
    this.save();
    return i;
  }

  // Checks only; the caller messages Main and then records the rejection.
  checkReject(taskId: string, raw: unknown): { item: SignoffItem; note: string; typed: string } {
    const i = this.mergedItem(taskId);
    if (signoffState(i) !== "waiting") throw new ValidationError("only an item that waits for you can be rejected");
    const typed = text((raw as Record<string, unknown> | null)?.note, "note", 4000).trim();
    if (!typed) throw new ValidationError("a rejection needs a note");
    const comments = this.commentLines(i, false);
    return { item: i, note: comments.length ? `${typed} Comments: ${comments.join("; ")}` : typed, typed };
  }

  // The revert request waits REVERT_HOLD_MS (sendDueReverts sends it).
  recordReject(taskId: string, note: string, typed = note): SignoffItem {
    const i = this.mergedItem(taskId);
    const at = this.now();
    i.decision = { approved: false, note, typed, at, revert: { due: at + REVERT_HOLD_MS } };
    this.remember(i);
    this.save();
    return i;
  }

  // Nil's decision, with the Scout's verdict, into the history (newest last).
  private remember(i: SignoffItem): void {
    const h = (this.state.history ??= []);
    h.push({
      taskId: i.taskId,
      title: i.title,
      commit: i.merged!.commit,
      approved: i.decision!.approved,
      note: i.decision!.note,
      comments: i.comments ?? { copy: {}, images: {} },
      ...(i.decision!.edits ? { edits: i.decision!.edits } : {}),
      scout: i.scout ?? null,
      at: i.decision!.at,
    });
    if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
  }

  // Newest first.
  history(limit = 50): PastDecision[] {
    return [...(this.state.history ?? [])].reverse().slice(0, Math.max(1, Math.min(HISTORY_MAX, limit)));
  }

  // The Scout's verdict on a merged item; a new one replaces the old.
  setScout(taskId: string, raw: unknown): SignoffItem {
    const i = this.mergedItem(taskId);
    const r = (raw ?? {}) as Record<string, unknown>;
    if (!(VERDICTS as readonly unknown[]).includes(r.verdict)) throw new ValidationError(`verdict must be one of ${VERDICTS.join(", ")}`);
    const reason = text(r.reason, "reason", 300).trim();
    const s = (r.suggestions ?? {}) as Record<string, unknown>;
    const pick = (kind: "copy" | "images", count: number): Record<string, string> => {
      const v = (s[kind] ?? {}) as Record<string, unknown>;
      if (typeof v !== "object" || Array.isArray(v)) throw new ValidationError(`suggestions.${kind} must be an object by entry index`);
      const out: Record<string, string> = {};
      for (const [k, x] of Object.entries(v)) {
        if (!/^\d+$/.test(k) || Number(k) >= count) throw new ValidationError(`suggestions.${kind}.${k}: no such entry`);
        const t = text(x, `suggestions.${kind}.${k}`, 2000, false).trim();
        if (t) out[k] = t;
      }
      return out;
    };
    i.scout = { verdict: r.verdict as Scout["verdict"], reason, suggestions: { copy: pick("copy", i.copy.length), images: onPairFirst(i.images, pick("images", i.images.length)) }, at: this.now() };
    this.save();
    return i;
  }

  // Checks only (an approval, or a rejection whose revert Main has not got).
  checkUndo(taskId: string): SignoffItem {
    const i = this.mergedItem(taskId);
    const st = signoffState(i);
    if (st === "rejected") {
      const r = i.decision!.revert;
      if (!r || r.sent || this.sending.has(taskId)) throw new ValidationError("Isomux Main has the revert request already; this rejection cannot be undone");
    } else if (st !== "approved") throw new ValidationError("only an approval or a rejection can be undone");
    return i;
  }

  // The item waits for Nil again; the note comes back for his field. A
  // filed Sign-off changes task is the caller's (undoDecision).
  undo(taskId: string): { item: SignoffItem; note: string } {
    const i = this.checkUndo(taskId);
    // An undone decision leaves the history: it was not his decision after all.
    const h = this.state.history ?? [];
    const at = h.map((x) => x.taskId === taskId && x.at === i.decision!.at).lastIndexOf(true);
    if (at >= 0) h.splice(at, 1);
    const note = i.decision!.typed ?? i.decision!.note;
    i.decision = null;
    this.save();
    return { item: i, note };
  }

  // Rejections whose revert request is due, and not on its way.
  dueReverts(): SignoffItem[] {
    const now = this.now();
    return this.visible().filter((i) => {
      const r = i.decision?.approved === false ? i.decision.revert : undefined;
      return r && !r.sent && r.due <= now && !this.sending.has(i.taskId);
    });
  }

  // The message to Main for a rejection.
  revertText(i: SignoffItem): string {
    return `/isomux-main revert ${i.taskId} (${i.merged!.commit}): Nil rejected it at sign-off: ${i.decision!.note}`;
  }

  // In memory only: after a restart mid-send the request goes again (a
  // repeated revert request is safer than a lost one).
  private sending = new Set<string>();
  revertSending(taskId: string, on: boolean): void {
    if (on) this.sending.add(taskId);
    else this.sending.delete(taskId);
  }

  // Main got the request, or it failed and is tried again REVERT_RETRY_MS later.
  revertResult(taskId: string, error: string | null): void {
    const r = this.state.items[taskId]?.decision?.revert;
    if (!r) return;
    if (error) Object.assign(r, { due: this.now() + REVERT_RETRY_MS, error });
    else {
      r.sent = this.now();
      delete r.error;
    }
    this.save();
  }

  // An item's merge in report order. Items from before seq existed: their
  // task's unpushed entry, else their commit in the sha list, else 0, which
  // holds every later merge back (the safe side).
  private itemSeq(i: SignoffItem): number {
    if (i.merged?.seq !== undefined) return i.merged.seq;
    const u = this.state.unpushed?.[i.taskId];
    if (u && i.merged && u.commit === i.merged.commit) return u.seq;
    const s = (this.state.shas ?? []).find((x) => i.merged && sameSha(x.commit, i.merged.commit));
    return s ? s.seq : 0;
  }
  private shaSeq(commit: string | undefined): number | undefined {
    if (!commit) return undefined;
    return [...(this.state.shas ?? [])].reverse().find((x) => sameSha(x.commit, commit))?.seq;
  }

  // Main is linear, so a push is "everything up to sha X" (Nil, 2026-10-20):
  // push along the way, up to the first item that still waits for Nil (or
  // for its revert). Later merges wait for the next push.
  // closed: whether the board says a task is done or obsolete (or gone); the
  // caller reads the board. Unknown (no reader) counts as open: the safe side.
  pushCheck(closed: (taskId: string) => boolean = () => false): PushCheck {
    const editsOpen = (i: SignoffItem) =>
      signoffState(i) === "approved" && Boolean(i.decision!.edits) && !i.decision!.editsMerged && !closed(i.decision!.edits!);
    const blockers: PushCheck["blockers"] = this.visible()
      .filter((i) => ["waiting", "rejected"].includes(signoffState(i)) || editsOpen(i))
      .map((i) =>
        editsOpen(i)
          ? { taskId: i.taskId, state: "edits" as const, seq: this.itemSeq(i), edits: i.decision!.edits }
          : { taskId: i.taskId, state: signoffState(i) as "waiting" | "rejected", seq: this.itemSeq(i) },
      )
      .sort((a, b) => a.seq - b.seq);
    const limit = blockers.length ? blockers[0].seq : Infinity;
    const spans = this.state.spans ?? [];
    const best = (this.state.shas ?? [])
      .filter((x) => x.seq < limit && !spans.some((sp) => sp.from <= x.seq && x.seq < sp.to))
      .reduce<{ commit: string; seq: number } | null>((a, b) => (!a || b.seq > a.seq ? b : a), null);
    const seq = best ? best.seq : null;
    const tasks = seq === null ? [] : Object.entries(this.state.unpushed ?? {}).filter(([, u]) => u.seq <= seq).sort((a, b) => a[1].seq - b[1].seq).map(([id]) => id);
    const approved = this.visible().filter((i) => signoffState(i) === "approved" && seq !== null && this.itemSeq(i) <= seq).map((i) => i.taskId);
    const distinct = (xs: { commit: string }[]) => xs.filter((x, k) => !xs.slice(0, k).some((y) => sameSha(x.commit, y.commit))).length;
    const shas = this.state.shas ?? [];
    const commits = seq === null ? 0 : distinct(shas.filter((x) => x.seq <= seq));
    const goSeq = this.shaSeq(this.state.lastPushGo?.commit);
    const b = blockers[0];
    let reason = "";
    if (!this.state.lastSha) reason = "Isomux Main has reported no merge yet";
    else if (seq === null)
      reason = b
        ? b.state === "rejected"
          ? `rejected ${b.taskId} waits for its revert`
          : b.state === "edits"
            ? `${b.taskId} waits for its Sign-off changes task ${b.edits} to merge`
            : `${b.taskId}, the oldest item, waits for your approve or reject`
        : "nothing new to push";
    else if (goSeq !== undefined && goSeq >= seq) reason = `the push go for ${best!.commit.slice(0, 8)} is sent; it waits for Isomux Main`;
    return { ok: reason === "", reason, sha: best ? best.commit : null, seq, approved, tasks, commits, unpushedCommits: distinct(shas), blockers };
  }

  // After Main got the message: the approved items up to the push point
  // leave the list; later ones wait for the next push.
  recordPushGo(sha: string): void {
    const seq = this.shaSeq(sha) ?? -1;
    for (const i of this.visible()) {
      if (signoffState(i) === "approved" && this.itemSeq(i) <= seq) {
        delete this.state.items[i.taskId];
        this.images.clear(i.taskId);
      }
    }
    this.state.lastPushGo = { commit: sha, at: this.now() };
    this.save();
  }

  // The merges not pushed yet (the diagram's Push stage), oldest first. sent:
  // the last push go included it, so it waits for Main's push report.
  unpushedList(): { taskId: string; commit: string; at: number; seq: number; sent: boolean }[] {
    const go = this.state.lastPushGo?.commit;
    const same = (a: string) => Boolean(go) && (a.startsWith(go!) || go!.startsWith(a));
    const goSeq = [...(this.state.shas ?? [])].reverse().find((x) => same(x.commit))?.seq;
    return Object.entries(this.state.unpushed ?? {})
      .sort((a, b) => a[1].seq - b[1].seq)
      .map(([taskId, u]) => ({ taskId, commit: u.commit, at: u.at, seq: u.seq, sent: goSeq !== undefined && u.seq <= goSeq }));
  }

  // Main pushed this sha: every merge and revert reported up to it is pushed.
  pushed(raw: unknown): { pushed: string[] } {
    const commit = commitOf(raw);
    const same = (a: string) => a.startsWith(commit) || commit.startsWith(a);
    const hit = [...this.state.shas!].reverse().find((x) => same(x.commit));
    if (!hit) throw new ValidationError("no merge or revert reported this commit; push the sha of the push go");
    const out: string[] = [];
    for (const [id, u] of Object.entries(this.state.unpushed!))
      if (u.seq <= hit.seq) {
        delete this.state.unpushed![id];
        out.push(id);
      }
    this.state.shas = this.state.shas!.filter((x) => x.seq > hit.seq);
    this.state.spans = (this.state.spans ?? []).filter((sp) => sp.to > hit.seq);
    this.save();
    return { pushed: out };
  }

  meta(): { lastSha: State["lastSha"]; lastPushGo: State["lastPushGo"] } {
    return { lastSha: this.state.lastSha, lastPushGo: this.state.lastPushGo };
  }
}

// A Sign-off changes task no worker has started: open, no assignee, still
// tagged [go | ready].
export function editsUnstarted(t: Task): boolean {
  return t.status === "open" && !t.assignee && /^\[go \| ready\]/.test(t.title);
}

export type EditsOutcome = { id: string; closed: boolean; why: string };

// Undo of an approval or a rejection (Nil, 2026-10-24). An approval that
// filed a Sign-off changes task closes that task as obsolete if no worker has
// started it; else the task stays and the outcome says why.
export async function undoDecision(
  s: SignoffStore,
  office: Pick<Office, "task" | "patchTask">,
  taskId: string,
  today: string,
): Promise<{ item: SignoffItem; note: string; edits: EditsOutcome | null }> {
  const d = s.checkUndo(taskId).decision!;
  let edits: EditsOutcome | null = null;
  if (d.approved && d.edits) {
    const id = d.edits;
    let t: Task;
    try {
      t = await office.task(id);
    } catch {
      throw new ValidationError(`the board did not give the Sign-off changes task ${id}; nothing was undone`);
    }
    if (["done", "obsolete"].includes(t.status)) edits = { id, closed: false, why: `it is ${t.status} already` };
    else if (d.editsMerged) edits = { id, closed: false, why: "Isomux Main merged it" };
    else if (!editsUnstarted(t)) edits = { id, closed: false, why: t.assignee ? `${t.assignee} has it` : "a worker started it" };
    else {
      const reason = `Obsolete (${today}): Nil undid the approval of ${taskId} at sign-off, so these changes are not asked for. His note and comments are back on the item's sign-off card.`;
      const res = await office.patchTask(id, { version: t.version, status: "obsolete", description: `${reason}\n\n${t.description ?? ""}`.trimEnd() });
      if (!res.ok) throw new ValidationError(`the board refused to close the Sign-off changes task ${id} (${res.status}); nothing was undone`);
      edits = { id, closed: true, why: "no worker had started it" };
    }
  }
  return { ...s.undo(taskId), edits };
}

// Sends each due revert request to Main (sendDueReverts runs every few seconds).
export async function sendDueReverts(s: SignoffStore, message: (text: string) => Promise<boolean>): Promise<string[]> {
  const sent: string[] = [];
  for (const i of s.dueReverts()) {
    s.revertSending(i.taskId, true);
    let error: string | null = null;
    try {
      if (!(await message(s.revertText(i)))) error = "the message to Isomux Main failed";
    } catch (err) {
      error = String(err instanceof Error ? err.message : err);
    } finally {
      s.revertSending(i.taskId, false);
    }
    s.revertResult(i.taskId, error);
    if (!error) sent.push(i.taskId);
  }
  return sent;
}
