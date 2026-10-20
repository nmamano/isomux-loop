// Triage state for the continuous loop (isomux internal-docs/continuous-loop-design.md).
// The curator pushes proposals, Nil decides in the page, the curator applies
// each decision to the board and reports back. The app never touches the board.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The board's priorities; P4 is its backlog.
export const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const;
// Nil, 2026-10-19: one field per card instead of class + outcome (and no P4
// priority): go / design / hold take a priority P0-P3 and a tag; backlog
// writes P4 and no tag; obsolete closes the task. A go/design/hold card may
// carry a new title and/or scope, which Nil accepts with it; his note can
// change anything, and the curator applies it with its judgement. Cards
// stored in the old shape are migrated on load.
export const CHOICES = ["go", "design", "hold", "backlog", "obsolete"] as const;
// Nil, 2026-10-20: Nil may also answer rewrite (not a proposal choice): the
// curator rewrites the task as his note asks and proposes it again.
export const DECISIONS = [...CHOICES, "rewrite"] as const;
export const TAGGED = ["go", "design", "hold"] as const;
export const LOOP_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
// The curator's estimate of the work (Nil, 2026-10-20). S: under an hour of
// one worker pair; M: a few hours; L: about a day; XL: multi-day, split it.
export const EFFORTS = ["S", "M", "L", "XL"] as const;
export type Effort = (typeof EFFORTS)[number];

export type Priority = (typeof PRIORITIES)[number];
export type LoopPriority = (typeof LOOP_PRIORITIES)[number];
export type Choice = (typeof CHOICES)[number];
export type DecisionChoice = (typeof DECISIONS)[number];
export const tagged = (c: string) => (TAGGED as readonly string[]).includes(c);

export type TaskSnapshot = {
  title: string;
  description: string;
  priority: Priority | null;
  createdBy: string;
  createdAt: number;
};

export type ProposalBody = {
  choice: Choice;
  // P0-P3 for go, design and hold; null for backlog and obsolete.
  priority: LoopPriority | null;
  // Optional: the new title (without the tag) and the new description.
  title?: string;
  scope?: string;
  why: string;
  // Optional for now: cards proposed before 2026-10-20 have none.
  effort?: Effort;
  effortWhy?: string;
};

export type Decision = {
  choice: DecisionChoice;
  priority: LoopPriority | null;
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
  // Undo (Nil, 2026-10-19): the decision Nil took back, so a report from a
  // curator that had already read it still counts; reopenedAt: the card came
  // back to Triage after its decision reached the board, so a closed task
  // (an obsolete decision) does not withdraw it; fromBacklog: Bring in.
  undone?: Decision | null;
  reopenedAt?: number;
  fromBacklog?: boolean;
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
  const choice = oneOf(p.choice, CHOICES, "proposal.choice");
  const proposal: ProposalBody = {
    choice,
    priority: tagged(choice) ? oneOf(p.priority, LOOP_PRIORITIES, "proposal.priority") : null,
    title: str(p.title, "proposal.title", 500, true),
    scope: str(p.scope, "proposal.scope", 20000, true),
    why: str(p.why, "proposal.why", 2000)!,
  };
  if (p.effort != null && p.effort !== "") proposal.effort = oneOf(p.effort, EFFORTS, "proposal.effort");
  const effortWhy = str(p.effortWhy, "proposal.effortWhy", 300, true);
  if (effortWhy) proposal.effortWhy = effortWhy;
  return { taskId, task, proposal };
}

// Cards stored as class + outcome (before 2026-10-19): outcome obsolete is
// obsolete, priority P4 is backlog, else the class under its new name.
const OLD_CLASS: Record<string, Choice> = { auto: "go", decide: "design", taste: "design", authority: "hold", design: "design", hold: "hold" };
export function fromOldShape(x: Record<string, unknown>): void {
  const choice: Choice =
    x.outcome === "obsolete" ? "obsolete" : x.priority === "P4" ? "backlog" : (OLD_CLASS[String(x.class)] ?? "design");
  x.choice = choice;
  x.priority = tagged(choice) && (LOOP_PRIORITIES as readonly unknown[]).includes(x.priority) ? x.priority : null;
  delete x.class;
  delete x.outcome;
}
function migrate(state: State): boolean {
  let changed = false;
  for (const i of Object.values(state.items))
    for (const x of [i.proposal, i.decision] as unknown as (Record<string, unknown> | null)[])
      if (x && !("choice" in x)) {
        fromOldShape(x);
        changed = true;
      }
  return changed;
}

// A decision from the page or the Backlog tab: go/design/hold need P0-P3.
export function choiceAndPriority<T extends string>(r: Record<string, unknown>, allowed: readonly T[]): { choice: T; priority: LoopPriority | null } {
  const choice = oneOf(r.choice, allowed, "choice");
  return { choice, priority: tagged(choice) ? oneOf(r.priority, LOOP_PRIORITIES, "priority") : null };
}

// A rewrite says what to write differently, so it needs a note.
export function decisionNote(choice: string, raw: unknown): string {
  const note = str(raw, "note", 4000, true) ?? "";
  if (choice === "rewrite" && !note.trim()) throw new ValidationError("rewrite needs a note: what to write differently");
  return note;
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
    if (migrate(this.state)) this.save();
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
        (a.proposal.priority ?? "P9").localeCompare(b.proposal.priority ?? "P9") ||
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
  // proposal for a P4 task that is not go, design or hold is refused, not stored.
  propose(raws: unknown[]): { created: string[]; updated: string[]; skipped: string[]; refused: string[] } {
    const parsed = raws.map(parseProposal);
    const out = { created: [] as string[], updated: [] as string[], skipped: [] as string[], refused: [] as string[] };
    const at = this.now();
    for (const p of parsed) {
      if (p.task.priority === "P4" && !tagged(p.proposal.choice)) {
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

  // Nil brings a P4 task in from the Backlog tab: a decided card, sent to the
  // curator like any other triage decision.
  bringIn(task: TaskSnapshot, taskId: string, raw: unknown): Item {
    const existing = this.state.items[taskId];
    if (existing && itemState(existing) !== "applied") throw new ValidationError("this task already has a card");
    const r = (raw ?? {}) as Record<string, unknown>;
    const c = choiceAndPriority(r, TAGGED);
    const at = this.now();
    this.state.items[taskId] = {
      taskId,
      task,
      proposal: { ...c, why: "Nil brought it in from the backlog." },
      proposedAt: at,
      decision: { ...c, note: str(r.note, "note", 4000, true) ?? "", decidedAt: at },
      applied: null,
      fromBacklog: true,
    };
    this.state.notify.lastDecisionAt = at;
    this.save();
    return this.state.items[taskId];
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
    const c = choiceAndPriority(r, DECISIONS);
    item.decision = { ...c, note: decisionNote(c.choice, r.note), decidedAt: at };
    item.applied = null;
    this.state.notify.lastDecisionAt = at;
    this.save();
    return item;
  }

  // Undo puts the card back in Triage, also after the curator applied it: the
  // board keeps that decision until Nil's next one overwrites it. A Bring in
  // that the curator has not applied goes back to the Backlog (no card).
  undo(taskId: string): Item | { withdrawn: true } {
    const item = this.state.items[taskId];
    if (!item) throw new ValidationError("unknown task");
    if (!item.decision) throw new ValidationError("nothing to undo");
    const state = itemState(item);
    if (item.fromBacklog && state !== "applied") {
      delete this.state.items[taskId];
      this.save();
      return { withdrawn: true };
    }
    item.undone = item.decision;
    item.decision = null;
    if (state === "applied") item.reopenedAt = this.now();
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
      // The curator applied a decision Nil undid meanwhile: the board has it,
      // so it counts, and the card stays open as reopened.
      if (item && !item.decision && item.undone?.decidedAt === decidedAt) {
        item.applied = { at, ok: r.ok !== false, error: str(r.error, "error", 2000, true), decidedAt };
        item.reopenedAt = at;
        out.recorded.push(taskId);
        continue;
      }
      if (!item?.decision || item.decision.decidedAt !== decidedAt) {
        out.stale.push(taskId);
        continue;
      }
      delete item.reopenedAt;
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
