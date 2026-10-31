// Constants of this office's loop (design: isomux internal-docs/continuous-loop-design.md).

export const OFFICE = "http://localhost:4000";
export const ROOM_ID = "e6818e47";
// The loop uses Workers 1..N; Nil sets N on the status page (1 to MAX_WORKERS).
export const WORKER_NAMES = [1, 2, 3, 4, 5, 6].map((n) => `Isomux Worker ${n}`);
export const MAX_WORKERS = WORKER_NAMES.length;
export const DEFAULT_WORKERS = 2;
// The priorities the loop dispatches, highest first.
export const LOOP_PRIORITIES = ["P0", "P1", "P2", "P3"];
// The member who decides on the app's pages; a kept mark names him.
export const DECIDER = "Nil";
export const MAIN_NAME = "Isomux Main";
// Main's checkout: a reported merge or revert sha must resolve there.
export const MAIN_REPO = "/home/nil/nil/isomux";
// Reads each merged sign-off item and predicts Nil's decision (Nil, 2026-10-21).
export const SCOUT_NAME = "Isomux Sign-off Scout";

export const DISPATCH_MS = 2 * 60_000;
export const TICK_MS = 60 * 60_000;
// Nil decides in bursts; the curator hears once he has paused this long.
export const TRIAGE_QUIET_MS = 3 * 60_000;
// Untagged P0-P3 triage moved to Antifeed (Nil, 2026-10-28): the curator wake
// no longer announces those tasks. Set true to roll back.
export const ANNOUNCE_UNTAGGED = false;
// The new-task wake-up reads the board this often (new-tasks.ts).
export const NEW_TASKS_MS = 60_000;
// How often the app looks for open tasks the curator has not proposed yet.
export const CLASSIFY_MS = 10 * 60_000;
// An unproposed task is announced again after this long.
export const CLASSIFY_REMIND_MS = 60 * 60_000;
// The status view reads the board at most this often.
export const STATUS_CACHE_MS = 20_000;
// A rejection's revert request waits this long, so Nil can undo it (Nil,
// 2026-10-24); a failed request is tried again after REVERT_RETRY_MS.
export const REVERT_HOLD_MS = 60_000;
export const REVERT_RETRY_MS = 30_000;
