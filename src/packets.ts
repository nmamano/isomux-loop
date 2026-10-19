// Design packets: a worker's question to Nil with 2-4 options. A packet shows
// as a card in Triage; Nil's choice goes to the curator in the same burst as
// triage decisions, and the curator writes it to the board.

import { join } from "node:path";
import { checkTaskId, ImageDir, type Image } from "./images";
import { readJson, writeJson } from "./json-file";
import { ValidationError } from "./store";

export const EXTRA_CHOICES = ["rescope", "obsolete", "research more"] as const;

export type Option = { label: string; cost: string; recommended: boolean };
export type PacketDecision = { choice: string; note: string; decidedAt: number };
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
    this.images = new ImageDir(join(dataDir, "images", "packets"));
  }

  private save(): void {
    writeJson(this.file, this.items);
  }

  // A new packet for a task replaces the old one, its images and its decision.
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
      };
    });
    const labels = options.map((o) => o.label);
    if (new Set(labels).size !== labels.length) throw new ValidationError("option labels must differ");
    if (labels.some((l) => (EXTRA_CHOICES as readonly string[]).includes(l)))
      throw new ValidationError(`an option label may not be ${EXTRA_CHOICES.join(", ")}`);
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
      images: [],
      createdAt: this.now(),
      decision: null,
      applied: null,
    };
    this.images.clear(taskId);
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

  decide(taskId: string, raw: unknown): Packet {
    const p = this.items[taskId];
    if (!p) throw new ValidationError("unknown packet");
    if (packetState(p) === "applied") throw new ValidationError("already applied");
    const r = (raw ?? {}) as Record<string, unknown>;
    const choice = text(r.choice, "choice", 200);
    const note = text(r.note, "note", 4000, false);
    if (!p.options.some((o) => o.label === choice) && !(EXTRA_CHOICES as readonly string[]).includes(choice))
      throw new ValidationError("choice must be one of the options, rescope, obsolete or research more");
    if (choice === "rescope" && !note.trim()) throw new ValidationError("a rescope needs a note with the new scope");
    p.decision = { choice, note, decidedAt: this.now() };
    p.applied = null;
    this.save();
    return p;
  }

  undo(taskId: string): Packet {
    const p = this.items[taskId];
    if (!p) throw new ValidationError("unknown packet");
    if (packetState(p) === "applied") throw new ValidationError("already applied");
    p.decision = null;
    p.applied = null;
    this.save();
    return p;
  }

  pending(): Packet[] {
    return this.list().filter((p) => ["decided", "failed"].includes(packetState(p)));
  }

  // Same contract as the triage store: decidedAt must match the current decision.
  markApplied(taskId: string, decidedAt: number, ok: boolean, error?: string): boolean {
    const p = this.items[taskId];
    if (!p?.decision || p.decision.decidedAt !== decidedAt) return false;
    p.applied = { at: this.now(), ok, error, decidedAt };
    this.save();
    return true;
  }
}
