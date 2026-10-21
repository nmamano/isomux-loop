// Design packets: a worker's question to Nil with 2-4 options. A packet shows
// as a card in Triage; Nil's choice goes to the curator in the same burst as
// triage decisions, and the curator writes it to the board.
//
// Nil, 2026-10-20: a packet is decided like a triage card, with the same
// choice (go, design, hold, backlog, obsolete), priority and note. The
// worker's options are presets: each sets a choice and fills the note.

import { join } from "node:path";
import { checkTaskId, ImageDir, type Image } from "./images";
import { readJson, writeJson } from "./json-file";
import { type Choice, CHOICES, choiceAndPriority, DECISIONS, type DecisionChoice, decisionNote, type LoopPriority, LOOP_PRIORITIES, ValidationError } from "./store";

export type Option = { label: string; cost: string; recommended: boolean; decision: Choice; note: string };
// preset: the option Nil picked to fill the choice and the note, if any.
export type PacketDecision = { choice: DecisionChoice; priority: LoopPriority | null; note: string; preset?: string; decidedAt: number };
export type Packet = {
  taskId: string;
  title: string;
  priority: string | null;
  question: string;
  options: Option[];
  body: string;
  branch?: string;
  diffUrl?: string;
  images: Image[];
  createdAt: number;
  decision: PacketDecision | null;
  applied: { at: number; ok: boolean; error?: string; decidedAt: number } | null;
  // As for triage cards (store.ts): the undone decision, and reopenedAt.
  undone?: PacketDecision | null;
  reopenedAt?: number;
};
export type PacketState = "open" | "decided" | "applied" | "failed";

export function packetState(p: Packet): PacketState {
  if (!p.decision) return "open";
  const a = p.applied;
  if (a && a.decidedAt === p.decision.decidedAt) return a.ok ? "applied" : "failed";
  return "decided";
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

function oneOf<T extends string>(v: unknown, list: readonly T[], field: string): T {
  if (!(list as readonly unknown[]).includes(v)) throw new ValidationError(`${field} must be one of ${list.join(", ")}`);
  return v as T;
}

// Before 2026-10-20 an option had no choice and a decision named an option,
// "obsolete", "research more", "none: see note" or "rescope". An option reads
// as go, or obsolete when its label says close; its label is its note.
const CLOSE_LABEL = /^(?:[A-D][.:)]\s*)?(?:close|obsolete|do not build|don't build|don't ship|do nothing|leave as is)\b/i;
function migrate(p: Packet): boolean {
  let changed = false;
  for (const o of p.options) {
    if (o.decision) continue;
    o.decision = CLOSE_LABEL.test(o.label) ? "obsolete" : "go";
    o.note = o.label;
    changed = true;
  }
  const priority = (LOOP_PRIORITIES as readonly unknown[]).includes(p.priority) ? (p.priority as LoopPriority) : null;
  for (const d of [p.decision, p.undone]) {
    if (!d || (DECISIONS as readonly string[]).includes(d.choice)) continue;
    const old = d.choice as string;
    const o = p.options.find((x) => x.label === old);
    if (o) {
      d.choice = o.decision;
      d.note = d.note ? o.note + "\n\n" + d.note : o.note;
      d.preset = o.label;
    } else d.choice = old === "obsolete" ? "obsolete" : "design";
    d.priority = d.choice === "go" || d.choice === "design" || d.choice === "hold" ? priority : null;
    changed = true;
  }
  return changed;
}

export class PacketStore {
  private file: string;
  private items: Record<string, Packet>;
  readonly images: ImageDir;

  constructor(
    dataDir: string,
    private now: () => number = Date.now,
  ) {
    this.file = join(dataDir, "packets.json");
    this.items = readJson<Record<string, Packet>>(this.file, {});
    if (Object.values(this.items).map(migrate).some(Boolean)) this.save();
    this.images = new ImageDir(join(dataDir, "images", "packets"));
  }

  private save(): void {
    writeJson(this.file, this.items);
  }

  // A new packet for a task replaces the old one and its decision. It keeps
  // the old images (Nil, 2026-10-20: a rewrite re-posts the packet) unless
  // the body says "clearImages": true.
  put(raw: unknown, task: { title: string; priority: string | null }): Packet {
    const r = (raw ?? {}) as Record<string, unknown>;
    const taskId = checkTaskId(text(r.taskId, "taskId", 64));
    if (!Array.isArray(r.options) || r.options.length < 2 || r.options.length > 4)
      throw new ValidationError("options must hold 2 to 4 entries");
    const options: Option[] = r.options.map((o, n) => {
      const x = (o ?? {}) as Record<string, unknown>;
      return {
        label: text(x.label, `options[${n}].label`, 200),
        cost: text(x.cost, `options[${n}].cost`, 1000, false),
        recommended: x.recommended === true,
        decision: oneOf(x.decision, CHOICES, `options[${n}].decision`),
        note: text(x.note, `options[${n}].note`, 4000, false) || text(x.label, `options[${n}].label`, 200),
      };
    });
    const labels = options.map((o) => o.label);
    if (new Set(labels).size !== labels.length) throw new ValidationError("option labels must differ");
    if (options.filter((o) => o.recommended).length > 1) throw new ValidationError("at most one option is recommended");
    const diffUrl = text(r.diffUrl, "diffUrl", 1000, false);
    if (diffUrl && !/^https?:\/\//.test(diffUrl)) throw new ValidationError("diffUrl must be an http(s) URL");
    const packet: Packet = {
      taskId,
      title: task.title,
      priority: task.priority,
      question: text(r.question, "question", 4000),
      options,
      body: text(r.body, "body", 500_000, false),
      branch: text(r.branch, "branch", 300, false) || undefined,
      diffUrl: diffUrl || undefined,
      images: r.clearImages === true ? [] : (this.items[taskId]?.images ?? []),
      createdAt: this.now(),
      decision: null,
      applied: null,
    };
    if (r.clearImages === true || !this.items[taskId]) this.images.clear(taskId);
    this.items[taskId] = packet;
    this.save();
    return packet;
  }

  addImage(taskId: string, bytes: Uint8Array, caption: string): Image {
    const p = this.items[taskId];
    if (!p) throw new ValidationError("no packet for this task");
    const img = this.images.save(taskId, p.images, bytes, caption);
    p.images.push(img);
    this.save();
    return img;
  }

  get(taskId: string): Packet | undefined {
    return this.items[taskId];
  }

  list(): Packet[] {
    return Object.values(this.items).sort(
      (a, b) => (a.priority ?? "P9").localeCompare(b.priority ?? "P9") || a.createdAt - b.createdAt,
    );
  }

  // The task closed before Nil decided: the packet leaves Triage.
  withdraw(taskId: string): boolean {
    if (!this.items[taskId]) return false;
    delete this.items[taskId];
    this.images.clear(taskId);
    this.save();
    return true;
  }

  // The curator takes a packet out of Triage (Nil answered it elsewhere).
  // A decision that waits for the curator is never dropped this way.
  remove(taskId: string): "removed" | "not_found" | "pending" {
    const p = this.items[taskId];
    if (!p) return "not_found";
    if (["decided", "failed"].includes(packetState(p))) return "pending";
    this.withdraw(taskId);
    return "removed";
  }

  decide(taskId: string, raw: unknown): Packet {
    const p = this.items[taskId];
    if (!p) throw new ValidationError("unknown packet");
    if (packetState(p) === "applied") throw new ValidationError("already applied");
    const r = (raw ?? {}) as Record<string, unknown>;
    const { choice, priority } = choiceAndPriority(r, DECISIONS);
    const note = decisionNote(choice, r.note);
    // A go on a packet without a note names no design.
    if (choice === "go" && !note.trim()) throw new ValidationError("go needs a note: the design to build (pick an option to fill it)");
    const preset = p.options.find((o) => o.label === r.preset)?.label;
    p.decision = { choice, priority, note, ...(preset ? { preset } : {}), decidedAt: this.now() };
    p.applied = null;
    this.save();
    return p;
  }

  // Undo puts the packet back in Triage, also after the curator applied it.
  undo(taskId: string): Packet {
    const p = this.items[taskId];
    if (!p) throw new ValidationError("unknown packet");
    if (!p.decision) throw new ValidationError("nothing to undo");
    if (packetState(p) === "applied") p.reopenedAt = this.now();
    p.undone = p.decision;
    p.decision = null;
    this.save();
    return p;
  }

  pending(): Packet[] {
    return this.list().filter((p) => ["decided", "failed"].includes(packetState(p)));
  }

  // Same contract as the triage store: decidedAt must match the current decision.
  markApplied(taskId: string, decidedAt: number, ok: boolean, error?: string): boolean {
    const p = this.items[taskId];
    if (p && !p.decision && p.undone?.decidedAt === decidedAt) {
      p.applied = { at: this.now(), ok, error, decidedAt };
      p.reopenedAt = this.now();
      this.save();
      return true;
    }
    if (!p?.decision || p.decision.decidedAt !== decidedAt) return false;
    delete p.reopenedAt;
    p.applied = { at: this.now(), ok, error, decidedAt };
    this.save();
    return true;
  }
}
