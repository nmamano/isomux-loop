import { ANNOUNCE_UNTAGGED, NEW_TASKS_MS, CLASSIFY_MS, MAIN_REPO, CLASSIFY_REMIND_MS, DISPATCH_MS, MAIN_NAME, ROOM_ID, SCOUT_NAME, STATUS_CACHE_MS, TICK_MS, TRIAGE_QUIET_MS } from "./config";
import { ClosedTimes } from "./closed-times";
import { type ImageDir } from "./images";
import { dispatch, dueIn, offBoard, parseTag, proposalRefusal, staleCards, status, tick, unclassified, unrecommended, wakeText, type DispatchResult, type Status, type TickResult, withdrawLine } from "./loop";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./json-file";
import { httpOffice, type Task } from "./office";
import { page } from "./page";
import { PacketStore, packetState } from "./packets";
import { NewTasks, type NewTasksRun } from "./new-tasks";
import { PauseFlag } from "./pause";
import { type Author, packetAuthor, Returns } from "./returns";
import { sendDueReverts, SignoffStore, signoffState, undoDecision, withAudience } from "./signoff";
import { belowFloor, classify, holdTask, stateViews, type Card, type HoldTask, type StateKey, type StateView } from "./states";
import { itemState, Store, ValidationError, type TaskSnapshot } from "./store";

const port = Number(process.env.PORT);
const dataDir = process.env.ISOMUX_APP_DATA_DIR;
const appToken = process.env.ISOMUX_APP_TOKEN;
if (!Number.isInteger(port) || !dataDir || !appToken)
  throw new Error("required_app_environment_missing");

const local = `http://127.0.0.1:${port}`;
const publicUrl = (process.env.ISOMUX_APP_URL || local).replace(/\/$/, "");

const office = httpOffice(appToken);
const store = new Store(dataDir);
const packets = new PacketStore(dataDir);
// Before the first record (task 8307e0fb): packets posted earlier get their authors once.
const returnsNew = !existsSync(join(dataDir, "returns.json"));
const returns = new Returns(dataDir);
{
  const others = packets.list().filter((p) => packetState(p) === "applied").map((p) => ({ taskId: p.taskId, choice: p.decision!.choice, at: p.applied!.at }));
  const kept = store.backfillKept(others);
  if (kept.length) console.log(`kept marks backfilled: ${kept.length}`);
}
// A full sha, or null when the repository has no such commit.
function resolveSha(sha: string): string | null {
  const r = Bun.spawnSync(["git", "-C", MAIN_REPO, "rev-parse", "--verify", "-q", `${sha}^{commit}`]);
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
}
const signoff = new SignoffStore(dataDir, Date.now, resolveSha);
// Packets posted before the app kept authors get theirs from the task history,
// once; a closed task's record leaves at the next board read.
if (returnsNew)
  void (async () => {
    for (const p of packets.list()) {
      if (returns.get(p.taskId)) continue;
      const t = await office.task(p.taskId).catch(() => null);
      const author = t && (await packetAuthor(t, office));
      if (author) returns.set(p.taskId, author);
    }
  })();
const pause = new PauseFlag(dataDir);
const closed = new ClosedTimes(dataDir, office);

const HELP = `Loop app API. Base: ${local}

Triage (for the curator):
GET  /api/summary                 counts per state
GET  /api/items?state=open|decided|applied|failed|all
POST /api/proposals               {"proposals":[{"taskId","task":{"title","description","priority","createdBy","createdAt"},"proposal":{"choice":"go|design|hold|backlog|obsolete","priority":"P0-P3 (go, design, hold only)","title?","scope?","why",
                                  "effort?":"S|M|L|XL","effortWhy?"}}]}
                                  effort: S under an hour of one worker pair, a file or two; M a few hours; L about a day,
                                  several areas; XL multi-day, should be split. effortWhy: one line.
                                  task.* is the board task as it is now. go, design and hold tag the task [<choice> | <state>] at the
                                  priority; backlog sets P4 and no tag; obsolete closes it. A go/design/hold card may carry a new
                                  proposal.title and/or proposal.scope, which Nil accepts with the card.
                                  An item with a decision not yet applied is skipped; an applied item gets the new proposal and reopens.
                                  A task that is not in the room, or is done or obsolete, refuses the whole request (400, nothing taken).
                                  A P4 (backlog) task gets no card: its proposal, any choice (backlog: keep it at P4), is its
                                  recommendation on the Backlog tab, preselected for Nil, and comes back under "recommended".
                                  A newer one replaces it; it is dropped when a decision on the task is reported applied.
                                  A task Nil kept in the backlog gets none: it comes back under "kept" until its title or
                                  description changes (GET /api/backlog marks it "kept").
DELETE /api/items/:taskId         withdraw a card (the task closed meanwhile)
GET  /api/decisions               decisions to write to the board (decided, or failed earlier), triage and packets:
                                  each has "kind": "triage" or "packet"; both carry decision: choice, priority, note
                                  choice is go|design|hold|backlog|obsolete, or rewrite (Nil's answer only, never a proposal:
                                  no priority, and the note says what to write differently). Apply a rewrite by rewriting the
                                  task (or the packet) as the note asks, then propose it again (or re-post the packet): the
                                  card comes back to Triage as open.
                                  (a packet's decision may name the option, "preset", Nil picked to fill it)
                                  Nil's note can change anything; apply it with judgement (isomux-curator skill)
POST /api/applied                 {"results":[{"taskId","decidedAt","kind?":"triage|packet","ok":true|false,"error?"}]}
                                  decidedAt from /api/decisions; a decision Nil changed since then comes back as stale.
                                  Nil can undo a decision, also after it was applied: the card reopens in Triage and his
                                  next decision overwrites the board (an obsolete task is reopened, backlog moves it to P4).
                                  A decision he undid after you read it still counts when you report it.
                                  An open card with "fromHold": true is a [hold] task Nil brought back to Triage (the app
                                  messages you its id): propose it as usual; your proposal replaces the app's placeholder.

Packets (for workers; a card for Nil in Triage):
POST /api/packets                 {"taskId","question","options":[{"label","cost","recommended":true|false,
                                  "decision":"go|design|hold|backlog|obsolete","note?"}] (2-4, at most one recommended),
                                  "body":"markdown","branch?","diffUrl?"}. A new packet replaces the task's old one
                                  and its decision, and keeps its images; add "clearImages":true to drop them.
                                  Nil decides a packet like a triage card (choice, priority, note); an option is a preset:
                                  picking it sets its decision and fills the note with its note (default: the label).
                                  obsolete is always a choice: no option needs to offer "close, no change".
                                  Post it while you still hold the task: when the task is ready again, dispatch gives it
                                  back to you (also after a DELETE below), and to another worker only if you are gone.
POST /api/packets/:taskId/images  raw PNG/JPEG/WebP bytes, ?caption=..., one per call, at most 5 MB, 20 per packet
GET  /api/packets                 all packets with their state
DELETE /api/packets/:taskId       withdraw a packet, for example one Nil answered in the chat instead of on the card:
                                  it leaves Triage with its images. 204; 404 if none; 409 if Nil decided it and the
                                  decision waits in /api/decisions (apply it, or ask him to undo it).

Backlog (Nil's tab):
GET  /api/backlog                 the tasks of the Backlog state (P4, no card), oldest first, with the curator's "recommendation"
                                  (choice, priority, why, effort, at) when it posted one, and effort when a card estimated it.
                                  "kept": {at, by}: Nil kept the task in the backlog (a backlog decision reached the board).
                                  Do not recommend a kept task: the app skips it (under "kept") until its title or description changes.
                                  A change ends the mark and drops the old recommendation, so the curator wake asks for a new one
POST /api/backlog/:taskId/bring   {"choice":"go|design|hold|backlog|obsolete","priority":"P0-P3 (go, design, hold only)","note?"}:
                                  Nil's decision, a decided card that goes to the curator with the next burst, like any triage
                                  decision (fromBacklog: true; backlog keeps the task at P4, nothing to change on the board)

On hold (Nil's tab):
GET  /api/hold                    the tasks of the On hold state ([hold | ...], no card), by priority then age: id, title,
                                  priority, reason (the state part of the tag), note (the last dated note of the
                                  description, else its last paragraph), description, createdBy, createdAt
POST /api/hold/:taskId/reopen     a [hold] task back to Triage: an open card (fromHold: true) with a placeholder proposal (hold at
                                  its priority); the app messages the curator to propose it. DELETE /api/items/:taskId takes the
                                  card back before Nil decides; the task stays on hold

Loop (for Isomux PM):
GET  /api/status                  pause state, last dispatch and tick, ready queue, holders, merging, and the
                                  task states (board.states) with counts and tasks; done/obsolete list the last 20;
                                  board.states.triage and .decided are the open and the decided cards (the Triage and Decided tabs)
POST /api/pause | /api/resume     pause stops dispatch and the tick; the first tick after a resume (within a minute) catches what stopped
                                  meanwhile. The tick is due an hour after the last one, also across app restarts (timers.json).
POST /api/settings                {"workers": 1-6, "minPriority": "P0"-"P3" | null}, either or both (also on the status page).
                                  workers: the loop dispatches to Workers 1..N. Lowering N takes no task away; a worker above N
                                  keeps its tick while it holds a loop task. minPriority: dispatch takes only ready tasks at that
                                  priority or higher ("P1": P0 and P1); null (the default) takes every priority. GET /api/status
                                  gives both; board.belowFloor and board.states.ready.belowFloor count the ready tasks the floor holds back.
POST /api/dispatch | /api/tick    run one now (both refuse while paused)
POST /api/classify                run the curator wake now: every 10 minutes, also while paused, open P0-P3 tasks with no tag
                                  and no card go to the curator to propose, and backlog (P4, no card) tasks with no
                                  recommendation and not kept go to it to recommend, in one message (a task is announced
                                  again after an hour).
                                  Every board read (status, Triage list, packets, Backlog, this run; shared for 20 s) withdraws
                                  the undecided cards and packets whose task is done, obsolete or gone

Sign-off before the push:
POST /api/signoff                 worker at hand-off: {"taskId","title","summary?","copy":[{"where","old","new","audience?"}]}
                                  audience: "member" (what a person reads: UI strings, site, docs, emails, GitHub comments)
                                  or "agent" (what agents read: system prompt, agent reference, skills, API errors agents
                                  act on, logs). Without it the app guesses from where (system-prompt, agent-reference,
                                  skills -> agent; else member) and marks the entry guessed. Agent entries show secondary.
                                  (old "" for new copy). Replaces the task's item unless Nil rejected it and the revert is not reported.
POST /api/signoff/:taskId/images  raw PNG/JPEG/WebP bytes, ?caption=..., as for packets. For a before/after pair add
                                  ?pair=<short name>&side=before|after (one image per side); a pair shows side by side.
POST /api/signoff/:taskId/merged  Isomux Main after EVERY merge, item or not: {"commit"}. The sha is what a push go names.
                                  Only merged items show, so an item waits unseen until this call. A task with no code
                                  (copy only, for example a comment draft) has nothing to merge: Main reports it with the
                                  current main sha when it closes the task, and the item shows then.
                                  The sha must resolve in main's repository (else 400; reverted too). A re-report of the
                                  task's unpushed commit (its item was posted after the report) keeps its push order.
POST /api/signoff/:taskId/scout   Isomux Sign-off Scout: {"verdict":"stamp|look|pushback","reason":"one line (max 300)",
                                  "suggestions":{"copy":{"<entry index>":"comment"},"images":{"<image index>":"comment"}}}
                                  (suggestions optional; a before/after pair has one field, so either image's index
                                  works). A new post replaces the old. The Sign-off card shows it; Nil taps a
                                  suggestion to put it in his comment field. The app messages the Scout when a merge puts an
                                  item on the Sign-off tab (also after a re-merge).
GET  /api/signoff/history?limit=  Nil's sign-off decisions, newest first (max 300): taskId, title, commit, approved, note,
                                  comments, edits, the Scout's verdict at the time ("scout", or null), at. An undone
                                  decision leaves it. GET /api/signoff items also carry "scout".
POST /api/signoff/:taskId/edits   {"task"}: a Sign-off changes task filed by hand for an approved item. The item then holds
                                  the push point back (state "edits") until that task's merge is reported or it is closed.
POST /api/signoff/:taskId/reverted  Isomux Main after a revert Nil asked for: {"commit"}. The item leaves the list.
POST /api/signoff/pushed          Isomux Main after every push: {"commit"} (the sha it pushed). Every merge reported up to
                                  that sha leaves the Push state; returns {"pushed":[taskIds]}.
GET  /api/signoff                 merged items, the merges not pushed yet (unpushed: taskId, commit, seq, sent = in the last
                                  push go), the main sha, and push: the push point (Nil, 2026-10-20). Main is linear, so a
                                  push is "everything up to sha X": push.sha is the newest reported sha with every item
                                  merged at or before it approved (or nothing to sign off); push.tasks are the merges it
                                  takes, push.commits the distinct commits Main reported up to it, push.unpushedCommits
                                  all of them since the last push, push.blockers the items that hold it back (oldest
                                  first). A rejected item holds it back until Main reports the revert, and no point between
                                  the rejected merge and its revert is used. The push go names push.sha, never main's tip.
Nil's buttons on the Sign-off tab: approve (optional {"note"}; with a note or comments on any entry it also files a P0
"[go | ready] Sign-off changes: <title>" task with them, and the item holds the push point back, as a blocker with
state "edits", until that task's merge is reported or the task is closed);
reject (a note, plus any comments; the app messages Main "/isomux-main revert ..." a minute later, and the item's
"revertIn" counts down to it); undo (an approval until the push go, a rejection until Main gets the revert request;
an unstarted Sign-off changes task the approval filed is closed as obsolete, a started one stays and "edits" says
why); and "Push" on the Push tab
(messages Main "/isomux-main push go ..."). Comments are saved as Nil types
(POST /api/signoff/:taskId/comments {"copy":{"0":"..."},"images":{"0":"..."}}).
The app cannot tell which member pressed them.
`;

// --- loop timers -----------------------------------------------------------

type Run<T> = { at: number; result?: T; error?: string };
let lastDispatch: Run<DispatchResult> | null = null;
// The last tick is kept in the data dir: an interval timer starts over at
// every restart, so with frequent restarts the hourly tick never fired.
const timersFile = join(dataDir, "timers.json");
let lastTick: Run<TickResult> | null = readJson<{ lastTick: Run<TickResult> | null }>(timersFile, { lastTick: null }).lastTick;
let busy = false;

async function exclusive<T>(fn: () => Promise<T>): Promise<Run<T> | null> {
  if (busy) return null;
  busy = true;
  const at = Date.now();
  try {
    return { at, result: await fn() };
  } catch (err) {
    console.error(err);
    return { at, error: String(err instanceof Error ? err.message : err) };
  } finally {
    busy = false;
  }
}

async function runDispatch(): Promise<Run<DispatchResult> | null> {
  if (pause.paused) return null;
  const run = await exclusive(() => dispatch(office, pause.workers, Date.now(), pause.minPriority, (id) => returns.get(id)));
  if (run) {
    // A task given out no longer goes back: its next packet records its author anew.
    returns.drop(run.result?.assigned.map((a) => a.taskId) ?? []);
    lastDispatch = run;
    statusCache = null;
    if (run.result?.assigned.length) console.log(`dispatch ${JSON.stringify(run.result.assigned)}`);
    if (run.result?.killed.length) console.log(`dispatch: held by a killed worker: ${run.result.killed.join(", ")}`);
  }
  return run;
}

async function runTick(): Promise<Run<TickResult> | null> {
  if (pause.paused) return null;
  const run = await exclusive(() => tick(office, pause.workers));
  if (run) {
    lastTick = run;
    writeJson(timersFile, { lastTick });
  }
  return run;
}

// The next tick is due TICK_MS after the last one, also across restarts (at
// once when that is past). A tick that could not run (paused, or dispatch
// busy) is tried again a minute later, so the first one after a resume
// catches up.
function scheduleTick(): void {
  setTimeout(async () => {
    if (dueIn(lastTick?.at ?? null, Date.now(), TICK_MS) > 0) return scheduleTick();
    const run = await runTick();
    if (run) scheduleTick();
    else setTimeout(scheduleTick, 60_000);
  }, dueIn(lastTick?.at ?? null, Date.now(), TICK_MS));
}
scheduleTick();

// --- curator wake (Nil, 2026-10-19) ----------------------------------------------
// Every 10 minutes, also while dispatch is paused (triage is Nil's work, not
// the loop's): open tasks without a tag or a card go to the curator. A task is
// announced again only after CLASSIFY_REMIND_MS, so a busy curator is not
// messaged every 10 minutes about the same tasks.

type ClassifyRun = { at: number; found: string[]; sent: string | null; withdrawn: string[]; error?: string };
let lastClassify: ClassifyRun | null = null;
const announced = new Map<string, number>();

function cardIds(): Set<string> {
  return new Set(cards().keys());
}

// Every card not yet on the board: "open" is in the Triage tab, "decided"
// waits for the curator. The diagram reads the same map, so the Triage state
// and the Triage tab count the same cards.
function cards(): Map<string, Card> {
  const out = new Map<string, Card>();
  for (const i of store.list("all")) {
    const s = itemState(i);
    if (s !== "applied") out.set(i.taskId, s === "open" ? "open" : "decided");
  }
  for (const p of packets.list()) {
    const s = packetState(p);
    if (s !== "applied") out.set(p.taskId, s === "open" ? "open" : out.get(p.taskId) ?? "decided");
  }
  return out;
}

// Merged sign-off items that wait for Nil or for their revert.
function signoffIds(): Set<string> {
  return new Set(signoff.visible().filter((i) => ["waiting", "rejected"].includes(signoffState(i))).map((i) => i.taskId));
}

async function runClassify(): Promise<ClassifyRun> {
  const at = Date.now();
  try {
    const all = await boardTasks(true);
    const withdrawn = lastWithdrawn;
    const readAt = tasksCache?.at ?? 0;
    const found = ANNOUNCE_UNTAGGED ? unclassified(all, cardIds()) : [];
    const recs = unrecommended(backlogOf(all), (id) => !!store.recommendation(id), (t) => !!store.keptMark(t.id, t.title, t.description ?? "", readAt));
    const due = [...found, ...recs].filter((t) => at - (announced.get(t.id) ?? 0) >= CLASSIFY_REMIND_MS);
    let sent: string | null = null;
    if (due.length > 0) {
      const text = wakeText(found.map((t) => t.id), recs.map((t) => t.id), local)!;
      if (await office.message(text)) {
        sent = text;
        for (const t of [...found, ...recs]) announced.set(t.id, at);
      } else throw new Error("the message to the curator failed");
    }
    lastClassify = { at, found: [...found, ...recs].map((t) => t.id), sent, withdrawn };
  } catch (err) {
    lastClassify = { at, found: [], sent: null, withdrawn: [], error: String(err instanceof Error ? err.message : err) };
  }
  if (lastClassify.sent) console.log(`curator wake: ${lastClassify.found.join(", ")}`);
  return lastClassify;
}
setTimeout(() => void runClassify(), 30_000);
setInterval(() => void runClassify(), CLASSIFY_MS);

// The new-task wake-up, every minute, also while paused (new-tasks.ts).
const newTasks = new NewTasks(dataDir);
let lastNewTasks: NewTasksRun | null = null;
let newTasksBusy = false;
async function runNewTasks(): Promise<void> {
  if (newTasksBusy) return;
  newTasksBusy = true;
  const at = Date.now();
  try {
    lastNewTasks = await newTasks.run(office, at);
  } catch (err) {
    lastNewTasks = { at, reported: [], changed: [], error: String(err instanceof Error ? err.message : err) };
  } finally {
    newTasksBusy = false;
  }
  if (lastNewTasks.reported.length) console.log(`new tasks reported: ${lastNewTasks.reported.join(", ")}`);
  if (lastNewTasks.changed.length) console.log(`changed tasks reported: ${lastNewTasks.changed.join(", ")}`);
  if (lastNewTasks.seeded !== undefined) console.log(`new tasks: first run took ${lastNewTasks.seeded} open untagged tasks as reported`);
  if (lastNewTasks.error) console.error(`new tasks: ${lastNewTasks.error}`);
}
setTimeout(() => void runNewTasks(), 5_000);
setInterval(() => void runNewTasks(), NEW_TASKS_MS);

setInterval(() => void runDispatch(), DISPATCH_MS);

// Held revert requests go to Main when due (a rejection's undo window).
let revertsBusy = false;
setInterval(async () => {
  if (revertsBusy || !signoff.dueReverts().length) return;
  revertsBusy = true;
  try {
    const sent = await sendDueReverts(signoff, async (text) => office.message(text, await mainAgentId()));
    if (sent.length) {
      console.log(`revert requests sent: ${sent.join(", ")}`);
      statusCache = null;
    }
  } finally {
    revertsBusy = false;
  }
}, 5_000);

// --- triage notifications ------------------------------------------------------

async function notifyTriage(): Promise<void> {
  if (!store.shouldNotify(TRIAGE_QUIET_MS, packets.pending().length)) return;
  const n = store.pending().length + packets.pending().length;
  const delivered = await office.message(
    `${n} decision${n === 1 ? "" : "s"} from Nil (triage and packets) wait to be written to the board. ` +
      `Read them with curl -s ${local}/api/decisions, apply each one, then report with POST ${local}/api/applied. API: curl -s ${local}/api/help`,
  );
  // A rejection is not retried until the next decision.
  store.markNotified();
  if (!delivered) console.error("triage notification not delivered");
}
setInterval(() => void notifyTriage(), 30_000);

// --- board reads -------------------------------------------------------------
// One read of the room's tasks, shared by the status, the Triage list and the
// Backlog for STATUS_CACHE_MS. Every fresh read withdraws the undecided cards
// (triage and packets) whose task is done, obsolete or gone, so a closed task
// leaves Triage at the next read, not at the curator wake (Nil, 2026-10-19).

let tasksCache: { at: number; value: Task[] } | null = null;
let tasksRead: Promise<Task[]> | null = null;
let lastWithdrawn: string[] = [];

// For the push point: a task the board says is done or obsolete, or does not
// list. An unreadable board counts every task as open (the safe side).
async function closedOnBoard(fresh = false): Promise<(taskId: string) => boolean> {
  const all = await boardTasks(fresh).catch(() => null);
  if (!all) return () => false;
  const status = new Map(all.map((t) => [t.id, t.status]));
  return (id) => !status.has(id) || ["done", "obsolete"].includes(status.get(id)!);
}

function boardTasks(fresh = false): Promise<Task[]> {
  if (!fresh && tasksCache && Date.now() - tasksCache.at < STATUS_CACHE_MS) return Promise.resolve(tasksCache.value);
  if (!tasksRead)
    tasksRead = office
      .allTasks()
      .then((all) => {
        tasksCache = { at: Date.now(), value: all };
        lastWithdrawn = withdrawStale(all);
        const off = offBoard(returns.ids(), all);
        returns.drop([...off.gone, ...off.closed]);
        return all;
      })
      .finally(() => {
        tasksRead = null;
      });
  return tasksRead;
}

function withdrawStale(all: Task[]): string[] {
  // A card Nil reopened after its decision reached the board stays, even when
  // that decision closed the task (obsolete).
  const openPackets = packets.list().filter((p) => packetState(p) === "open" && !p.reopenedAt).map((p) => p.taskId);
  const ids = staleCards([...store.list("open").filter((i) => !i.reopenedAt).map((i) => i.taskId), ...openPackets], all);
  for (const id of ids) {
    store.withdraw(id);
    if (openPackets.includes(id)) packets.withdraw(id);
  }
  if (ids.length) {
    statusCache = null;
    console.log(withdrawLine(ids, all));
  }
  return ids;
}

// --- status ------------------------------------------------------------------

type Board = Status & { states: Record<StateKey, StateView>; closedPending: number };
let statusCache: { at: number; value: Board } | null = null;

async function loopStatus(): Promise<Record<string, unknown>> {
  let board: Board | null = null;
  let error: string | undefined;
  try {
    if (!statusCache || Date.now() - statusCache.at > STATUS_CACHE_MS) {
      const [agents, all] = await Promise.all([office.agents(), boardTasks()]);
      // The dispatch view sees what dispatch sees: the board's default listing.
      const live = all.filter((t) => (t.status === "open" || t.status === "in_progress") && t.priority !== "P4");
      const states = stateViews(all, cards(), (t) => closed.get(t), signoffIds(), signoff.unpushedIds(), new Set(agents.map((a) => a.id)));
      states.ready.belowFloor = belowFloor(states.ready, pause.minPriority);
      statusCache = {
        at: Date.now(),
        value: {
          ...status(agents, live, pause.workers, pause.minPriority, (id) => returns.get(id)),
          states,
          closedPending: closed.missing(all).length,
        },
      };
      // Close times the cache lacks fill in the background; the next read shows them.
      void closed.fill(all).then((n) => {
        if (n > 0) statusCache = null;
      });
    }
    board = statusCache.value;
  } catch (err) {
    error = String(err instanceof Error ? err.message : err);
  }
  const signoffWaiting = signoff.visible().filter((i) => signoffState(i) === "waiting").length;
  return { paused: pause.paused, pausedSince: pause.since, workers: pause.workers, minPriority: pause.minPriority, lastDispatch, lastTick, lastClassify, lastNewTasks, board, error, signoffWaiting };
}

// --- backlog -------------------------------------------------------------------
// The tasks of the diagram's Backlog state (P4, no card), oldest first; Nil
// can bring one in from here.

function backlogOf(all: Task[]): Task[] {
  const c = cards();
  const so = signoffIds();
  return all
    .filter((t) => (t.roomId ?? ROOM_ID) === ROOM_ID && classify(t, c.get(t.id) ?? null, so.has(t.id)) === "backlog")
    .sort((a, b) => a.createdAt - b.createdAt);
}

let backlogCache: { at: number; value: unknown[] } | null = null;
async function backlog(): Promise<unknown[]> {
  if (backlogCache && Date.now() - backlogCache.at < STATUS_CACHE_MS) return backlogCache.value;
  const all = await boardTasks();
  const readAt = tasksCache?.at ?? 0;
  const value = backlogOf(all)
    .map((t) => {
      // The curator's estimate: its recommendation's, else the card's that sent it to the backlog.
      const rec = store.recommendation(t.id);
      const p = rec ?? store.get(t.id)?.proposal;
      const k = store.keptMark(t.id, t.title, t.description ?? "", readAt);
      return { id: t.id, title: t.title, description: t.description ?? "", createdBy: (t as { createdBy?: string }).createdBy ?? "", createdAt: t.createdAt,
        ...(p?.effort ? { effort: p.effort, effortWhy: p.effortWhy } : {}), ...(rec ? { recommendation: rec } : {}),
        ...(k ? { kept: { at: k.at, by: k.by } } : {}) };
    });
  backlogCache = { at: Date.now(), value };
  return value;
}

// --- on hold -------------------------------------------------------------------
// The tasks of the diagram's On hold state, for the On hold tab (Nil, 2026-10-25).
// No cache of its own: the board read is shared, and the cards are read live,
// so a task brought back to Triage leaves the list at once.

async function onHold(): Promise<HoldTask[]> {
  const all = await boardTasks();
  const c = cards();
  const so = signoffIds();
  return all
    .filter((t) => (t.roomId ?? ROOM_ID) === ROOM_ID && classify(t, c.get(t.id) ?? null, so.has(t.id)) === "hold")
    .sort((a, b) => (a.priority ?? "P9").localeCompare(b.priority ?? "P9") || a.createdAt - b.createdAt)
    .map(holdTask);
}

// --- HTTP --------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new ValidationError("body must be JSON");
  }
}

// The Scout is optional: no Scout in the office, or a failed message, only logs.
async function tellScout(taskId: string): Promise<void> {
  try {
    const scout = (await office.agents()).find((a) => a.name === SCOUT_NAME);
    if (!scout) return;
    const text =
      `/isomux-signoff-scout ${taskId}: its merge is on the loop app's Sign-off tab. ` +
      `Read it (GET 127.0.0.1:21025/api/signoff) and post your verdict: POST /api/signoff/${taskId}/scout.`;
    if (!(await office.message(text, scout.id))) console.error(`message to ${SCOUT_NAME} about ${taskId} failed`);
  } catch (err) {
    console.error(`message to ${SCOUT_NAME} about ${taskId} failed: ${err}`);
  }
}

async function mainAgentId(): Promise<string> {
  const main = (await office.agents()).find((a) => a.name === MAIN_NAME);
  if (!main) throw new ValidationError(`${MAIN_NAME} is not in the office`);
  return main.id;
}

type ImageTarget = { addImage: (id: string, b: Uint8Array, c: string, pair?: string | null, side?: string | null) => unknown };
async function imageUpload(req: Request, dir: ImageTarget, taskId: string, withPairs = false) {
  const bytes = new Uint8Array(await req.arrayBuffer());
  const q = new URL(req.url).searchParams;
  if (!withPairs && (q.has("pair") || q.has("side"))) throw new ValidationError("before/after pairs are for sign-off images");
  return dir.addImage(taskId, bytes, q.get("caption") ?? "", q.get("pair"), q.get("side"));
}

function serveImage(images: ImageDir, taskId: string, file: string): Response {
  const bytes = images.read(taskId, file);
  if (!bytes) return json({ error: "not_found" }, 404);
  const type = file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : "image/webp";
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
}

const html = () => new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;

  if (m === "GET" && (path === "/" || path.startsWith("/signoff/") || path.startsWith("/push/"))) return html();
  const img = path.match(/^\/img\/(packets|signoff)\/([^/]+)\/([^/]+)$/);
  if (m === "GET" && img)
    return serveImage(img[1] === "packets" ? packets.images : signoff.images, decodeURIComponent(img[2]), img[3]);
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (m === "GET" && path === "/api/help") return new Response(HELP);

  // Loop
  if (m === "GET" && path === "/api/status") return json(await loopStatus());
  if (m === "POST" && path === "/api/pause") {
    pause.set(true);
    return json({ paused: true });
  }
  if (m === "POST" && path === "/api/resume") {
    pause.set(false);
    return json({ paused: false });
  }
  if (m === "POST" && path === "/api/settings") {
    const b = await body(req);
    if (b.workers === undefined && b.minPriority === undefined) throw new ValidationError("give workers, minPriority or both");
    pause.update(b);
    statusCache = null;
    return json({ workers: pause.workers, minPriority: pause.minPriority });
  }
  if (m === "POST" && path === "/api/dispatch") {
    if (pause.paused) return json({ error: "paused" }, 409);
    const run = await runDispatch();
    return run ? json(run) : json({ error: "busy" }, 409);
  }
  if (m === "POST" && path === "/api/classify") return json(await runClassify());
  if (m === "POST" && path === "/api/tick") {
    if (pause.paused) return json({ error: "paused" }, 409);
    const run = await runTick();
    return run ? json(run) : json({ error: "busy" }, 409);
  }

  // Packets
  if (m === "POST" && path === "/api/packets") {
    const b = await body(req);
    const taskId = String(b.taskId ?? "");
    let task: { title: string; priority: string | null };
    let authorOf: Author | undefined;
    try {
      const t = await office.task(taskId);
      task = { title: t.title, priority: t.priority ?? null };
      authorOf = await packetAuthor(t, office);
    } catch {
      throw new ValidationError(`task ${taskId} is not on the board (or the board is unreadable)`);
    }
    const p = packets.put(b, task);
    if (authorOf) returns.set(taskId, authorOf);
    statusCache = null;
    return json({ ...p, url: publicUrl + "/" });
  }
  if (m === "GET" && path === "/api/packets") {
    await boardTasks().catch(() => undefined);
    return json(packets.list().map((p) => ({ ...p, state: packetState(p) })));
  }
  const del = m === "DELETE" && path.match(/^\/api\/packets\/([^/]+)$/);
  if (del) {
    const r = packets.remove(decodeURIComponent(del[1]));
    if (r === "removed") {
      statusCache = null;
      return new Response(null, { status: 204 });
    }
    return r === "pending"
      ? json({ error: "pending", message: "Nil decided this packet and the decision waits in /api/decisions; apply it, or ask him to undo it" }, 409)
      : json({ error: "not_found" }, 404);
  }
  const pk = path.match(/^\/api\/packets\/([^/]+)\/(images|decide|undo)$/);
  if (pk && m === "POST") {
    const taskId = decodeURIComponent(pk[1]);
    if (pk[2] === "images") return json(await imageUpload(req, packets, taskId));
    if (pk[2] === "decide") {
      const p = packets.decide(taskId, await body(req));
      store.noteDecision(p.decision!.decidedAt);
      return json(p);
    }
    return json(packets.undo(taskId));
  }

  // Sign-off
  if (m === "GET" && path === "/api/signoff")
    return json({
      // revertIn: ms until a held revert request goes to Main (the page counts down).
      items: signoff.visible().map((i) => {
        const r = i.decision?.revert;
        return { ...i, copy: i.copy.map(withAudience), state: signoffState(i), ...(r && !r.sent ? { revertIn: Math.max(0, r.due - Date.now()) } : {}) };
      }),
      unpushed: signoff.unpushedList(),
      ...signoff.meta(),
      push: signoff.pushCheck(await closedOnBoard()),
    });
  if (m === "POST" && path === "/api/signoff") return json(signoff.put(await body(req)));
  if (m === "GET" && path === "/api/signoff/history")
    return json(signoff.history(Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50));
  if (m === "POST" && path === "/api/signoff/pushed") {
    const out = signoff.pushed(await body(req));
    statusCache = null;
    return json(out);
  }
  if (m === "POST" && path === "/api/signoff/push") {
    const check = signoff.pushCheck(await closedOnBoard(true));
    if (!check.ok) return json({ error: check.reason }, 409);
    const text =
      `/isomux-main push go from Nil through the loop app: push main at ${check.sha} ` +
      `(the push point: ${check.tasks.length} merge${check.tasks.length === 1 ? "" : "s"}; later merges wait for their sign-off). ` +
      `git push origin ${check.sha}:main, never main's tip. ` +
      `Signed off: ${check.approved.length ? check.approved.join(", ") : "none (no copy or visible change waited)"}.`;
    if (!(await office.message(text, await mainAgentId()))) return json({ error: "the message to Isomux Main failed; nothing changed" }, 502);
    signoff.recordPushGo(check.sha!);
    return json({ sent: text });
  }
  const so = path.match(/^\/api\/signoff\/([^/]+)\/(images|merged|reverted|approve|reject|undo|comments|edits|scout)$/);
  if (so && m === "POST") {
    const taskId = decodeURIComponent(so[1]);
    // Merges, reverts and Nil's buttons move tasks between diagram states.
    if (so[2] !== "images" && so[2] !== "comments") statusCache = null;
    switch (so[2]) {
      case "images":
        return json(await imageUpload(req, signoff, taskId, true));
      case "merged": {
        const out = signoff.merged(taskId, await body(req));
        // The item is on the Sign-off tab now: the Scout reads it.
        if (out.signoff && signoffState(signoff.get(taskId)!) === "waiting") void tellScout(taskId);
        return json(out);
      }
      case "scout":
        return json(signoff.setScout(taskId, await body(req)));
      case "reverted":
        return json(signoff.reverted(taskId, await body(req)));
      case "approve": {
        // Comments or a note make the approval file a Sign-off changes task as well.
        // An approve without a body (as before the note) is still valid.
        const sent = await req.text();
        const raw = sent.trim() ? await body(new Request(req.url, { method: "POST", body: sent })) : {};
        const { item, note, filesTask } = signoff.checkApprove(taskId, raw);
        if (!filesTask) return json(signoff.approve(taskId));
        const title = item.title.replace(/^\[[^\]]*\]\s*/, "");
        const description = signoff.editsDescription(item, note, new Date().toISOString().slice(0, 10));
        let created;
        try {
          created = await office.createTask({ title: `[go | ready] Sign-off changes: ${title}`, description, priority: "P0", roomId: ROOM_ID });
        } catch (err) {
          return json({ error: `the board refused the Sign-off changes task (${String(err instanceof Error ? err.message : err)}); the item is not approved yet` }, 502);
        }
        statusCache = null;
        return json(signoff.approve(taskId, created.id, note));
      }
      case "undo":
        return json(await undoDecision(signoff, office, taskId, new Date().toISOString().slice(0, 10)));
      case "edits": {
        const editsId = String((await body(req)).task ?? "");
        try {
          await office.task(editsId);
        } catch {
          throw new ValidationError(`task ${editsId} is not on the board (or the board is unreadable)`);
        }
        return json(signoff.linkEdits(taskId, editsId));
      }
      case "comments":
        return json(signoff.setComments(taskId, await body(req)));
      case "reject": {
        // The revert request waits REVERT_HOLD_MS, so Nil can undo it.
        const { note, typed } = signoff.checkReject(taskId, await body(req));
        const i = signoff.recordReject(taskId, note, typed);
        return json({ ...i, revertIn: i.decision!.revert!.due - Date.now() });
      }
    }
  }

  // Backlog
  if (m === "GET" && path === "/api/backlog") return json(await backlog());
  const bl = path.match(/^\/api\/backlog\/([^/]+)\/bring$/);
  if (bl && m === "POST") {
    const taskId = decodeURIComponent(bl[1]);
    const t = await office.task(taskId).catch(() => null);
    if (!t || t.status !== "open" || t.priority !== "P4") throw new ValidationError("this task is no longer an open P4 task");
    const item = store.bringIn(
      { title: t.title, description: t.description ?? "", priority: "P4", createdBy: (t as { createdBy?: string }).createdBy ?? "", createdAt: t.createdAt },
      taskId,
      await body(req),
    );
    backlogCache = null;
    statusCache = null;
    return json(item);
  }

  // On hold
  if (m === "GET" && path === "/api/hold") return json(await onHold());
  const hr = path.match(/^\/api\/hold\/([^/]+)\/reopen$/);
  if (hr && m === "POST") {
    const taskId = decodeURIComponent(hr[1]);
    const t = await office.task(taskId).catch(() => null);
    const cls = t ? parseTag(t.title)?.class : undefined;
    if (!t || t.status === "done" || t.status === "obsolete" || (cls !== "hold" && cls !== "authority"))
      throw new ValidationError("this task is no longer an open [hold] task");
    const item = store.reopenHold(
      { title: t.title, description: t.description ?? "", priority: (t.priority ?? null) as TaskSnapshot["priority"], createdBy: (t as { createdBy?: string }).createdBy ?? "", createdAt: t.createdAt },
      taskId,
    );
    statusCache = null;
    const sent = await office.message(
      `/isomux-curator Nil brought task ${taskId} back from hold to Triage. Propose it (POST ${local}/api/proposals); your proposal replaces the app's placeholder. API: curl -s ${local}/api/help`,
    );
    if (!sent) console.error(`hold reopen: the message to the curator failed (${taskId})`);
    return json(item);
  }

  // Triage
  if (m === "GET" && path === "/api/summary") return json(store.counts());
  if (m === "GET" && path === "/api/items") {
    const state = url.searchParams.get("state") ?? "all";
    if (!["open", "decided", "applied", "failed", "all"].includes(state))
      throw new ValidationError("unknown state");
    // A card whose task closed leaves before the list is served.
    await boardTasks().catch(() => undefined);
    return json(store.list(state as "all"));
  }
  if (m === "POST" && path === "/api/proposals") {
    const b = await body(req);
    if (!Array.isArray(b.proposals)) throw new ValidationError("proposals must be an array");
    // A fresh read, so a task the curator just moved into the room counts.
    const all = await boardTasks(true).catch(() => null);
    if (!all) throw new ValidationError("the room's task list is unreadable; no proposals were taken");
    // An empty taskId is the store's to refuse.
    const ids = (b.proposals as Record<string, unknown>[]).map((p) => String(p?.taskId ?? "")).filter(Boolean);
    const refusal = proposalRefusal(ids, all, ROOM_ID);
    if (refusal) throw new ValidationError(refusal);
    return json(store.propose(b.proposals));
  }
  if (m === "GET" && path === "/api/decisions")
    return json([
      ...store.pending().map((i) => ({ kind: "triage", ...i })),
      ...packets.pending().map((p) => ({ kind: "packet", ...p })),
    ]);
  if (m === "POST" && path === "/api/applied") {
    const b = await body(req);
    if (!Array.isArray(b.results)) throw new ValidationError("results must be an array");
    const out = { recorded: [] as string[], stale: [] as string[] };
    for (const r of b.results as Record<string, unknown>[]) {
      const taskId = String(r?.taskId ?? "");
      let ok = false;
      if (r?.kind !== "packet") ok = store.markApplied([r]).recorded.length === 1;
      if (!ok && r?.kind !== "triage") {
        ok = packets.markApplied(taskId, Number(r?.decidedAt), r?.ok !== false, typeof r?.error === "string" ? r.error : undefined);
        // A packet decision that reached the board keeps or un-keeps the task like a triage one.
        const p = packets.get(taskId);
        if (ok && r?.ok !== false && p?.decision) store.noteApplied(taskId, p.decision.choice);
      }
      (ok ? out.recorded : out.stale).push(taskId);
    }
    return json(out);
  }
  const item = path.match(/^\/api\/items\/([^/]+)(?:\/(decide|undo))?$/);
  if (item) {
    const taskId = decodeURIComponent(item[1]);
    const action = item[2];
    if (m === "DELETE" && !action)
      return store.withdraw(taskId) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
    if (m === "POST" && action === "decide") return json(store.decide(taskId, await body(req)));
    if (m === "POST" && action === "undo") return json(store.undo(taskId));
  }
  return json({ error: "not_found" }, 404);
}

Bun.serve({
  port,
  hostname: process.env.ISOMUX_APP_HOST || "127.0.0.1",
  async fetch(req) {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof ValidationError) return json({ error: err.message }, 400);
      console.error(err);
      return json({ error: "internal" }, 500);
    } finally {
      // Any write may move a task between diagram states (a decision, an
      // undo, a packet, a merge): the next status read is fresh.
      if (req.method !== "GET") {
        statusCache = null;
        tasksCache = null;
        backlogCache = null;
      }
    }
  },
});
console.log(`loop app listening on ${port}${pause.paused ? " (paused)" : ""}`);
