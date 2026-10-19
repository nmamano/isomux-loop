// Triage state for the continuous loop (isomux internal-docs/continuous-loop-design.md).
// The curator pushes proposals, Nil decides in the page, the curator applies
// each decision to the board and reports back. The app never touches the board.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const;
// Nil, 2026-10-18: no taste class. A proposal stored before that may still say
// taste; the page shows it as decide.
export const CLASSES = ["auto", "decide", "authority"] as const;
export const OUTCOMES = ["keep", "rescope", "obsolete"] as const;

export type Priority = (typeof PRIORITIES)[number];
export type TaskClass = (typeof CLASSES)[number] | "taste";
export type Outcome = (typeof OUTCOMES)[number];

export type TaskSnapshot = {
  title: string;
  description: string;
  priority: Priority | null;
  createdBy: string;
  createdAt: number;
};

export type ProposalBody = {
  priority: Priority;
  class: TaskClass;
  outcome: Outcome;
  // For a rescope: the new title (without the tag) and the new description.
  title?: string;
  scope?: string;
  why: string;
};

export type Decision = {
  priority: Priority;
  class: TaskClass;
  outcome: Outcome;
  note: string;
  decidedAt: number;
};

export type Applied = { at: number; ok: boolean; error?: string; decidedAt: number };

export type Item = {
  taskId: string;
  task: TaskSnapshot;
  proposal: ProposalBody;
  proposedAt: number;
  decision: Decision | null;
  applied: Applied | null;
};

export type ItemState = "open" | "decided" | "applied" | "failed";

export function itemState(item: Item): ItemState {
  if (!item.decision) return "open";
  const a = item.applied;
  if (a && a.decidedAt === item.decision.decidedAt) return a.ok ? "applied" : "failed";
  return "decided";
}

type State = {
  items: Record<string, Item>;
  notify: { lastDecisionAt: number; lastSentAt: number };
};

export class ValidationError extends Error {}

function str(v: unknown, field: string, max: number, optional = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    throw new ValidationError(`${field} is required`);
  }
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string`);
  if (v.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return v;
}

function oneOf<T extends string>(v: unknown, list: readonly T[], field: string): T {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v))
    throw new ValidationError(`${field} must be one of ${list.join(", ")}`);
  return v as T;
}

export function parseProposal(raw: unknown): Pick<Item, "taskId" | "task" | "proposal"> {
  if (!raw || typeof raw !== "object") throw new ValidationError("proposal must be an object");
  const r = raw as Record<string, unknown>;
  const taskId = str(r.taskId, "taskId", 64)!;
  const t = (r.task ?? {}) as Record<string, unknown>;
  const p = (r.proposal ?? {}) as Record<string, unknown>;
  const createdAt = Number(t.createdAt);
  const task: TaskSnapshot = {
    title: str(t.title, "task.title", 500)!,
    description: str(t.description, "task.description", 20000, true) ?? "",
    priority: t.priority == null ? null : oneOf(t.priority, PRIORITIES, "task.priority"),
    createdBy: str(t.createdBy, "task.createdBy", 200, true) ?? "",
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
  const outcome = oneOf(p.outcome, OUTCOMES, "proposal.outcome");
  const proposal: ProposalBody = {
    priority: oneOf(p.priority, PRIORITIES, "proposal.priority"),
    class: oneOf(p.class, CLASSES, "proposal.class"),
    outcome,
    title: str(p.title, "proposal.title", 500, true),
    scope: str(p.scope, "proposal.scope", 20000, true),
    why: str(p.why, "proposal.why", 2000)!,
  };
  if (outcome === "rescope" && !proposal.title && !proposal.scope)
    throw new ValidationError("a rescope needs proposal.title or proposal.scope");
  return { taskId, task, proposal };
}

export class Store {
  private state: State;
  private file: string;

  constructor(
    dataDir: string,
    private now: () => number = Date.now,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "triage.json");
    this.state = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, "utf8")) as State)
      : { items: {}, notify: { lastDecisionAt: 0, lastSentAt: 0 } };
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.file);
  }

  list(filter?: ItemState | "all"): Item[] {
    const all = Object.values(this.state.items);
    const picked = !filter || filter === "all" ? all : all.filter((i) => itemState(i) === filter);
    // Higher proposed priority first, then the oldest task.
    return picked.sort(
      (a, b) =>
        a.proposal.priority.localeCompare(b.proposal.priority) ||
        a.task.createdAt - b.task.createdAt,
    );
  }

  get(taskId: string): Item | undefined {
    return this.state.items[taskId];
  }

  counts(): Record<ItemState, number> {
    const c: Record<ItemState, number> = { open: 0, decided: 0, applied: 0, failed: 0 };
    for (const i of Object.values(this.state.items)) c[itemState(i)]++;
    return c;
  }

  // Upsert from the curator. A decision that is not applied yet is Nil's and
  // is never overwritten; an applied item may get a fresh proposal (a change
  // of direction), which reopens it.
  // Nil, 2026-10-19: a P4 (backlog) task gets a card only to promote it, so a
  // proposal that keeps a P4 task at P4 is refused, not stored.
  propose(raws: unknown[]): { created: string[]; updated: string[]; skipped: string[]; refused: string[] } {
    const parsed = raws.map(parseProposal);
    const out = { created: [] as string[], updated: [] as string[], skipped: [] as string[], refused: [] as string[] };
    const at = this.now();
    for (const p of parsed) {
      if (p.task.priority === "P4" && p.proposal.priority === "P4") {
        out.refused.push(p.taskId);
        continue;
      }
      const existing = this.state.items[p.taskId];
      if (existing && existing.decision && itemState(existing) !== "applied") {
        out.skipped.push(p.taskId);
        continue;
      }
      this.state.items[p.taskId] = { ...p, proposedAt: at, decision: null, applied: null };
      (existing ? out.updated : out.created).push(p.taskId);
    }
    this.save();
    return out;
  }

  withdraw(taskId: string): boolean {
    if (!this.state.items[taskId]) return false;
    delete this.state.items[taskId];
    this.save();
    return true;
  }

  decide(taskId: string, raw: unknown): Item {
    const item = this.state.items[taskId];
    if (!item) throw new ValidationError("unknown task");
    if (itemState(item) === "applied") throw new ValidationError("already applied");
    const r = (raw ?? {}) as Record<string, unknown>;
    const at = this.now();
    item.decision = {
      priority: oneOf(r.priority, PRIORITIES, "priority"),
      class: oneOf(r.class, CLASSES, "class"),
      outcome: oneOf(r.outcome, OUTCOMES, "outcome"),
      note: str(r.note, "note", 4000, true) ?? "",
      decidedAt: at,
    };
    item.applied = null;
    this.state.notify.lastDecisionAt = at;
    this.save();
    return item;
  }

  undo(taskId: string): Item {
    const item = this.state.items[taskId];
    if (!item) throw new ValidationError("unknown task");
    if (itemState(item) === "applied") throw new ValidationError("already applied");
    item.decision = null;
    item.applied = null;
    this.save();
    return item;
  }

  // Decisions the curator still has to write to the board, failed ones included.
  pending(): Item[] {
    return this.list("all").filter((i) => {
      const s = itemState(i);
      return s === "decided" || s === "failed";
    });
  }

  // The curator reports per task. decidedAt must match the current decision,
  // so a decision Nil changed after the curator read it stays pending.
  markApplied(raws: unknown[]): { recorded: string[]; stale: string[] } {
    const out = { recorded: [] as string[], stale: [] as string[] };
    const at = this.now();
    for (const raw of raws) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const taskId = str(r.taskId, "taskId", 64)!;
      const decidedAt = Number(r.decidedAt);
      const item = this.state.items[taskId];
      if (!item?.decision || item.decision.decidedAt !== decidedAt) {
        out.stale.push(taskId);
        continue;
      }
      item.applied = {
        at,
        ok: r.ok !== false,
        error: str(r.error, "error", 2000, true),
        decidedAt,
      };
      out.recorded.push(taskId);
    }
    this.save();
    return out;
  }

  // A packet decision counts toward the same burst as triage decisions.
  noteDecision(at: number): void {
    this.state.notify.lastDecisionAt = at;
    this.save();
  }

  // One message per burst of decisions: once Nil has been quiet for quietMs
  // and nothing was sent since his last decision. otherPending: packet
  // decisions waiting for the curator.
  shouldNotify(quietMs: number, otherPending = 0): boolean {
    const n = this.state.notify;
    return (
      this.pending().length + otherPending > 0 &&
      n.lastDecisionAt > n.lastSentAt &&
      this.now() - n.lastDecisionAt >= quietMs
    );
  }

  markNotified(): void {
    this.state.notify.lastSentAt = this.now();
    this.save();
  }
}
