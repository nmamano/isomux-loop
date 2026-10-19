// The loop app's page: status, triage (proposals and packets) and sign-off. Plain JS, no build.
const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"];
// Nil, 2026-10-18: no taste class; an old taste proposal shows as decide.
const CLASSES = ["auto", "decide", "authority"];
const EXTRA_CHOICES = ["rescope", "obsolete", "research more"];
const OUTCOMES = ["keep", "rescope", "obsolete"];
const TABS = [
  ["status", "Status"],
  ["open", "To review"],
  ["decided", "Decided"],
  ["applied", "Applied"],
  ["signoff", "Sign-off"],
];
let tab = "status";
let items = [];
let counts = {};
let loopState = null;
let packets = [];
let signoffData = { items: [], push: { ok: false, reason: "" } };
const later = new Set();
const picks = {};
const packetPicks = {};
const rejectNotes = {};
// Help rows opened with "?" (for phones, where hover does not exist).
const openHelp = new Set();

const HELP = {
  P0: "P0: most urgent. The loop takes P0 tasks first.",
  P1: "P1: high. Taken after every P0.",
  P2: "P2: normal.",
  P3: "P3: low. Taken when nothing above it waits.",
  P4: "P4: backlog. The loop never picks it.",
  auto: "auto: the loop does it from start to finish.",
  decide: "decide: needs your design go/no-go. The loop may research it and write a decision packet first.",
  wasTaste: "The curator proposed taste, a class that no longer exists. It shows as decide; the curator will propose it again.",
  authority: "authority: the loop never touches it. Also for work run outside the loop.",
  keep: "keep: the task stays as it is, with the priority and class above.",
  rescope: "rescope: the task is rewritten to the proposed scope, or to the scope in your note.",
  obsolete: "obsolete: the task is closed, with the reason. Reversible: it can be reopened.",
  priority: "Which priority the task gets. The loop takes P0 first, then P1 to P3, oldest first within one. P4 is backlog: never picked.",
  class: "What kind of work it is, which decides how far the loop goes alone.",
  outcome: "What happens to the task itself.",
  head: "Board: the task's priority and tag on the board now. Yours: what is selected in the rows below; it changes as you tap. The dot on a chip marks the curator's proposal. Nothing in these lines needs you: you decide with the rows below.",
  dot: "The dot marks the curator's proposal.",
  why: "The curator's reason for its proposal.",
  scope: "The new title and description the curator proposes for this task.",
  description: "The task's description on the board today.",
  note: "Optional words for the curator, for example a different scope. It reads them when it writes your decision to the board.",
  confirm: "Confirm saves your choice in the rows above. The curator writes it to the board a few minutes after your last decision; until then you can undo it in Decided.",
  later: "Later moves this card to the end of the list. Nothing is saved.",
  undo: "Undo takes the decision back while the curator has not written it to the board yet.",
  decision: "What you chose for this task.",
  applied: "On the board: the curator wrote your decision to the board.",
  pending: "Waiting for the curator: saved here; the curator writes it to the board a few minutes after your last decision.",
  failed: "Failed: the curator could not write it to the board. It tries again with the next batch.",
  pause: "Pause stops dispatch and the hourly tick. Workers keep the tasks they hold.",
  resume: "Resume starts dispatch (every 2 minutes) and the hourly tick again.",
  pairs: "How many worker/reviewer pairs the loop uses: it gives new tasks to Workers 1 to N. Lowering it takes no task away.",
  runs: "Dispatch gives free workers the next ready task every 2 minutes. The tick nudges idle workers once an hour.",
  working: "Workers that hold a task now.",
  free: "Loop workers without a task. They get the next ready task at the next dispatch.",
  ready: "Tasks the loop can take now, in the order it takes them.",
  merging: "Approved work that Isomux Main merges after CI.",
  signoffLine: "Merged work with copy or a visible change that waits for your approve or reject before the push.",
  signoff: "Needs your sign-off: merged work whose item on the Sign-off tab waits for you, has edits requested, or waits for its revert.",
  never: "Never picked: tag [authority | ...]. The loop never touches it; also for work run outside the loop.",
  diagram: "Every task of the room is in exactly one of these states, read from the board now. Tap a state to list its tasks. Arrows show who moves a task on.",
  other: "Tasks that fit none of the states, for example a tag the loop does not know, a [<class> | nil] task without a card, or batch work outside the loop.",
  recentDone: "The last 20 tasks closed as done, newest first.",
  recentObsolete: "The last 20 tasks closed as obsolete, newest first.",
  tabStatus: "The loop now: pause, workers, queue, merges and what waits for you.",
  tabOpen: "Cards that wait for your decision: workers' design packets first, then the curator's proposals.",
  tabDecided: "Your decisions that the curator has not written to the board yet. You can undo them.",
  tabApplied: "Decisions the curator wrote to the board.",
  tabSignoff: "Merged copy and visible changes: approve or reject each before the push, then give the push go.",
  old: "The text before the change. Struck words went away.",
  pairImages: "The same screen before and after the change. Tap an image to open it full size. One comment covers the pair.",
  before: "The screen before the change.",
  after: "The screen after the change.",
  new: "The text after the change. Marked words are new.",
  packet: "A design packet: a worker hit a decision that needs you. Pick an option (the dot marks the worker's recommendation), or rescope, obsolete, or research more.",
  question: "The question the worker needs you to answer.",
  options: "The options the worker found, with what each costs. The dot marks its recommendation.",
  extras: "rescope: rewrite the task (your note says how). obsolete: close it. research more: the worker looks further (your note says what).",
  "research more": "research more: the worker researches further before you decide; your note says what to look at.",
  packetBody: "The worker's full packet: findings, details and trade-offs.",
  images: "Screenshots from the worker. Tap one to open it full size.",
  links: "The branch with the work, and the diff when there is one.",
  packetConfirm: "Confirm saves your choice. The curator writes it to the task a few minutes after your last decision; until then you can undo it in Decided.",
  approve: "Approve: this copy or change may go out with the next push.",
  reject: "Reject: Isomux Main reverts the commit at once and the task goes back to ready with your note (and your comments). Needs a note.",
  requestEdits: "Request edits: keeps the merge and files a P0 task to fix the copy as a commit on top, with your comments. Needs a comment on at least one entry. The push waits until that task's own sign-off.",
  comment: "Optional. A note (\"shorter\"), or the exact new text in quotes. Saved as you type; used by Request edits and Reject.",
  editsSign: "Edits requested: a copy-edits task is on the board. The push waits until that task's own sign-off item is merged and decided.",
  rejectNote: "Why you reject it, and what to do instead. The worker reads it when the task comes back.",
  undoApprove: "Undo the approval while the push go has not been given.",
  push: "Approve and push: tells Isomux Main to push main at the sha below. Enabled when every item is approved or rejected and every rejection is reverted.",
  sha: "The main commit from Isomux Main's latest merge or revert. The push go names this commit.",
  rejected: "Rejected: Isomux Main was asked to revert it. It stays here until Main reports the revert.",
  waitingSign: "Waiting for your approve or reject.",
  approvedSign: "Approved: it goes out with the next push go.",
  where: "Where this copy appears.",
  summary: "What the worker says changed.",
};
// The states: label, definition (board facts), and place in the diagram.
const STATE_INFO = {
  filed: ["Filed", "Open, no tag in the title, no card in the app yet. The loop never picks it."],
  proposed: ["Triage card", "A card waits in Triage for your decision: a curator proposal, or a worker's design packet on a [<class> | nil] task."],
  ready: ["Ready", "Tag [auto | ready] or [decide | ready], open, no assignee, P0-P3. The loop picks these."],
  working: ["Working", "In progress, assigned to an Isomux Worker."],
  merging: ["Merging", "Tag [<class> | merging], in progress, no assignee. Isomux Main merges it after CI."],
  signoff: ["Needs your sign-off", "Merged, with copy or a visible change: its item on the Sign-off tab waits for you, has edits requested, or waits for its revert. The board already says done."],
  never: ["Never picked", "Tag [authority | ...]. The loop never touches it."],
  backlog: ["Backlog", "P4. The loop never picks it."],
  done: ["Done", "Status done."],
  obsolete: ["Obsolete", "Status obsolete: closed, and reversible."],
};
const BOX = {
  filed: [140, 10, 120], proposed: [140, 90, 120], ready: [140, 170, 120], working: [140, 250, 120],
  merging: [140, 330, 120], signoff: [140, 410, 120], done: [140, 490, 120],
  never: [0, 40, 100], backlog: [0, 110, 100], obsolete: [300, 90, 100],
};
// [path, label x, label y, anchor, label, help, label runs up the lane]
const EDGES = [
  ["M200,56 V88", 206, 76, "start", "curator", "Filed to Triage card: the curator proposes a review."],
  ["M200,136 V168", 206, 156, "start", "Nil", "Triage card to Ready: you confirm it with a loop class, or pick a packet option."],
  ["M200,216 V248", 206, 236, "start", "app", "Ready to Working: the app gives it to a free worker."],
  ["M200,296 V328", 206, 316, "start", "approved", "Working to Merging: the reviewer approved the work."],
  ["M200,376 V408", 206, 396, "start", "to sign off", "Merging to Needs your sign-off: merged, and it has copy or a visible change."],
  ["M260,352 H290 V512 H262", 295, 440, "start", "nothing to sign off", "Merging to Done: merged, with nothing to sign off."],
  ["M200,456 V488", 206, 476, "start", "approved", "Needs your sign-off to Done: you approved it and gave the push go."],
  ["M140,104 L102,68", 121, 115, "middle", "Nil", "Triage card to Never picked or Backlog: your decision."],
  ["M140,120 L102,128", null],
  ["M260,112 H298", 279, 106, "middle", "Nil", "Triage card to Obsolete: you close it."],
  ["M260,272 H284 V128 H262", 289, 200, "start", "packet", "Working to Triage card: the worker hit a design decision and sent you a packet."],
  ["M140,352 H120 V204 H138", 116, 280, "middle", "CI red", "Merging to Ready: CI failed because of the branch; it goes back to the queue.", true],
  ["M140,432 H108 V190 H138", 104, 330, "middle", "rejected, reverted", "Needs your sign-off to Ready: you rejected it, Isomux Main reverted it, and it goes back to the queue with your note.", true],
  ["M140,444 H94 V176 H138", 90, 330, "middle", "edits requested", "Needs your sign-off to Ready: you requested edits, and a copy-edits task enters the queue.", true],
];
let pickedState = null;

function diagram(states) {
  const marker =
    '<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
    '<path d="M0,0 L8,4 L0,8 z" style="fill:var(--muted)"/></marker></defs>';
  const edges = EDGES.map(([d, x, y, anchor, label, help, up]) =>
    "<g>" + (help ? "<title>" + esc(help) + "</title>" : "") +
    '<path d="' + d + '" fill="none" style="stroke:var(--muted)" stroke-width="1.4" marker-end="url(#ah)"/>' +
    (label ? '<text x="' + x + '" y="' + y + '" text-anchor="' + anchor + '"' + (up ? ' transform="rotate(-90 ' + x + " " + y + ')"' : "") +
      ' font-size="10" style="fill:var(--muted)">' + esc(label) + "</text>" : "") +
    "</g>").join("");
  const boxes = Object.entries(BOX).map(([k, [x, y, w]]) => {
    const [label, help] = STATE_INFO[k];
    const n = states[k] ? states[k].count : 0;
    const cls = "st st-" + k + (pickedState === k ? " picked" : "");
    return '<g class="' + cls + '" data-state="' + k + '" role="button" tabindex="0"><title>' + esc(label + ": " + help + " Tap to list.") + "</title>" +
      '<rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="' + (w - 2) + '" height="42" rx="9"/>' +
      '<text x="' + (x + w / 2) + '" y="' + (y + 19) + '" text-anchor="middle" font-size="12" font-weight="600">' + esc(label) + "</text>" +
      '<text x="' + (x + w / 2) + '" y="' + (y + 36) + '" text-anchor="middle" font-size="13">' + n + "</text></g>";
  }).join("");
  return '<svg class="diagram" viewBox="0 0 400 536" role="img" aria-label="Task states">' + marker + edges + boxes + "</svg>";
}
function briefLine(t) {
  const when = t.closedAt ? " · closed " + clock(t.closedAt) : "";
  return taskLine({ id: t.id, title: t.title, priority: t.priority }, null, when);
}
function renderStates(b) {
  let h = "<h2" + tip("diagram") + ">Task states " + q("diagram") + "</h2>" + helpBox(["diagram"], "diagram") + diagram(b.states);
  if (b.states.other.count) h += '<div class="small"' + tip("other") + '><a href="#" data-state="other">' + b.states.other.count + (b.states.other.count === 1 ? " task fits" : " tasks fit") + " no state</a> " + q("other") + "</div>" + helpBox(["other"], "other");
  if (b.closedPending) h += '<div class="small">Reading close times: ' + b.closedPending + " tasks left.</div>";
  if (pickedState) {
    const v = b.states[pickedState];
    const [label, help] = pickedState === "other" ? ["Other", HELP.other] : STATE_INFO[pickedState];
    const recent = pickedState === "done" || pickedState === "obsolete";
    h += '<div class="picked-list"><h2 title="' + esc(help) + '">' + esc(label) + " (" + v.count + ")" + (recent ? " · last " + v.tasks.length : "") + "</h2>" +
      '<div class="small">' + esc(help) + "</div>" +
      (v.tasks.length ? v.tasks.map(briefLine).join("") : '<div class="small">None.</div>') + "</div>";
  }
  return h;
}

const TAB_HELP = { status: "tabStatus", open: "tabOpen", decided: "tabDecided", applied: "tabApplied", signoff: "tabSignoff" };

// title="" for hover.
function tip(key) {
  return ' title="' + esc(HELP[key] || key) + '"';
}
// A "?" that opens the help for a row on a phone. id makes it unique per card.
function q(key, id) {
  const k = key + ":" + (id || "");
  return '<button class="q' + (openHelp.has(k) ? " on" : "") + '" data-help="' + esc(k) + '"' +
    ' title="What is this?" aria-label="What is this?">?</button>';
}
function helpBox(keys, key, id) {
  if (!openHelp.has(key + ":" + (id || ""))) return "";
  return '<div class="helpbox">' + keys.map((k) => "<div>" + esc(HELP[k]) + "</div>").join("") + "</div>";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function clock(ms) {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 120 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago";
}
async function api(path, opts) {
  const res = await fetch(
    path,
    opts && { method: opts.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body ?? {}) },
  );
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

// --- routing -------------------------------------------------------------------

function readLocation() {
  if (location.pathname.startsWith("/signoff")) tab = "signoff";
}
function go(nextTab) {
  tab = nextTab;
  const path = tab === "signoff" ? "/signoff/" : "/";
  if (location.pathname !== path) history.pushState(null, "", path);
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => {
  readLocation();
  render();
});

async function load() {
  const [c, i, s, pk, so] = await Promise.allSettled([
    api("/api/summary"),
    api("/api/items?state=all"),
    api("/api/status"),
    api("/api/packets"),
    api("/api/signoff"),
  ]);
  if (c.status === "fulfilled") counts = c.value;
  if (i.status === "fulfilled") items = i.value;
  if (s.status === "fulfilled") loopState = s.value;
  if (pk.status === "fulfilled") packets = pk.value;
  if (so.status === "fulfilled") signoffData = so.value;
  render();
}

// --- shared -----------------------------------------------------------------

function itemState(i) {
  if (!i.decision) return "open";
  if (i.applied && i.applied.decidedAt === i.decision.decidedAt) return i.applied.ok ? "applied" : "failed";
  return "decided";
}
function renderTabs() {
  const pc = (st) => packets.filter((p) => st.includes(p.state)).length;
  const n = {
    open: (counts.open || 0) + pc(["open"]),
    decided: (counts.decided || 0) + (counts.failed || 0) + pc(["decided", "failed"]),
    applied: (counts.applied || 0) + pc(["applied"]),
    signoff: signoffData.items.filter((x) => x.state === "waiting").length,
  };
  document.getElementById("tabs").innerHTML = TABS.map(
    ([k, label]) =>
      '<button class="' + (k === tab ? "on" : "") + '" data-tab="' + k + '"' + tip(TAB_HELP[k]) + ">" + label + (k in n ? " (" + n[k] + ")" : "") + "</button>",
  ).join("");
}
function taskLine(t, who, extra) {
  const m = t.title.match(/^\[\s*([a-z]+)\s*\|\s*([^\]]*?)\s*\]\s*(.*)$/s);
  const tag = m ? '<span class="tag">' + esc(m[1]) + " · " + esc(m[2]) + "</span>" : "";
  return (
    '<div class="line">' +
    (who ? '<span class="who">' + esc(who) + "</span> · " : "") +
    '<span class="tag">' + esc(t.priority || "-") + "</span>" + tag + esc(m ? m[3] : t.title) +
    ' <span class="small">' + esc(t.id) + esc(extra || "") + "</span></div>"
  );
}
function section(title, key, lines, empty) {
  return (
    "<h2" + tip(key) + ">" + title + " " + q(key) + "</h2>" + helpBox([key], key) +
    (lines.length ? lines.join("") : '<div class="small">' + empty + "</div>")
  );
}

// --- status -----------------------------------------------------------------

function renderStatus() {
  const s = loopState;
  if (!s) return '<div class="empty">Loading.</div>';
  let h =
    '<div class="banner ' + (s.paused ? "paused" : "run") + '"><div><b>' +
    (s.paused ? "Paused: no dispatch, no tick" : "Running: dispatch and tick") + "</b>" +
    (s.paused && s.pausedSince ? '<div class="small">since ' + clock(s.pausedSince) + "</div>" : "") +
    '</div><span><button class="btn ghost" data-pause="' + (s.paused ? "resume" : "pause") + '"' + tip(s.paused ? "resume" : "pause") + ">" +
    (s.paused ? "Resume" : "Pause") + "</button> " + q("pause") + "</span></div>" + helpBox(["pause", "resume"], "pause");
  h += '<div class="row"><span class="label"' + tip("pairs") + ">Worker/reviewer pairs " + q("pairs") + "</span>" +
    helpBox(["pairs"], "pairs") +
    [1, 2, 3, 4, 5, 6].map((n) => '<button class="chip' + (n === s.workers ? " on" : "") + '" data-workers="' + n + '"' + tip("pairs") + ">" + n + "</button>").join("") +
    '<div class="small">The loop dispatches to Workers 1 to ' + s.workers + ". Lowering it takes no task away.</div></div>";
  const d = s.lastDispatch;
  const t = s.lastTick;
  h += '<div class="small"' + tip("runs") + ">Last dispatch: " + (d ? clock(d.at) : "not yet");
  if (d && d.error) h += ' · <span class="warn">' + esc(d.error) + "</span>";
  else if (d && d.result) h += " · " + d.result.assigned.length + " assigned" + (d.result.errors.length ? ' · <span class="warn">' + esc(d.result.errors.join("; ")) + "</span>" : "");
  h += "<br>Last tick: " + (t ? clock(t.at) : "not yet");
  if (t && t.error) h += ' · <span class="warn">' + esc(t.error) + "</span>";
  h += q("runs") + "</div>" + helpBox(["runs"], "runs");
  const sw = s.signoffWaiting || 0;
  h += '<div class="small"' + tip("signoffLine") + '>Sign-off: <a href="/signoff/" data-go="signoff">' + sw + " waiting</a> " + q("signoffLine") + "</div>" + helpBox(["signoffLine"], "signoffLine");
  if (s.error) return h + '<div class="err">Board unreadable: ' + esc(s.error) + "</div>";
  const b = s.board;
  h += renderStates(b);
  h += section("Working", "working", b.holding.map((x) => taskLine(x.task, x.worker)), "No worker holds a task.");
  h += '<div class="small" style="margin-top:6px"' + tip("free") + ">Free: " + (b.freeWorkers.length ? esc(b.freeWorkers.join(", ")) : "none") + " " + q("free") + "</div>" + helpBox(["free"], "free");
  h += section("Ready queue (" + b.ready.length + ")", "ready", b.ready.map((x) => taskLine(x)), "Nothing is ready.");
  h += section("Waiting to merge (" + b.merging.length + ")", "merging", b.merging.map((x) => taskLine(x)), "Nothing waits to merge.");
  const st = b.states;
  h += section("Never picked (" + st.never.count + ")", "never", st.never.tasks.map(briefLine), "No task is tagged authority.");
  h += section("Done (" + st.done.count + ") · last " + st.done.tasks.length, "recentDone", st.done.tasks.map(briefLine), "Nothing is done yet.");
  h += section("Obsolete (" + st.obsolete.count + ") · last " + st.obsolete.tasks.length, "recentObsolete", st.obsolete.tasks.map(briefLine), "Nothing is obsolete.");
  return h;
}

// --- triage -----------------------------------------------------------------

function chips(kind, list, chosen, proposed, id) {
  return list
    .map(
      (v) =>
        '<button class="chip' + (v === chosen ? " on" : "") + (v === proposed ? " proposed" : "") +
        '" data-pick="' + kind + '" data-id="' + esc(id) + '" data-v="' + v + '" title="' + esc(HELP[v] + (v === proposed ? " The curator proposes this." : "")) + '">' + v +
        (v === proposed ? '<span class="dot" aria-label="curator\'s proposal"></span>' : "") + "</button>",
    )
    .join("");
}
function filed(ms) {
  if (!ms) return "";
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? "today" : d === 1 ? "1 day ago" : d + " days ago";
}
// sel: the selection (open card) or the decision (decided card).
function head(i, sel, showProposal) {
  const p = i.proposal;
  const m = i.task.title.match(/^\[\s*([a-z]+)\s*\|\s*([^\]]*?)\s*\]/);
  const board = (i.task.priority || "no priority") + " · " + (m ? m[1] + " | " + m[2] : "no tag");
  return (
    '<div class="meta"' + tip("head") + "><span>Board: " + esc(board) + " → yours: <b>" + sel.priority + " · " + sel.class + " · " + sel.outcome +
    "</b></span>" + (showProposal ? "<span>curator proposed: " + p.priority + " · " + p.class + " · " + p.outcome + "</span>" : "") +
    q("head", i.taskId) + "</div>" + helpBox(["head"], "head", i.taskId) +
    '<div class="meta"' + tip("head") + "><span>Filed by " + esc(i.task.createdBy || "unknown") + "</span><span>" +
    filed(i.task.createdAt) + "</span><span>Task " + esc(i.taskId) + "</span></div>" +
    '<div class="title">' + esc(i.task.title) + "</div>"
  );
}
function body(i) {
  const p = i.proposal;
  let h = '<div class="why"><span class="label"' + tip("why") + ">Why</span><br>" + esc(p.why) + "</div>";
  if (p.outcome === "rescope" || p.title || p.scope) {
    h += '<div class="rescope"><span class="label"' + tip("scope") + ">Proposed scope</span>";
    if (p.title) h += '<div class="title">' + esc(p.title) + "</div>";
    if (p.scope) h += '<div class="desc">' + esc(p.scope) + "</div>";
    h += "</div>";
  }
  if (i.task.description)
    h += '<details><summary' + tip("description") + '>Current description</summary><div class="desc">' + esc(i.task.description) + "</div></details>";
  return h;
}
function row(label, kind, list, k, p, id) {
  return (
    '<div class="row"><span class="label"' + tip(kind) + ">" + label + " " + q(kind, id) + "</span>" +
    helpBox([kind].concat(list, ["dot"]), kind, id) + chips(kind, list, k[kind], p[kind], id) + "</div>"
  );
}
function openCard(i) {
  const wasTaste = i.proposal.class === "taste";
  const p = wasTaste ? { ...i.proposal, class: "decide" } : i.proposal;
  const k = picks[i.taskId] || (picks[i.taskId] = { priority: p.priority, class: p.class, outcome: p.outcome, note: "" });
  return (
    '<div class="card">' + head(i, k, false) + body(i) +
    row("Priority", "priority", PRIORITIES, k, p, i.taskId) +
    row("Class", "class", CLASSES, k, p, i.taskId) +
    (wasTaste ? '<div class="small warn"' + tip("wasTaste") + ">was taste: shown as decide</div>" : "") +
    row("Outcome", "outcome", OUTCOMES, k, p, i.taskId) +
    '<textarea rows="1" placeholder="Note for the curator (optional)" data-note="' + esc(i.taskId) + '"' + tip("note") + ">" + esc(k.note) + "</textarea>" +
    '<div class="err" data-err="' + esc(i.taskId) + '"></div>' +
    '<div class="actions"><button class="btn primary" data-decide="' + esc(i.taskId) + '"' + tip("confirm") + ">Confirm</button>" +
    '<button class="btn ghost" data-later="' + esc(i.taskId) + '"' + tip("later") + ">Later</button>" + q("actions", i.taskId) + "</div>" +
    helpBox(["confirm", "later", "note"], "actions", i.taskId) + "</div>"
  );
}
function decidedCard(i) {
  const d = i.decision;
  const s = itemState(i);
  const status =
    s === "applied" ? '<span class="ok"' + tip("applied") + ">On the board</span>"
    : s === "failed" ? '<span class="warn"' + tip("failed") + ">Failed: " + esc(i.applied.error || "no reason given") + "</span>"
    : "<span" + tip("pending") + ">Waiting for the curator</span>";
  const stateKey = s === "applied" ? "applied" : s === "failed" ? "failed" : "pending";
  let h =
    '<div class="card">' + head(i, d, true) +
    '<div class="why"><span class="label"' + tip("decision") + ">Your decision</span><br><b>" + d.priority + " · " + d.class + " · " + d.outcome + "</b>" +
    (d.note ? "<br>" + esc(d.note) : "") + "</div>" + '<div class="meta">' + status + q("state", i.taskId) + "</div>" +
    helpBox(s === "applied" ? [stateKey] : [stateKey, "undo"], "state", i.taskId);
  if (s !== "applied")
    h += '<div class="err" data-err="' + esc(i.taskId) + '"></div><div class="actions"><button class="btn ghost" data-undo="' + esc(i.taskId) + '"' + tip("undo") + ">Undo</button></div>";
  return h + "</div>";
}
function renderTriage() {
  const inTab = (s) => (tab === "decided" ? s === "decided" || s === "failed" : s === tab);
  let shown = items.filter((i) => inTab(itemState(i))).map((i) => ({ kind: "triage", x: i }));
  let pks = packets.filter((p) => inTab(p.state)).map((p) => ({ kind: "packet", x: p }));
  const lastLater = (list) => list.filter((e) => !later.has(e.x.taskId)).concat(list.filter((e) => later.has(e.x.taskId)));
  let all = pks.concat(shown);
  if (tab === "open") all = lastLater(all);
  if (tab === "applied") all.sort((a, b) => b.x.applied.at - a.x.applied.at);
  if (!all.length) return '<div class="empty">' + (tab === "open" ? "Nothing to review." : "Nothing here.") + "</div>";
  return all
    .map((e) =>
      e.kind === "packet" ? (tab === "open" ? packetCard(e.x) : decidedPacketCard(e.x)) : tab === "open" ? openCard(e.x) : decidedCard(e.x),
    )
    .join("");
}

// --- packets ------------------------------------------------------------------

// A small markdown subset, escaped first: headings, bold, code, lists, links.
function md(src) {
  const lines = esc(src).split("\n");
  let out = "";
  let inList = false;
  let inCode = false;
  for (const raw of lines) {
    if (raw.startsWith("```")) {
      out += inCode ? "</pre>" : (inList ? "</ul>" : "") + '<pre class="code">';
      inList = false;
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out += raw + "\n";
      continue;
    }
    let l = raw
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const li = l.match(/^\s*[-*] (.*)$/);
    if (li) {
      out += (inList ? "" : "<ul>") + "<li>" + li[1] + "</li>";
      inList = true;
      continue;
    }
    if (inList) {
      out += "</ul>";
      inList = false;
    }
    const hd = l.match(/^(#{1,4}) (.*)$/);
    out += hd ? '<div class="mdh">' + hd[2] + "</div>" : l.trim() ? "<p>" + l + "</p>" : "";
  }
  return out + (inList ? "</ul>" : "") + (inCode ? "</pre>" : "");
}
function imagesHtml(kind, taskId, images) {
  if (!images || !images.length) return "";
  return (
    '<div class="label"' + tip("images") + ">Screenshots " + q("images", kind + taskId) + "</div>" + helpBox(["images"], "images", kind + taskId) +
    '<div class="thumbs">' +
    images
      .map((im) => {
        const url = "/img/" + kind + "/" + encodeURIComponent(taskId) + "/" + im.file;
        return '<a href="' + url + '" target="_blank" rel="noopener" title="' + esc(im.caption || "Open full size") + '"><img src="' + url + '" alt="' + esc(im.caption) + '">' +
          (im.caption ? "<span>" + esc(im.caption) + "</span>" : "") + "</a>";
      })
      .join("") +
    "</div>"
  );
}
function packetHead(p) {
  return (
    '<div class="meta"' + tip("packet") + '><span class="badge">Design packet</span><span>' + esc(p.priority || "no priority") + "</span><span>Task " + esc(p.taskId) +
    "</span><span>" + clock(p.createdAt) + "</span>" + q("packet", p.taskId) + "</div>" + helpBox(["packet"], "packet", p.taskId) +
    '<div class="title">' + esc(p.title.replace(/^\[[^\]]*\]\s*/, "")) + "</div>"
  );
}
function packetCard(p) {
  const rec = p.options.find((o) => o.recommended);
  const k = packetPicks[p.taskId] || (packetPicks[p.taskId] = { choice: rec ? rec.label : null, note: "" });
  const opt = (o) =>
    '<button class="option' + (k.choice === o.label ? " on" : "") + '" data-pchoice="' + esc(o.label) + '" data-id="' + esc(p.taskId) + '"' +
    ' title="' + esc(o.label + (o.cost ? ": " + o.cost : "") + (o.recommended ? " The worker recommends this." : "")) + '">' +
    "<b>" + esc(o.label) + "</b>" + (o.recommended ? '<span class="dot"></span>' : "") + (o.cost ? '<span class="cost">' + esc(o.cost) + "</span>" : "") + "</button>";
  const extra = (c) =>
    '<button class="chip' + (k.choice === c ? " on" : "") + '" data-pchoice="' + c + '" data-id="' + esc(p.taskId) + '"' + tip(c) + ">" + c + "</button>";
  let links = "";
  if (p.branch) links += "<span>Branch <code>" + esc(p.branch) + "</code></span>";
  if (p.diffUrl) links += '<a href="' + esc(p.diffUrl) + '" target="_blank" rel="noopener">Diff</a>';
  return (
    '<div class="card packet">' + packetHead(p) +
    '<div class="question"' + tip("question") + ">" + esc(p.question) + "</div>" +
    (p.body ? "<details><summary" + tip("packetBody") + ">The packet</summary><div class=\"mdbody\">" + md(p.body) + "</div></details>" : "") +
    imagesHtml("packets", p.taskId, p.images) +
    (links ? '<div class="links"' + tip("links") + ">" + links + "</div>" : "") +
    '<div class="row"><span class="label"' + tip("options") + ">Options " + q("options", p.taskId) + "</span>" + helpBox(["options", "dot"], "options", p.taskId) +
    '<div class="options">' + p.options.map(opt).join("") + "</div></div>" +
    '<div class="row"><span class="label"' + tip("extras") + ">Or " + q("extras", p.taskId) + "</span>" + helpBox(["rescope", "obsolete", "research more"], "extras", p.taskId) +
    EXTRA_CHOICES.map(extra).join("") + "</div>" +
    '<textarea rows="1" placeholder="Note (needed for rescope)" data-pnote="' + esc(p.taskId) + '"' + tip("note") + ">" + esc(k.note) + "</textarea>" +
    '<div class="err" data-err="' + esc(p.taskId) + '"></div>' +
    '<div class="actions"><button class="btn primary" data-pdecide="' + esc(p.taskId) + '"' + tip("packetConfirm") + ">Confirm</button>" +
    '<button class="btn ghost" data-later="' + esc(p.taskId) + '"' + tip("later") + ">Later</button>" + q("pactions", p.taskId) + "</div>" +
    helpBox(["packetConfirm", "later", "note"], "pactions", p.taskId) + "</div>"
  );
}
function decidedPacketCard(p) {
  const d = p.decision;
  const s = p.state;
  const status =
    s === "applied" ? '<span class="ok"' + tip("applied") + ">On the board</span>"
    : s === "failed" ? '<span class="warn"' + tip("failed") + ">Failed: " + esc(p.applied.error || "no reason given") + "</span>"
    : "<span" + tip("pending") + ">Waiting for the curator</span>";
  const rec = p.options.find((o) => o.recommended);
  let h =
    '<div class="card packet">' + packetHead(p) + '<div class="question">' + esc(p.question) + "</div>" +
    '<div class="why"><span class="label"' + tip("decision") + ">Your decision</span><br><b>" + esc(d.choice) + "</b>" +
    (rec ? ' <span class="small">(worker recommended ' + esc(rec.label) + ")</span>" : "") + (d.note ? "<br>" + esc(d.note) : "") + "</div>" +
    '<div class="meta">' + status + "</div>";
  if (s !== "applied")
    h += '<div class="err" data-err="' + esc(p.taskId) + '"></div><div class="actions"><button class="btn ghost" data-pundo="' + esc(p.taskId) + '"' + tip("undo") + ">Undo</button></div>";
  return h + "</div>";
}

// --- copy -------------------------------------------------------------------

// Word-level diff (LCS). Too long a pair is shown without marks.
function diff(a, b) {
  const x = a.split(/(\s+)/);
  const y = b.split(/(\s+)/);
  if (x.length * y.length > 4_000_000) return [esc(a), esc(b)];
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0;
  let j = 0;
  let oldH = "";
  let newH = "";
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      oldH += esc(x[i]);
      newH += esc(y[j]);
      i++;
      j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) {
      newH += /^\s+$/.test(y[j]) ? esc(y[j]) : "<ins>" + esc(y[j]) + "</ins>";
      j++;
    } else {
      oldH += /^\s+$/.test(x[i]) ? esc(x[i]) : "<del>" + esc(x[i]) + "</del>";
      i++;
    }
  }
  return [oldH, newH];
}
// --- sign-off -----------------------------------------------------------------

// Source files wrap prose at a fixed width; a single line break inside a
// paragraph is not part of the copy. Blank lines, list items, headings,
// quotes and table rows keep their breaks.
function unwrap(text) {
  const block = (l) => /^\s*([-*+>|#]|\d+[.)]\s)/.test(l) || /^\s/.test(l);
  const lines = text.split("\n");
  let out = lines[0] ?? "";
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    const join = prev.trim() && cur.trim() && !block(cur) && !/^\s*(#|\|)/.test(prev);
    out += (join ? " " : "\n") + cur;
  }
  return out;
}

// Nil's comments per sign-off item, kept here while he types and saved to the app.
const soComments = {};
const commentTimers = {};
function commentsOf(it) {
  return soComments[it.taskId] || (soComments[it.taskId] = JSON.parse(JSON.stringify(it.comments || { copy: {}, images: {} })));
}
function hasComments(taskId) {
  const c = soComments[taskId];
  return Boolean(c && [...Object.values(c.copy), ...Object.values(c.images)].some((v) => v && v.trim()));
}
function commentBox(it, kind, n) {
  const v = commentsOf(it)[kind][String(n)] || "";
  return '<textarea rows="1" class="comment" placeholder="Comment: a note, or new text in quotes" data-comment="' +
    esc(it.taskId) + ":" + kind + ":" + n + '"' + tip("comment") + ">" + esc(v) + "</textarea>";
}
function renderSignoff() {
  const so = signoffData;
  const sha = so.lastSha ? so.lastSha.commit : null;
  let h =
    '<div class="banner ' + (so.push.ok ? "run" : "paused") + '"><div><b' + tip("push") + ">Push go</b>" +
    '<div class="small"' + tip("sha") + ">main " + (sha ? "<code>" + esc(sha.slice(0, 10)) + "</code> · " + clock(so.lastSha.at) : "not reported yet") + "</div>" +
    (so.push.ok ? "" : '<div class="small">' + esc(so.push.reason) + "</div>") +
    '</div><span><button class="btn primary" data-push="1"' + (so.push.ok ? "" : " disabled") + tip("push") + ">Approve and push</button> " + q("push") + "</span></div>" +
    helpBox(["push", "sha"], "push") + '<div class="err" data-err="push"></div>';
  if (!so.items.length) return h + '<div class="empty">No merged copy or visible change waits for sign-off.</div>';
  for (const it of so.items) {
    const waiting = it.state === "waiting";
    const stateText =
      it.state === "approved" ? '<span class="ok"' + tip("approvedSign") + ">Approved</span>"
      : it.state === "rejected" ? '<span class="warn"' + tip("rejected") + ">Rejected, waiting for revert: " + esc(it.decision.note) + "</span>"
      : it.state === "edits" ? '<span class="warn"' + tip("editsSign") + ">Edits requested: task " + esc(it.decision.edits) + (it.editsSettled ? " (signed off)" : " (waiting for its sign-off)") + "</span>"
      : "<span" + tip("waitingSign") + ">Waiting for you</span>";
    h += '<div class="card signoff-card"><div class="sotitle">' + esc(it.title) + "</div>" +
      '<div class="meta"><span>Task ' + esc(it.taskId) + "</span><span" + tip("sha") + ">commit <code>" + esc(it.merged.commit.slice(0, 10)) + "</code></span><span>merged " +
      clock(it.merged.at) + "</span>" + stateText + "</div>";
    if (it.summary) h += '<div class="mdbody"' + tip("summary") + ">" + md(it.summary) + "</div>";
    it.copy.forEach((c, n) => {
      const [o, nw] = diff(unwrap(c.old || ""), unwrap(c.new));
      h += '<div class="entry"><div class="where"' + tip("where") + ">" + esc(c.where) + "</div>" +
        '<div class="cols"><div><h2' + tip("old") + '>Old</h2><div class="copytext">' + (c.old ? o : '<span class="small">New copy</span>') +
        '</div></div><div><h2' + tip("new") + '>New</h2><div class="copytext">' + nw + "</div></div></div>" +
        (waiting ? commentBox(it, "copy", n) : "") + "</div>";
    });
    // Before/after pairs side by side (one comment each, kept on the pair's
    // first image); lone images as thumbnails with their own comment.
    const imgUrl = (im) => "/img/signoff/" + encodeURIComponent(it.taskId) + "/" + im.file;
    const pairs = [];
    const lone = [];
    it.images.forEach((im, n) => {
      if (!im.pair) return lone.push([im, n]);
      let pr = pairs.find((x) => x.name === im.pair);
      if (!pr) pairs.push((pr = { name: im.pair, first: n }));
      pr[im.side] = im;
    });
    for (const pr of pairs) {
      const side = (im, label, key) =>
        "<div><h2" + tip(key) + ">" + label + "</h2>" +
        (im
          ? '<a class="pairimg" href="' + imgUrl(im) + '" target="_blank" rel="noopener" title="' + esc(im.caption || "Open full size") + '"><img src="' + imgUrl(im) + '" alt="' + esc(im.caption) + '"></a>' +
            (im.caption ? '<div class="small">' + esc(im.caption) + "</div>" : "")
          : '<div class="copytext small">No ' + label.toLowerCase() + " image</div>") +
        "</div>";
      h += '<div class="entry"><div class="where"' + tip("pairImages") + ">Screenshots: " + esc(pr.name) + " " + q("pairImages", it.taskId + pr.name) + "</div>" +
        helpBox(["pairImages"], "pairImages", it.taskId + pr.name) +
        '<div class="cols">' + side(pr.before, "Before", "before") + side(pr.after, "After", "after") + "</div>" +
        (waiting ? commentBox(it, "images", pr.first) : "") + "</div>";
    }
    if (lone.length) {
      h += '<div class="entry"><div class="where"' + tip("images") + ">Screenshots " + q("images", "signoff" + it.taskId) + "</div>" + helpBox(["images"], "images", "signoff" + it.taskId) + '<div class="shots">';
      for (const [im, n] of lone)
        h += '<div class="shot"><a href="' + imgUrl(im) + '" target="_blank" rel="noopener" title="' + esc(im.caption || "Open full size") + '"><img src="' + imgUrl(im) + '" alt="' + esc(im.caption) + '"></a>' +
          (im.caption ? '<div class="small">' + esc(im.caption) + "</div>" : "") + (waiting ? commentBox(it, "images", n) : "") + "</div>";
      h += "</div></div>";
    }
    h += '<div class="err" data-err="' + esc(it.taskId) + '"></div>';
    if (waiting)
      h += '<div class="entry"><textarea rows="1" placeholder="Why you reject it (needed to reject)" data-rnote="' + esc(it.taskId) + '"' + tip("rejectNote") + ">" + esc(rejectNotes[it.taskId] || "") + "</textarea>" +
        '<div class="actions"><button class="btn primary" data-approve="' + esc(it.taskId) + '"' + tip("approve") + ">Approve</button>" +
        '<button class="btn ghost" data-edits="' + esc(it.taskId) + '"' + (hasComments(it.taskId) ? "" : " disabled") + tip("requestEdits") + ">Request edits</button>" +
        '<button class="btn ghost" data-reject="' + esc(it.taskId) + '"' + tip("reject") + ">Reject</button>" + q("sactions", it.taskId) + "</div>" +
        helpBox(["approve", "requestEdits", "reject", "comment", "rejectNote"], "sactions", it.taskId) + "</div>";
    if (it.state === "approved")
      h += '<div class="actions"><button class="btn ghost" data-sundo="' + esc(it.taskId) + '"' + tip("undoApprove") + ">Undo</button></div>";
    h += "</div>";
  }
  return h;
}

// --- render and events ----------------------------------------------------------

function render() {
  renderTabs();
  const el = document.getElementById("list");
  // Sign-off and Triage use a wide screen; the status page keeps its column.
  el.className = tab === "signoff" ? "wide" : tab === "status" ? "" : "medium";
  el.innerHTML = tab === "status" ? renderStatus() : tab === "signoff" ? renderSignoff() : renderTriage();
}
function showErr(id, msg) {
  const el = document.querySelector('[data-err="' + CSS.escape(id) + '"]');
  if (el) el.textContent = msg;
}
document.addEventListener("click", async (e) => {
  const st = e.target.closest("[data-state]");
  if (st) {
    e.preventDefault();
    pickedState = pickedState === st.dataset.state ? null : st.dataset.state;
    render();
    const list = document.querySelector(".picked-list");
    if (list) list.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const a = e.target.closest("a[data-go]");
  if (a) {
    e.preventDefault();
    go(a.dataset.go);
    return;
  }
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.help) {
    if (openHelp.has(d.help)) openHelp.delete(d.help);
    else openHelp.add(d.help);
    return render();
  }
  if (d.tab) return go(d.tab);
  const act = async (id, fn) => {
    try {
      t.disabled = true;
      await fn();
      await load();
    } catch (err) {
      t.disabled = false;
      showErr(id, err.message);
    }
  };
  if (d.pchoice) {
    packetPicks[d.id].choice = d.pchoice;
    return render();
  }
  if (d.pdecide) {
    const k = packetPicks[d.pdecide];
    if (!k.choice) return showErr(d.pdecide, "Pick an option first.");
    if (k.choice === "rescope" && !k.note.trim()) return showErr(d.pdecide, "A rescope needs a note with the new scope.");
    return act(d.pdecide, async () => {
      await api("/api/packets/" + encodeURIComponent(d.pdecide) + "/decide", { method: "POST", body: k });
      later.delete(d.pdecide);
    });
  }
  if (d.pundo) return act(d.pundo, () => api("/api/packets/" + encodeURIComponent(d.pundo) + "/undo", { method: "POST" }));
  if (d.approve) return act(d.approve, () => api("/api/signoff/" + encodeURIComponent(d.approve) + "/approve", { method: "POST" }));
  if (d.sundo) return act(d.sundo, () => api("/api/signoff/" + encodeURIComponent(d.sundo) + "/undo", { method: "POST" }));
  if (d.edits)
    return act(d.edits, async () => {
      clearTimeout(commentTimers[d.edits]);
      await api("/api/signoff/" + encodeURIComponent(d.edits) + "/comments", { method: "POST", body: soComments[d.edits] });
      await api("/api/signoff/" + encodeURIComponent(d.edits) + "/edits", { method: "POST" });
    });
  if (d.reject) {
    const note = (rejectNotes[d.reject] || "").trim();
    if (!note) return showErr(d.reject, "Write why you reject it first.");
    return act(d.reject, async () => {
      clearTimeout(commentTimers[d.reject]);
      if (soComments[d.reject]) await api("/api/signoff/" + encodeURIComponent(d.reject) + "/comments", { method: "POST", body: soComments[d.reject] });
      await api("/api/signoff/" + encodeURIComponent(d.reject) + "/reject", { method: "POST", body: { note } });
      delete rejectNotes[d.reject];
    });
  }
  if (d.push) return act("push", () => api("/api/signoff/push", { method: "POST" }));
  if (d.pick) {
    picks[d.id][d.pick] = d.v;
    return render();
  }
  if (d.later) {
    later.add(d.later);
    return render();
  }
  if (d.workers) {
    try {
      t.disabled = true;
      await api("/api/settings", { method: "POST", body: { workers: Number(d.workers) } });
    } finally {
      await load();
    }
    return;
  }
  if (d.pause) {
    try {
      t.disabled = true;
      await api("/api/" + d.pause, { method: "POST" });
    } finally {
      await load();
    }
    return;
  }
  if (d.decide) {
    const k = picks[d.decide];
    if (k.outcome === "rescope") {
      const i = items.find((x) => x.taskId === d.decide);
      if (!i.proposal.title && !i.proposal.scope && !k.note.trim()) return showErr(d.decide, "A rescope needs a note with the new scope.");
    }
    try {
      t.disabled = true;
      await api("/api/items/" + encodeURIComponent(d.decide) + "/decide", { method: "POST", body: k });
      later.delete(d.decide);
      await load();
    } catch (err) {
      t.disabled = false;
      showErr(d.decide, err.message);
    }
    return;
  }
  if (d.undo) {
    try {
      await api("/api/items/" + encodeURIComponent(d.undo) + "/undo", { method: "POST" });
      await load();
    } catch (err) {
      showErr(d.undo, err.message);
    }
  }
});
document.addEventListener("input", (e) => {
  const ds = e.target.dataset || {};
  if (ds.note !== undefined && picks[ds.note]) picks[ds.note].note = e.target.value;
  if (ds.pnote !== undefined && packetPicks[ds.pnote]) packetPicks[ds.pnote].note = e.target.value;
  if (ds.rnote !== undefined) rejectNotes[ds.rnote] = e.target.value;
  if (ds.comment !== undefined) {
    const [taskId, kind, n] = ds.comment.split(":");
    const c = soComments[taskId];
    if (!c) return;
    c[kind][n] = e.target.value;
    const btn = document.querySelector('[data-edits="' + CSS.escape(taskId) + '"]');
    if (btn) btn.disabled = !hasComments(taskId);
    clearTimeout(commentTimers[taskId]);
    commentTimers[taskId] = setTimeout(() => {
      api("/api/signoff/" + encodeURIComponent(taskId) + "/comments", { method: "POST", body: c }).catch((err) => showErr(taskId, err.message));
    }, 600);
  }
});
readLocation();
// Open on triage while proposals wait for Nil, else on the status.
load().then(() => {
  if (tab === "status" && (counts.open > 0 || packets.some((p) => p.state === "open"))) {
    tab = "open";
    render();
  }
});
setInterval(() => {
  if (!document.activeElement || document.activeElement.tagName !== "TEXTAREA") load();
}, 60000);
