// Constants of this office's loop (design: isomux internal-docs/continuous-loop-design.md).

export const OFFICE = "http://localhost:4000";
export const ROOM_ID = "e6818e47";
// The loop uses Workers 1..N; Nil sets N on the status page (1 to MAX_WORKERS).
export const WORKER_NAMES = [1, 2, 3, 4, 5, 6].map((n) => `Isomux Worker ${n}`);
export const MAX_WORKERS = WORKER_NAMES.length;
export const DEFAULT_WORKERS = 2;
export const MAIN_NAME = "Isomux Main";
// Reads each merged sign-off item and predicts Nil's decision (Nil, 2026-10-21).
export const SCOUT_NAME = "Isomux Sign-off Scout";

export const DISPATCH_MS = 2 * 60_000;
export const TICK_MS = 60 * 60_000;
// Nil decides in bursts; the curator hears once he has paused this long.
export const TRIAGE_QUIET_MS = 3 * 60_000;
// How often the app looks for open tasks the curator has not proposed yet.
export const CLASSIFY_MS = 10 * 60_000;
// An unproposed task is announced again after this long.
export const CLASSIFY_REMIND_MS = 60 * 60_000;
// The status view reads the board at most this often.
export const STATUS_CACHE_MS = 20_000;
