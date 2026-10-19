// The loop app's page: status, triage and copy sign-off. Plain JS, no build.
const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"];
const CLASSES = ["auto", "decide", "taste", "authority"];
const OUTCOMES = ["keep", "rescope", "obsolete"];
const TABS = [
  ["status", "Status"],
  ["open", "To review"],
  ["decided", "Decided"],
  ["applied", "Applied"],
  ["copy", "Copy"],
];
let tab = "status";
let copyId = null;
let items = [];
let counts = {};
let loopState = null;
let copies = [];
const later = new Set();
const picks = {};
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
  taste: "taste: copy or a look you approve before it merges.",
  authority: "authority: the loop never touches it. Also for work run outside the loop.",
  keep: "keep: the task stays as it is, with the priority and class above.",
  rescope: "rescope: the task is rewritten to the proposed scope, or to the scope in your note.",
  obsolete: "obsolete: the task is closed, with the reason. Reversible: it can be reopened.",
  priority: "Which priority the task gets. The loop takes P0 first, then P1 to P3, oldest first within one. P4 is backlog: never picked.",
  class: "What kind of work it is, which decides how far the loop goes alone.",
  outcome: "What happens to the task itself.",
  head: "Facts about the task and the curator's proposal; nothing here needs you. \"Proposed\" is the curator's suggestion, already selected in the rows below. You decide with those rows.",
  why: "The curator's reason for its proposal.",
  scope: "The new title and description the curator proposes for this task.",
  description: "The task's description on the board today.",
  note: "Optional words for the curator, for example a different scope. It reads them when it writes your decision to the board.",
  confirm: "Confirm saves your choice in the rows above. The curator writes it to the board a few minutes after your last decision; until then you can undo it in Decided.",
  later: "Later moves this card to the end of the list. Nothing is saved.",
  undo: "Undo takes the decision back while the curator has not written it to the board yet.",
  decision: "What you chose for this task.",
  applied: "On the board: the curator wrote your decision to the board.",
  waiting: "Waiting for the curator: saved here; the curator writes it to the board a few minutes after your last decision.",
  failed: "Failed: the curator could not write it to the board. It tries again with the next batch.",
  pause: "Pause stops dispatch and the hourly tick. Workers keep the tasks they hold.",
  resume: "Resume starts dispatch (every 2 minutes) and the hourly tick again.",
  pairs: "How many worker/reviewer pairs the loop uses: it gives new tasks to Workers 1 to N. Lowering it takes no task away.",
  runs: "Dispatch gives free workers the next ready task every 2 minutes. The tick nudges idle workers once an hour.",
  working: "Workers that hold a task now.",
  free: "Loop workers without a task. They get the next ready task at the next dispatch.",
  ready: "Tasks the loop can take now, in the order it takes them.",
  merging: "Approved work that Isomux Main merges after CI.",
  waiting: "Waiting for Nil: tag [auto | nil], [decide | nil] or [taste | nil]. A packet, taste screenshots or a question waits for you (an ask in your Inbox).",
  never: "Never picked: tag [authority | ...]. The loop never touches it; also for work run outside the loop.",
  diagram: "Every task of the room is in exactly one of these ten states, read from the board now. Tap a state to list its tasks. Arrows show who moves a task on.",
  other: "Tasks that fit none of the ten states, for example a tag the loop does not know or batch work outside the loop.",
  recentDone: "The last 20 tasks closed as done, newest first.",
  recentObsolete: "The last 20 tasks closed as obsolete, newest first.",
  tabStatus: "The loop now: pause, workers, queue, merges and what waits for you.",
  tabOpen: "The curator's proposals that wait for your decision.",
  tabDecided: "Your decisions that the curator has not written to the board yet. You can undo them.",
  tabApplied: "Decisions the curator wrote to the board.",
  tabCopy: "Copy that waits for your sign-off, old next to new.",
  old: "The text as it is now. Struck words go away.",
  new: "The text as proposed. Marked words are new.",
};
// The ten states: label, definition (board facts), and place in the diagram.
const STATE_INFO = {
  filed: ["Filed", "Open, no tag in the title, no proposal in the app yet. The loop never picks it."],
  proposed: ["Proposed", "A curator proposal waits in triage for your decision."],
  ready: ["Ready", "Tag [auto | ready], [decide | ready] or [taste | ready], open, no assignee, P0-P3. The loop picks these."],
  working: ["Working", "In progress, assigned to an Isomux Worker."],
  waiting: ["Waiting for Nil", "Tag [auto | nil], [decide | nil] or [taste | nil]: a packet, taste screenshots or a question waits for you (an ask in your Inbox)."],
  merging: ["Merging", "Tag [<class> | merging], in progress, no assignee. Isomux Main merges it after CI."],
  never: ["Never picked", "Tag [authority | ...]. The loop never touches it."],
  backlog: ["Backlog", "P4. The loop never picks it."],
  done: ["Done", "Status done."],
  obsolete: ["Obsolete", "Status obsolete: closed, and reversible."],
};
const BOX = {
  filed: [140, 10, 120], proposed: [140, 90, 120], ready: [140, 170, 120], working: [140, 250, 120],
  merging: [140, 330, 120], done: [140, 410, 120],
  never: [0, 40, 100], backlog: [0, 110, 100], obsolete: [300, 90, 100], waiting: [300, 250, 100],
};
// [path, label x, label y, anchor, label, help]
const EDGES = [
  ["M200,56 V88", 206, 76, "start", "curator", "Filed to Proposed: the curator proposes a review."],
  ["M200,136 V168", 206, 156, "start", "Nil", "Proposed to Ready: you confirm it with a loop class."],
  ["M200,216 V248", 206, 236, "start", "app", "Ready to Working: the app gives it to a free worker."],
  ["M200,296 V328", 206, 316, "start", "approved", "Working to Merging: the reviewer approved the work."],
  ["M200,376 V408", 206, 396, "start", "CI green", "Merging to Done: CI passed and Isomux Main merged it."],
  ["M140,104 L102,68", 121, 115, "middle", "Nil", "Proposed to Never picked or Backlog: your decision."],
  ["M140,120 L102,128", null],
  ["M260,112 H298", 279, 106, "middle", "Nil", "Proposed to Obsolete: you close it."],
  ["M260,272 H298", 279, 266, "middle", "to Nil", "Working to Waiting for Nil: a decision packet, taste screenshots or a scope question."],
  ["M350,250 V136", 355, 196, "start", "Nil: no", "Waiting for Nil to Obsolete: you said no."],
  ["M300,258 L262,206", 303, 234, "start", "Nil: go", "Waiting for Nil to Ready: you said go."],
  ["M300,288 L262,344", 303, 322, "start", "Nil approves", "Waiting for Nil to Merging: you approved a taste branch."],
  ["M140,352 H118 V192 H138", 114, 276, "end", "CI red", "Merging to Ready: CI failed because of the branch; it goes back to the queue."],
];
let pickedState = null;

function diagram(states) {
  const marker =
    '<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
    '<path d="M0,0 L8,4 L0,8 z" style="fill:var(--muted)"/></marker></defs>';
  const edges = EDGES.map(([d, x, y, anchor, label, help]) =>
    "<g>" + (help ? "<title>" + esc(help) + "</title>" : "") +
    '<path d="' + d + '" fill="none" style="stroke:var(--muted)" stroke-width="1.4" marker-end="url(#ah)"/>' +
    (label ? '<text x="' + x + '" y="' + y + '" text-anchor="' + anchor + '" font-size="10" style="fill:var(--muted)">' + esc(label) + "</text>" : "") +
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
  return '<svg class="diagram" viewBox="0 0 400 456" role="img" aria-label="Task states">' + marker + edges + boxes + "</svg>";
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

const TAB_HELP = { status: "tabStatus", open: "tabOpen", decided: "tabDecided", applied: "tabApplied", copy: "tabCopy" };

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
  const m = location.pathname.match(/^\/copy\/([^/]+)/);
  if (m) {
    tab = "copy";
    copyId = decodeURIComponent(m[1]);
  } else if (location.pathname === "/") {
    copyId = null;
  }
}
function go(nextTab, nextCopyId) {
  tab = nextTab;
  copyId = nextCopyId ?? null;
  const path = copyId ? "/copy/" + encodeURIComponent(copyId) : "/";
  if (location.pathname !== path) history.pushState(null, "", path);
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => {
  readLocation();
  render();
});

async function load() {
  const [c, i, s, cp] = await Promise.allSettled([
    api("/api/summary"),
    api("/api/items?state=all"),
    api("/api/status"),
    api("/api/copy"),
  ]);
  if (c.status === "fulfilled") counts = c.value;
  if (i.status === "fulfilled") items = i.value;
  if (s.status === "fulfilled") loopState = s.value;
  if (cp.status === "fulfilled") copies = cp.value;
  render();
}

// --- shared -----------------------------------------------------------------

function itemState(i) {
  if (!i.decision) return "open";
  if (i.applied && i.applied.decidedAt === i.decision.decidedAt) return i.applied.ok ? "applied" : "failed";
  return "decided";
}
function renderTabs() {
  const n = {
    open: counts.open || 0,
    decided: (counts.decided || 0) + (counts.failed || 0),
    applied: counts.applied || 0,
    copy: copies.length,
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
  if (s.error) return h + '<div class="err">Board unreadable: ' + esc(s.error) + "</div>";
  const b = s.board;
  h += renderStates(b);
  h += section("Working", "working", b.holding.map((x) => taskLine(x.task, x.worker)), "No worker holds a task.");
  h += '<div class="small" style="margin-top:6px"' + tip("free") + ">Free: " + (b.freeWorkers.length ? esc(b.freeWorkers.join(", ")) : "none") + " " + q("free") + "</div>" + helpBox(["free"], "free");
  h += section("Ready queue (" + b.ready.length + ")", "ready", b.ready.map((x) => taskLine(x)), "Nothing is ready.");
  h += section("Waiting to merge (" + b.merging.length + ")", "merging", b.merging.map((x) => taskLine(x)), "Nothing waits to merge.");
  const st = b.states;
  h += section("Waiting for Nil (" + st.waiting.count + ")", "waiting", st.waiting.tasks.map(briefLine), "Nothing waits for you.");
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
        '" data-pick="' + kind + '" data-id="' + esc(id) + '" data-v="' + v + '"' + tip(v) + ">" + v + "</button>",
    )
    .join("");
}
function filed(ms) {
  if (!ms) return "";
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? "today" : d === 1 ? "1 day ago" : d + " days ago";
}
function head(i) {
  const p = i.proposal;
  const now = i.task.priority ? "now " + esc(i.task.priority) : "no priority now";
  return (
    '<div class="meta"' + tip("head") + "><span>Proposed: <b>" + p.priority + " · " + p.class + " · " + p.outcome +
    "</b> (" + now + ")</span>" + q("head", i.taskId) + "</div>" + helpBox(["head"], "head", i.taskId) +
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
    helpBox([kind].concat(list), kind, id) + chips(kind, list, k[kind], p[kind], id) + "</div>"
  );
}
function openCard(i) {
  const p = i.proposal;
  const k = picks[i.taskId] || (picks[i.taskId] = { priority: p.priority, class: p.class, outcome: p.outcome, note: "" });
  return (
    '<div class="card">' + head(i) + body(i) +
    row("Priority", "priority", PRIORITIES, k, p, i.taskId) +
    row("Class", "class", CLASSES, k, p, i.taskId) +
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
    : "<span" + tip("waiting") + ">Waiting for the curator</span>";
  const stateKey = s === "applied" ? "applied" : s === "failed" ? "failed" : "waiting";
  let h =
    '<div class="card">' + head(i) +
    '<div class="why"><span class="label"' + tip("decision") + ">Your decision</span><br><b>" + d.priority + " · " + d.class + " · " + d.outcome + "</b>" +
    (d.note ? "<br>" + esc(d.note) : "") + "</div>" + '<div class="meta">' + status + q("state", i.taskId) + "</div>" +
    helpBox(s === "applied" ? [stateKey] : [stateKey, "undo"], "state", i.taskId);
  if (s !== "applied")
    h += '<div class="err" data-err="' + esc(i.taskId) + '"></div><div class="actions"><button class="btn ghost" data-undo="' + esc(i.taskId) + '"' + tip("undo") + ">Undo</button></div>";
  return h + "</div>";
}
function renderTriage() {
  let shown = items.filter((i) => {
    const s = itemState(i);
    return tab === "decided" ? s === "decided" || s === "failed" : s === tab;
  });
  if (tab === "open") shown = shown.filter((i) => !later.has(i.taskId)).concat(shown.filter((i) => later.has(i.taskId)));
  if (tab === "applied") shown.sort((a, b) => b.applied.at - a.applied.at);
  if (!shown.length) return '<div class="empty">' + (tab === "open" ? "Nothing to review." : "Nothing here.") + "</div>";
  return shown.map((i) => (tab === "open" ? openCard(i) : decidedCard(i))).join("");
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
function renderCopy() {
  if (copyId) {
    const c = copies.find((x) => x.taskId === copyId);
    if (!c) return '<p><a href="/" data-copy-list="1">All copy</a></p><div class="empty">No copy waits for this task.</div>';
    const [o, n] = diff(c.old || "", c.new);
    return (
      '<p><a href="/" data-copy-list="1">All copy</a></p><div class="title">' + esc(c.title) + "</div>" +
      '<div class="small">' + esc(c.taskId) + " · updated " + clock(c.updatedAt) + "</div>" +
      '<div class="cols"><div><h2' + tip("old") + '>Old</h2><div class="copytext">' + (c.old ? o : '<span class="small">New copy</span>') +
      '</div></div><div><h2' + tip("new") + '>New</h2><div class="copytext">' + n + "</div></div></div>"
    );
  }
  if (!copies.length) return '<div class="empty">No copy waits for sign-off.</div>';
  return copies
    .map(
      (c) =>
        '<div class="line"><a href="/copy/' + encodeURIComponent(c.taskId) + '" data-copy="' + esc(c.taskId) + '">' +
        esc(c.title) + '</a> <span class="small">' + esc(c.taskId) + " · " + clock(c.updatedAt) + "</span></div>",
    )
    .join("");
}

// --- render and events ----------------------------------------------------------

function render() {
  renderTabs();
  const el = document.getElementById("list");
  el.innerHTML = tab === "status" ? renderStatus() : tab === "copy" ? renderCopy() : renderTriage();
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
  const a = e.target.closest("a[data-copy], a[data-copy-list]");
  if (a) {
    e.preventDefault();
    go("copy", a.dataset.copy || null);
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
  const id = e.target.dataset && e.target.dataset.note;
  if (id !== undefined && picks[id]) picks[id].note = e.target.value;
});
readLocation();
// Open on triage while proposals wait for Nil, else on the status.
load().then(() => {
  if (!copyId && tab === "status" && counts.open > 0) {
    tab = "open";
    render();
  }
});
setInterval(() => {
  if (!document.activeElement || document.activeElement.tagName !== "TEXTAREA") load();
}, 60000);
