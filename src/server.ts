import { CLASSIFY_MS, CLASSIFY_REMIND_MS, DISPATCH_MS, MAIN_NAME, ROOM_ID, STATUS_CACHE_MS, TICK_MS, TRIAGE_QUIET_MS } from "./config";
import { ClosedTimes } from "./closed-times";
import { type ImageDir } from "./images";
import { dispatch, dueIn, staleCards, status, tick, unclassified, type DispatchResult, type Status, type TickResult } from "./loop";
import { join } from "node:path";
import { readJson, writeJson } from "./json-file";
import { httpOffice, type Task } from "./office";
import { page } from "./page";
import { PacketStore, packetState } from "./packets";
import { PauseFlag } from "./pause";
import { SignoffStore, signoffState, withAudience } from "./signoff";
import { classify, stateViews, type Card, type StateKey, type StateView } from "./states";
import { itemState, Store, ValidationError } from "./store";

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
const signoff = new SignoffStore(dataDir);
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
                                  A P4 task is proposed only to promote it: a proposal for it that is not go, design or hold comes
                                  back under "refused".
DELETE /api/items/:taskId         withdraw a card (the task closed meanwhile)
GET  /api/decisions               decisions to write to the board (decided, or failed earlier), triage and packets:
                                  each has "kind": "triage" or "packet"; both carry decision: choice, priority, note
                                  (a packet's decision may name the option, "preset", Nil picked to fill it)
                                  Nil's note can change anything; apply it with judgement (isomux-curator skill)
POST /api/applied                 {"results":[{"taskId","decidedAt","kind?":"triage|packet","ok":true|false,"error?"}]}
                                  decidedAt from /api/decisions; a decision Nil changed since then comes back as stale.
                                  Nil can undo a decision, also after it was applied: the card reopens in Triage and his
                                  next decision overwrites the board (an obsolete task is reopened, backlog moves it to P4).
                                  A decision he undid after you read it still counts when you report it.

Packets (for workers; a card for Nil in Triage):
POST /api/packets                 {"taskId","question","options":[{"label","cost","recommended":true|false,
                                  "decision":"go|design|hold|backlog|obsolete","note?"}] (2-4, at most one recommended),
                                  "body":"markdown","branch?","diffUrl?"}. A new packet replaces the task's old one.
                                  Nil decides a packet like a triage card (choice, priority, note); an option is a preset:
                                  picking it sets its decision and fills the note with its note (default: the label).
                                  obsolete is always a choice: no option needs to offer "close, no change".
POST /api/packets/:taskId/images  raw PNG/JPEG/WebP bytes, ?caption=..., one per call, at most 5 MB, 20 per packet
GET  /api/packets                 all packets with their state

Backlog (Nil's tab):
GET  /api/backlog                 the tasks of the Backlog state (P4, no card), oldest first, with effort when a card estimated it
POST /api/backlog/:taskId/bring   {"choice":"go|design|hold","priority":"P0-P3","note?"}: a decided card that goes to the curator
                                  with the next burst, like any triage decision

Loop (for Isomux PM):
GET  /api/status                  pause state, last dispatch and tick, ready queue, holders, merging, and the
                                  task states (board.states) with counts and tasks; done/obsolete list the last 20;
                                  board.states.triage and .decided are the open and the decided cards (the Triage and Decided tabs)
POST /api/pause | /api/resume     pause stops dispatch and the tick; the first tick after a resume (within a minute) catches what stopped
                                  meanwhile. The tick is due an hour after the last one, also across app restarts (timers.json).
POST /api/settings                {"workers": 1-6}: the loop dispatches to Workers 1..N (also on the status page).
                                  Lowering N takes no task away; a worker above N keeps its tick while it holds a loop task.
POST /api/dispatch | /api/tick    run one now (both refuse while paused)
POST /api/classify                run the curator wake now: every 10 minutes, also while paused, open P0-P3 tasks with no tag
                                  and no card go to the curator (P4 is left out) (a task is announced again after an hour).
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
POST /api/signoff/:taskId/reverted  Isomux Main after a revert Nil asked for: {"commit"}. The item leaves the list.
POST /api/signoff/pushed          Isomux Main after every push: {"commit"} (the sha it pushed). Every merge reported up to
                                  that sha leaves the Push state; returns {"pushed":[taskIds]}.
GET  /api/signoff                 merged items, the merges not pushed yet (unpushed: taskId, commit, seq, sent = in the last
                                  push go), the main sha, and push: the push point (Nil, 2026-10-20). Main is linear, so a
                                  push is "everything up to sha X": push.sha is the newest reported sha with every item
                                  merged at or before it approved (or nothing to sign off); push.tasks are the merges it
                                  takes, push.blockers the items that hold it back (oldest first). A rejected item holds it
                                  back until Main reports the revert, and no point between the rejected merge and its revert
                                  is used. The push go names push.sha, never main's tip.
Nil's buttons on the Sign-off tab: approve (with comments on any entry it also files a P0
"[go | ready] Copy edits: <title>" task with them; the merged commit still goes out with the next push);
reject (a note, plus any comments; messages Main "/isomux-main revert ..."); and "Push" on the Push tab
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
  const run = await exclusive(() => dispatch(office, pause.workers));
  if (run) {
    lastDispatch = run;
    statusCache = null;
    if (run.result?.assigned.length) console.log(`dispatch ${JSON.stringify(run.result.assigned)}`);
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
    const found = unclassified(all, cardIds());
    const due = found.filter((t) => at - (announced.get(t.id) ?? 0) >= CLASSIFY_REMIND_MS);
    let sent: string | null = null;
    if (due.length > 0) {
      const text =
        `/isomux-curator ${found.length} open task${found.length === 1 ? "" : "s"} in the Isomux room ha${found.length === 1 ? "s" : "ve"} no tag and no card in the loop app; propose ${found.length === 1 ? "it" : "them"}: ` +
        found.map((t) => t.id).join(", ") + `. API: curl -s ${local}/api/help`;
      if (await office.message(text)) {
        sent = text;
        for (const t of found) announced.set(t.id, at);
      } else throw new Error("the message to the curator failed");
    }
    lastClassify = { at, found: found.map((t) => t.id), sent, withdrawn };
  } catch (err) {
    lastClassify = { at, found: [], sent: null, withdrawn: [], error: String(err instanceof Error ? err.message : err) };
  }
  if (lastClassify.sent) console.log(`curator wake: ${lastClassify.found.join(", ")}`);
  return lastClassify;
}
setTimeout(() => void runClassify(), 30_000);
setInterval(() => void runClassify(), CLASSIFY_MS);

setInterval(() => void runDispatch(), DISPATCH_MS);

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

function boardTasks(fresh = false): Promise<Task[]> {
  if (!fresh && tasksCache && Date.now() - tasksCache.at < STATUS_CACHE_MS) return Promise.resolve(tasksCache.value);
  if (!tasksRead)
    tasksRead = office
      .allTasks()
      .then((all) => {
        tasksCache = { at: Date.now(), value: all };
        lastWithdrawn = withdrawStale(all);
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
    console.log(`withdrew cards of closed tasks: ${ids.join(", ")}`);
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
      statusCache = {
        at: Date.now(),
        value: {
          ...status(agents, live, pause.workers),
          states: stateViews(all, cards(), (t) => closed.get(t), signoffIds(), signoff.unpushedIds()),
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
  return { paused: pause.paused, pausedSince: pause.since, workers: pause.workers, lastDispatch, lastTick, lastClassify, board, error, signoffWaiting };
}

// --- backlog -------------------------------------------------------------------
// The tasks of the diagram's Backlog state (P4, no card), oldest first; Nil
// can bring one in from here.

let backlogCache: { at: number; value: unknown[] } | null = null;
async function backlog(): Promise<unknown[]> {
  if (backlogCache && Date.now() - backlogCache.at < STATUS_CACHE_MS) return backlogCache.value;
  const all = await boardTasks();
  const c = cards();
  const so = signoffIds();
  const value = all
    .filter((t) => (t.roomId ?? ROOM_ID) === ROOM_ID && classify(t, c.get(t.id) ?? null, so.has(t.id)) === "backlog")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t) => {
      // The curator's estimate from the card that sent it to the backlog, when known.
      const p = store.get(t.id)?.proposal;
      return { id: t.id, title: t.title, description: t.description ?? "", createdBy: (t as { createdBy?: string }).createdBy ?? "", createdAt: t.createdAt,
        ...(p?.effort ? { effort: p.effort, effortWhy: p.effortWhy } : {}) };
    });
  backlogCache = { at: Date.now(), value };
  return value;
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
    pause.setWorkers(b.workers);
    statusCache = null;
    return json({ workers: pause.workers });
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
    try {
      const t = await office.task(taskId);
      task = { title: t.title, priority: t.priority ?? null };
    } catch {
      throw new ValidationError(`task ${taskId} is not on the board (or the board is unreadable)`);
    }
    const p = packets.put(b, task);
    statusCache = null;
    return json({ ...p, url: publicUrl + "/" });
  }
  if (m === "GET" && path === "/api/packets") {
    await boardTasks().catch(() => undefined);
    return json(packets.list().map((p) => ({ ...p, state: packetState(p) })));
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
      items: signoff.visible().map((i) => ({ ...i, copy: i.copy.map(withAudience), state: signoffState(i) })),
      unpushed: signoff.unpushedList(),
      ...signoff.meta(),
      push: signoff.pushCheck(),
    });
  if (m === "POST" && path === "/api/signoff") return json(signoff.put(await body(req)));
  if (m === "POST" && path === "/api/signoff/pushed") {
    const out = signoff.pushed(await body(req));
    statusCache = null;
    return json(out);
  }
  if (m === "POST" && path === "/api/signoff/push") {
    const check = signoff.pushCheck();
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
  const so = path.match(/^\/api\/signoff\/([^/]+)\/(images|merged|reverted|approve|reject|undo|comments)$/);
  if (so && m === "POST") {
    const taskId = decodeURIComponent(so[1]);
    // Merges, reverts and Nil's buttons move tasks between diagram states.
    if (so[2] !== "images" && so[2] !== "comments") statusCache = null;
    switch (so[2]) {
      case "images":
        return json(await imageUpload(req, signoff, taskId, true));
      case "merged":
        return json(signoff.merged(taskId, await body(req)));
      case "reverted":
        return json(signoff.reverted(taskId, await body(req)));
      case "approve": {
        // Comments make the approval file a copy-edits task as well.
        const { item, hasComments } = signoff.checkApprove(taskId);
        if (!hasComments) return json(signoff.approve(taskId));
        const title = item.title.replace(/^\[[^\]]*\]\s*/, "");
        const description = [
          `Copy edits Nil asked for when he approved this at sign-off in the loop app (${new Date().toISOString().slice(0, 10)}). The merged commit goes out as it is; these edits come as their own commit with their own sign-off item.`,
          `Source task: ${item.taskId}. Merged commit: ${item.merged!.commit}.`,
          "",
          "Rule: Nil's quoted text goes in verbatim; for a note, write the edit and create a sign-off item for it.",
          "",
          ...signoff.commentLines(item, true),
        ].join("\n");
        let created;
        try {
          created = await office.createTask({ title: `[go | ready] Copy edits: ${title}`, description, priority: "P0", roomId: ROOM_ID });
        } catch (err) {
          return json({ error: `the board refused the copy-edits task (${String(err instanceof Error ? err.message : err)}); the item is not approved yet` }, 502);
        }
        statusCache = null;
        return json(signoff.approve(taskId, created.id));
      }
      case "undo":
        return json(signoff.undo(taskId));
      case "comments":
        return json(signoff.setComments(taskId, await body(req)));
      case "reject": {
        const { item, note } = signoff.checkReject(taskId, await body(req));
        const text = `/isomux-main revert ${taskId} (${item.merged!.commit}): Nil rejected it at sign-off: ${note}`;
        if (!(await office.message(text, await mainAgentId())))
          return json({ error: "the message to Isomux Main failed; the item is not rejected yet" }, 502);
        return json(signoff.recordReject(taskId, note));
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
      if (!ok && r?.kind !== "triage")
        ok = packets.markApplied(taskId, Number(r?.decidedAt), r?.ok !== false, typeof r?.error === "string" ? r.error : undefined);
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
