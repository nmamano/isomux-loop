// The 5-hour guard (Nil, 2026-11-06, board task 90892a6e): the 5-hour usage
// window can lock out the agents that talk to Nil, so the loop must never
// reach 100%. Every few minutes the app reads the window; when its use runs
// ahead of its time, it lowers the worker count (dispatch only, as POST
// /api/settings workers does: no worker loses its task), and after the
// reset it puts back the count it saved. Each change goes to its log, which
// the status page shows.

import { join } from "node:path";
import { readJson, writeJson } from "./json-file";
import type { UsageReading } from "./office";

// At SLOW_PERCENT with more than SLOW_LEFT_MS to the reset: SLOW_WORKERS.
// At STOP_PERCENT, whatever is left: STOP_WORKERS.
export const SLOW_PERCENT = 75;
export const SLOW_LEFT_MS = 60 * 60_000;
export const SLOW_WORKERS = 2;
export const STOP_PERCENT = 90;
export const STOP_WORKERS = 1;
const LOG_MAX = 30;
const NEW_WINDOW_MS = 30 * 60_000;

export type Window = { usedPercent: number; resetsAtMs: number | null };

// The 5-hour window of a reading, or null.
export function fiveHour(r: UsageReading): Window | null {
  if (!r.available) return null;
  return r.windows.find((w) => /5.?h/i.test(w.label)) ?? null;
}

// The worker count the window allows, or null when it allows any.
export function cap(w: Window, now: number): number | null {
  if (w.usedPercent >= STOP_PERCENT) return STOP_WORKERS;
  const left = w.resetsAtMs === null ? Infinity : w.resetsAtMs - now;
  if (w.usedPercent >= SLOW_PERCENT && left > SLOW_LEFT_MS) return SLOW_WORKERS;
  return null;
}

// saved: the count before the guard lowered it; to: what it set; until: the
// reset of the window it lowered for.
type Lowered = { saved: number; to: number; until: number | null };
export type GuardLog = { at: number; from: number; to: number; why: string };
type State = { lowered: Lowered | null; log: GuardLog[] };

export type GuardRun = { at: number; usedPercent?: number; resetsAtMs?: number | null; set?: number; error?: string };

export class UsageGuard {
  private file: string;
  private state: State;

  constructor(dataDir: string) {
    this.file = join(dataDir, "usage-guard.json");
    this.state = readJson<State>(this.file, { lowered: null, log: [] });
  }

  get lowered(): Lowered | null {
    return this.state.lowered;
  }

  get log(): GuardLog[] {
    return this.state.log;
  }

  // One step: the worker count to set, or null for no change. workers is the
  // count now. A count someone set by hand since the guard lowered it wins:
  // the guard forgets its saved count and does not put it back.
  step(w: Window | null, workers: number, now: number): { set: number; why: string } | null {
    // A reading of a window whose reset has passed is stale: it says nothing.
    if (w && w.resetsAtMs !== null && w.resetsAtMs <= now) w = null;
    const low = this.state.lowered;
    if (low && workers !== low.to) {
      this.state.lowered = null;
      this.save();
      return null;
    }
    if (low) {
      // The window it lowered for is over: its reset time passed, or the
      // reading is of a later window (a margin, since reset times jitter).
      // A window with no reset time ends when its use falls below SLOW_PERCENT.
      const over =
        low.until !== null
          ? now >= low.until || (w !== null && w.resetsAtMs !== null && w.resetsAtMs > low.until + NEW_WINDOW_MS)
          : w !== null && w.usedPercent < SLOW_PERCENT;
      if (over) {
        this.state.lowered = null;
        return this.change(workers, low.saved, now, "the 5-hour window reset");
      }
    }
    if (!w) return null;
    const c = cap(w, now);
    if (c === null || c >= workers) return null;
    this.state.lowered = { saved: low ? low.saved : workers, to: c, until: w.resetsAtMs };
    const left = w.resetsAtMs === null ? "" : `, ${Math.round((w.resetsAtMs - now) / 60_000)} min to its reset`;
    return this.change(workers, c, now, `the 5-hour window is at ${w.usedPercent}%${left}`);
  }

  private change(from: number, to: number, at: number, why: string): { set: number; why: string } {
    this.state.log = [...this.state.log, { at, from, to, why }].slice(-LOG_MAX);
    this.save();
    return { set: to, why };
  }

  private save(): void {
    writeJson(this.file, this.state);
  }
}
