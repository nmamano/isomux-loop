// The loop app's page: status, triage (proposals and packets) and sign-off. Plain JS, no build.
// Nil, 2026-10-19: one choice per card (no class + outcome, no P4 priority).
// go, design and hold take a priority; backlog sets P4; obsolete closes.
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const CHOICES = ["go", "design", "hold", "backlog", "obsolete"];
const TAGGED = ["go", "design", "hold"];
const tagged = (c) => TAGGED.includes(c);
const CLASS_LABEL = { hold: "on hold" };
const EFFORTS = ["S", "M", "L", "XL"];
const TABS = [
  ["status", "Status"],
  ["open", "Triage"],
  ["decided", "Decided"],
  ["applied", "Past decisions"],
  ["backlog", "Backlog"],
  ["signoff", "Sign-off"],
  ["push", "Push"],
];
let tab = "status";
let items = [];
let counts = {};
let loopState = null;
let packets = [];
let backlogTasks = [];
const backlogPicks = {};
let signoffData = { items: [], push: { ok: false, reason: "" } };
const later = new Set();
const picks = {};
const packetPicks = {};
const rejectNotes = {};
// Help rows opened with "?" (for phones, where hover does not exist).
const openHelp = new Set();
// Descriptions the reader opened, by key: a render keeps them open.
const openDetails = new Set();
// The diagram beside Triage, and its width in percent; kept in this browser.
const split = Object.assign({ on: false, pct: 38 }, JSON.parse(localStorage.getItem("loop.split") || "{}"));
const saveSplit = () => localStorage.setItem("loop.split", JSON.stringify(split));
// Below this width the page shows one view; the CSS uses the same number.
const wideScreen = window.matchMedia("(min-width: 900px)");

const HELP = {
  P0: "P0: most urgent. The loop takes P0 tasks first.",
  P1: "P1: high. Taken after every P0.",
  P2: "P2: normal.",
  P3: "P3: low. Taken when nothing above it waits.",
  go: "go: the loop does it from start to finish (tag [go | ready]).",
  design: "design: needs your design go/no-go. The loop may research it and write a design packet first (tag [design | ready]). On a design packet: research more; a worker looks again, with your note.",
  hold: "On hold (tag [hold | ...]): the loop never touches it. Also for work run outside the loop.",
  backlog: "backlog: the task goes to P4 with no tag. The loop never picks it; the Backlog tab lists it.",
  obsolete: "obsolete: the task is closed, with the reason. Reversible: it can be reopened.",
  choice: "What happens to the task. go, design and on hold take a priority below; a proposed title and scope come with them.",
  priority: "Which priority the task gets. The loop takes P0 first, then P1 to P3, oldest first within one.",
  head: "Board: the task's priority and tag on the board now. Yours: what is selected in the rows below; it changes as you tap. The dot on a chip marks the curator's proposal. Nothing in these lines needs you: you decide with the rows below.",
  dot: "The dot marks the curator's proposal.",
  why: "The curator's reason for its proposal.",
  effort: "The curator's estimate of the work. S: under an hour of one worker pair, a file or two. M: a few hours. L: about a day, several areas. XL: multi-day, should be split. ?: not estimated yet.",
  S: "S: under an hour of one worker pair, a file or two.",
  M: "M: a few hours.",
  L: "L: about a day, several areas.",
  XL: "XL: multi-day; it should be split.",
  "?": "?: the curator has not estimated it yet.",
  scope: "The new title and description the curator proposes for this task. go, design or on hold accepts them; your note can change them.",
  description: "The task's description on the board today.",
  note: "Optional words for the curator. A note can change anything, for example the scope; the curator applies it when it writes your decision to the board. Ctrl+Enter (Cmd+Enter on a Mac) confirms; Enter adds a line.",
  confirm: "Confirm (or Ctrl+Enter / Cmd+Enter) saves your choice in the rows above. The curator writes it to the board a few minutes after your last decision. Undo is in the notice that follows, on the Decided tab, and after it is applied on the Past decisions tab.",
  later: "Later moves this card to the end of the list. Nothing is saved; the notice that follows has Undo.",
  undo: "Undo puts the card back in Triage with your choice and note filled in. The curator has not written it to the board yet. A Bring in goes back to the Backlog.",
  reopen: "Undo reopens the card in Triage with your choice and note filled in. The board keeps this decision until you decide again; the curator writes your next decision over it, so no separate revert is needed.",
  toastUndo: "Undo this (or Ctrl+Z / Cmd+Z while this notice shows): the card comes back with your choice and note filled in.",
  decision: "What you chose for this task.",
  applied: "Past decision: the curator wrote it to the board.",
  pending: "Decided: saved here; the curator writes it to the board a few minutes after your last decision.",
  failed: "Failed: the curator could not write it to the board. It tries again with the next batch.",
  pause: "Pause stops dispatch and the hourly tick. Workers keep the tasks they hold.",
  resume: "Resume starts dispatch (every 2 minutes) and the hourly tick again.",
  pairs: "How many worker/reviewer pairs the loop uses: it gives new tasks to Workers 1 to N. Lowering it takes no task away.",
  runs: "Dispatch gives free workers the next ready task every 2 minutes. The tick nudges idle workers once an hour.",
  classify: "Every 10 minutes, also while paused, the app looks for open tasks with no tag and no card and wakes the curator to propose them. It also withdraws undecided cards whose task closed meanwhile.",
  working: "Workers that hold a task now.",
  free: "Loop workers without a task. They get the next ready task at the next dispatch.",
  ready: "Tasks the loop can take now, in the order it takes them.",
  merging: "Approved work that Isomux Main merges after CI.",
  signoff: "Sign-off: merged work with copy or a visible change whose item on the Sign-off tab waits for your approve or reject, or for its revert.",
  diagram: "Every task of the room is in exactly one of these states, read from the board now. Tap a state to list its tasks. Arrows show who moves a task on.",
  other: "Tasks that fit none of the states, for example a tag the loop does not know, a [<class> | nil] task without a card, or batch work outside the loop.",
  recentDone: "The last 20 tasks closed as done, newest first.",
  recentObsolete: "The last 20 tasks closed as obsolete, newest first.",
  tabStatus: "The loop now: pause, workers, queue, merges and what waits for you.",
  tabOpen: "Cards that wait for your decision: workers' design packets first, then the curator's proposals.",
  tabDecided: "Your decisions that the curator has not written to the board yet. You can undo them.",
  tabApplied: "Decisions already on the board, newest first. Not a stage: each task is in the diagram where the board puts it. Undo reopens one in Triage.",
  tabBacklog: "The Backlog state: P4 tasks with no card. The loop never picks them. Bring one in as go, design or on hold, with a priority.",
  copyId: "Copy the task id.",
  idLink: "Go to this task's card: it opens the tab that holds it and flashes the card.",
  keys: "Keyboard shortcuts for triage: j/k move between cards, g d h b o pick, 0-3 set the priority, Ctrl+Enter (Cmd+Enter) confirms. Press ? to show the list.",
  viewbar: "Sort and filter the cards. The tab count and the diagram stay the full total; the keys follow the order shown. Your browser keeps these until Clear.",
  search: "Matches the title, the description, the task id and the curator's reason. / puts the cursor here; Esc leaves.",
  filters: "Combine any chips: in one row a card matches any chip, across rows it must match each row. Change compares the proposal with the board's priority. Design packets: Priority matches their board priority, the other rows let them pass, and only Kind and the search can hide them.",
  clearView: "Back to the default order with no filters.",
  toggleAll: "Expand or collapse every description and packet in this list at once.",
  splitView: "Show the task-state diagram beside Triage. It updates after each decision and every 15 s. Drag the line between them to change the widths. A narrow screen shows Triage only.",
  divider: "Drag to change the widths of the diagram and Triage.",
  bringIn: "Bring in: give this backlog task go, design or on hold and a priority (P0-P3). It goes to the curator like any triage decision, and you can undo it in Decided until then.",
  tabSignoff: "Merged copy and visible changes that wait for your approve or reject, and rejections that wait for their revert, oldest merge first. An approved item moves to Push; approving from the top moves the push point.",
  tabPush: "Merged work not pushed yet: approved sign-off items and merges with nothing to sign off. The same tasks as the diagram's Push stage. Push sends everything up to the push point; the rest waits.",
  pushPoint: "The push point is the newest merge with every sign-off item at or before it approved. Main is linear, so a push takes everything up to it. A rejected item holds it back until Isomux Main reports the revert.",
  goesOut: "Merges up to the push point: the next push sends them.",
  waitsBehind: "Merges after an item that still waits in Sign-off (or for its revert). They go out once that item is approved; approve Sign-off from the top to move the push point.",
  waitsFor: "The oldest item in Sign-off before this merge. Approve it to let this one go out.",
  old: "The text before the change. Struck words went away.",
  pairImages: "The same screen before and after the change. Tap an image to open the pair in the viewer. One comment covers the pair.",
  before: "The screen before the change.",
  after: "The screen after the change.",
  new: "The text after the change. Marked words are new.",
  packet: "A design packet: a worker hit a decision that needs you. The line shows the task's priority, its title and its id; the question below is the heading. You decide it like a triage card: a choice, a priority and a note. An option fills the choice and the note for you.",
  question: "The question the worker needs you to answer. Under it: the options, then the worker's answer and why it recommends that option, then the evidence.",
  answer: "The worker's answer: what it recommends, and why.",
  options: "The options the worker found, with what each costs. Tapping one sets its choice and fills the note with it; you can still change both. They are in the worker's order; the label “recommended” marks the one the worker recommends.",
  presetRec: "The label “recommended” marks the option the worker recommends. It is not selected for you.",
  packetNote: "Your note goes to the curator. With go it is the design to build: the curator writes it at the top of the task. go needs one. Ctrl+Enter (Cmd+Enter on a Mac) confirms; Enter adds a line.",
  evidence: "The rest of the worker's packet: findings, details and trade-offs behind the answer.",
  images: "Screenshots from the worker. Tap one to open it in the viewer: a tap on the image zooms to 100%, arrows or a swipe go to the next, Esc or a tap outside closes.",
  links: "The branch with the work, and the diff when there is one.",
  packetConfirm: "Confirm saves your choice. The curator writes it to the task a few minutes after your last decision; until then you can undo it in Decided.",
  approve: "Approve: this copy or change goes out with the next push. If you wrote comments, Approve also files a P0 copy-edits task with them; the edits come later as their own commit and sign-off item.",
  reject: "Reject: Isomux Main reverts the commit at once and the task goes back to ready with your note (and your comments). Needs a note.",
  comment: "Optional. A note (\"shorter\"), or the exact new text in quotes. Saved as you type. Approve turns comments into a copy-edits task; Reject adds them to its note.",
  editsFiled: "Approved, and your comments became a copy-edits task. This commit goes out with the next push; the edits follow as their own commit.",
  rejectNote: "Why you reject it, and what to do instead. The worker reads it when the task comes back.",
  undoApprove: "Undo the approval: the item goes back to Sign-off. Possible until you press Push.",
  push: "Push up to: tells Isomux Main to push main up to the push point, which sends every task under Goes out. Enabled when the push point is ahead of the last push go.",
  sha: "The main commit from Isomux Main's latest merge or revert. Push names this commit.",
  rejected: "Rejected: Isomux Main was asked to revert it. It stays here until Main reports the revert.",
  waitingSign: "Waiting for your approve or reject.",
  approvedSign: "Approved: it goes out with the next push.",
  nothingToSign: "Merged, with no copy or visible change to sign off.",
  sentPush: "The push go included it: it leaves when Isomux Main reports the push.",
  where: "Where this copy appears.",
  audMember: "For members: a person reads this (UI, site, docs, emails, GitHub comments). \"guessed\": the worker did not say; the app guessed from where.",
  audAgent: "For agents: agents read this (system prompt, agent reference, skills, API errors, logs). Folded and listed last, to skim. Tap to open. \"guessed\": the app guessed from where.",
  summary: "What the worker says changed.",
};
// The states: label, definition (board facts), and place in the diagram.
const STATE_INFO = {
  filed: ["Filed", "Open, no tag in the title, no card in the app yet. The loop never picks it."],
  triage: ["Triage", "An open card in the Triage tab: a curator proposal, or a worker's design packet. A task with an open card counts here whatever the board says."],
  decided: ["Decided", "You confirmed the card; the curator has not written it to the board yet. The same cards as the Decided tab, whatever the board says."],
  ready: ["Ready", "Tag [go | ready] or [design | ready], open, no assignee, P0-P3. The loop picks these."],
  working: ["Working", "In progress, assigned to an Isomux Worker."],
  merging: ["Merging", "Tag [<class> | merging], in progress, no assignee. Isomux Main merges it after CI."],
  signoff: ["Sign-off", "Merged, with copy or a visible change: its item on the Sign-off tab waits for your approve or reject, or for its revert. The board already says done."],
  hold: ["On hold", "Tag [hold | ...]. The loop never touches it."],
  backlog: ["Backlog", "P4. The loop never picks it."],
  push: ["Push", "Merged and done on the board, not pushed yet: the Push button on the Push tab sends it, and it leaves when Isomux Main reports the push. The same tasks as the Push tab."],
  done: ["Done", "Status done, with no merge that waits for the push."],
  obsolete: ["Obsolete", "Status obsolete: closed, and reversible."],
};
const BOX = {
  filed: [140, 10, 120], triage: [140, 90, 120], decided: [140, 170, 120], ready: [140, 250, 120], working: [140, 330, 120],
  merging: [140, 410, 120], signoff: [140, 490, 120], push: [140, 570, 120], done: [140, 650, 120],
  hold: [0, 40, 100], backlog: [0, 110, 100], obsolete: [0, 180, 100],
};
// [path, label x, label y, anchor, label, help, label runs up the lane, dashed]
const EDGES = [
  ["M200,56 V88", 206, 76, "start", "curator", "Filed to Triage: the curator proposes a review."],
  ["M200,136 V168", 206, 156, "start", "you decided", "Triage to Decided: you confirmed a card or a design packet. Undo takes it back."],
  ["M200,216 V248", 206, 236, "start", "curator applied", "Decided to Ready: the curator wrote your go or design to the board."],
  ["M140,180 L102,66", 121, 196, "middle", "applied", "Decided to On hold, Backlog or Obsolete: the curator wrote your decision to the board."],
  ["M140,188 L102,134", null],
  ["M140,201 H102", null],
  ["M200,296 V328", 206, 316, "start", "app", "Ready to Working: the app gives it to a free worker."],
  ["M200,376 V408", 206, 396, "start", "approved", "Working to Merging: the reviewer approved the work."],
  ["M200,456 V488", 206, 476, "start", "to sign off", "Merging to Sign-off: merged, and it has copy or a visible change."],
  ["M260,432 H290 V592 H262", 295, 520, "start", "nothing to sign off", "Merging to Push: merged, with nothing to sign off."],
  ["M200,536 V568", 206, 556, "start", "approved", "Sign-off to Push: approved; comments become a copy-edits task."],
  ["M200,616 V648", 206, 636, "start", "pushed", "Push to Done: Isomux Main reported the push."],
  ["M260,352 H284 V112 H262", 289, 230, "start", "packet", "Working to Triage: the worker hit a design decision and sent you a packet."],
  ["M140,432 H120 V284 H138", 116, 360, "middle", "CI red", "Merging to Ready: CI failed because of the branch; it goes back to the queue.", true],
  ["M140,512 H108 V270 H138", 104, 410, "middle", "rejected, reverted", "Sign-off to Ready: you rejected it, Isomux Main reverted it, and it goes back to the queue with your note.", true],
  ["M140,524 H94 V256 H138", 90, 410, "middle", "files a task", "Approving with comments files a new copy-edits task, which enters Ready. The approved task itself goes on to Done.", true, true],
];
let pickedState = null;

function diagram(states) {
  const marker =
    '<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
    '<path d="M0,0 L8,4 L0,8 z" style="fill:var(--muted)"/></marker></defs>';
  const edges = EDGES.map(([d, x, y, anchor, label, help, up, dashed]) =>
    "<g>" + (help ? "<title>" + esc(help) + "</title>" : "") +
    '<path d="' + d + '" fill="none" style="stroke:var(--muted)" stroke-width="1.4"' + (dashed ? ' stroke-dasharray="4 3"' : "") + ' marker-end="url(#ah)"/>' +
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
  return '<svg class="diagram" viewBox="0 0 400 696" role="img" aria-label="Task states">' + marker + edges + boxes + "</svg>";
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

const TAB_HELP = { status: "tabStatus", open: "tabOpen", decided: "tabDecided", applied: "tabApplied", backlog: "tabBacklog", signoff: "tabSignoff", push: "tabPush" };

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

// --- keyboard (Nil, 2026-10-19) -------------------------------------------------
// On Triage and Backlog one card is current. Keys press the same buttons a
// click does, so the same checks and errors apply.
let currentId = null;
let currentIndex = 0;
const KEY_CHOICE = { g: "go", d: "design", h: "hold", b: "backlog", o: "obsolete" };
const KEY_HELP = [
  ["j / ↓, k / ↑", "next / previous card"],
  ["g d h b o", "go, design, on hold, backlog, obsolete"],
  ["0 1 2 3", "priority P0-P3 (go, design, on hold)"],
  ["a", "fill in the curator's proposal, or the worker's recommended option (does not confirm)"],
  ["p", "packet: fill in the next option (choice and note)"],
  ["e", "expand or collapse the description"],
  ["n", "write in the note; Esc leaves it"],
  ["Ctrl+Enter / Cmd+Enter", "confirm (Backlog: bring in), in the note or not; the next card becomes current. Enter and Shift+Enter never confirm"],
  ["Ctrl+Z / Cmd+Z", "undo the last confirm or Later while its notice shows"],
  ["/", "search the cards; Esc leaves the box"],
  ["?", "show or hide this list"],
];
let keysOpen = false;

// --- leaving cards, the undo notice (Nil, 2026-10-19) --------------------------
// A confirmed (or Later) card slides out and collapses; the card that takes
// its place flashes. A notice offers Undo for 8 s.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let arriving = false;
let pulsing = false;
let toast = null;
function leave(el) {
  if (!el) return Promise.resolve();
  el.style.overflow = "hidden";
  if (reduceMotion.matches) return el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }).finished.catch(() => {});
  const h = el.offsetHeight;
  const mb = getComputedStyle(el).marginBottom;
  // Toward the diagram in the split view, else to the right.
  const x = split.on && tab === "open" && wideScreen.matches ? "-80px" : "80px";
  return el
    .animate(
      [
        { transform: "translateX(0)", opacity: 1, height: h + "px", marginBottom: mb },
        { transform: "translateX(" + x + ")", opacity: 0, height: h + "px", marginBottom: mb, offset: 0.55 },
        { transform: "translateX(" + x + ")", opacity: 0, height: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px", borderWidth: "0px" },
      ],
      { duration: 280, easing: "ease-in", fill: "forwards" },
    )
    .finished.catch(() => {});
}
function cardById(id) {
  return document.querySelector('#list [data-card="' + CSS.escape(id) + '"]');
}
// call saves (it throws on a refusal: the card stays, with the error); then
// the card leaves, the notice shows and the list reloads.
async function sendOff(id, button, call, notice, undo, reload = true) {
  try {
    if (button) button.disabled = true;
    await call();
  } catch (err) {
    if (button) button.disabled = false;
    showErr(id, err.message);
    return;
  }
  await leave(cardById(id));
  arriving = true;
  pulsing = true;
  // A function notice is read after the call and gives { text, undo } (an
  // approve learns from the call whether it filed edits, which cannot be undone).
  if (typeof notice === "function") {
    const n = notice();
    showToast(n.text, n.undo);
  } else showToast(notice, undo);
  if (reload) await load();
  else render();
}
function showToast(text, undo) {
  hideToast();
  let el = document.getElementById("toast");
  if (!el) {
    document.body.insertAdjacentHTML("beforeend", '<div class="toast" id="toast" role="status" hidden></div>');
    el = document.getElementById("toast");
  }
  el.innerHTML = "<span>" + linkIds(text) + "</span>" + (undo ? '<button class="btn ghost" data-toastundo="1"' + tip("toastUndo") + ">Undo</button>" : "");
  el.hidden = false;
  toast = { undo, timer: setTimeout(hideToast, 8000) };
}
function hideToast() {
  if (toast) clearTimeout(toast.timer);
  toast = null;
  const el = document.getElementById("toast");
  if (el) el.hidden = true;
}
async function runToastUndo() {
  if (!toast || !toast.undo) return;
  const undo = toast.undo;
  hideToast();
  await undo();
}
// Undo a triage decision: back in Triage with Nil's picks and note filled in
// (a Bring in the curator has not applied: back in the Backlog).
async function undoTriage(id) {
  const i = items.find((x) => x.taskId === id);
  const d = i && i.decision;
  try {
    const res = await api("/api/items/" + encodeURIComponent(id) + "/undo", { method: "POST" });
    if (d && res && res.withdrawn) backlogPicks[id] = { choice: d.choice, priority: d.priority, note: d.note };
    else if (d) picks[id] = { choice: d.choice, priority: d.priority, note: d.note };
  } catch (err) {
    showErr(id, err.message);
  }
  await load();
}
async function undoPacket(id) {
  const p = packets.find((x) => x.taskId === id);
  const d = p && p.decision;
  try {
    await api("/api/packets/" + encodeURIComponent(id) + "/undo", { method: "POST" });
    if (d) packetPicks[id] = { choice: d.choice, priority: d.priority, note: d.note, preset: d.preset || null };
  } catch (err) {
    showErr(id, err.message);
  }
  await load();
}
function cardOpen(id, extra) {
  return '<div class="card' + (extra ? " " + extra : "") + '" data-card="' + esc(id) + '">';
}
function keyTabs() {
  return tab === "open" || tab === "decided" || tab === "applied" || tab === "backlog";
}
function cardEls() {
  return [...document.querySelectorAll("#list [data-card]")];
}
function currentEl() {
  return cardEls().find((el) => el.dataset.card === currentId) || null;
}
// After a render: the same card stays current; when it left the list (a
// confirm), the card now at its place does.
function syncCurrent() {
  const els = keyTabs() ? cardEls() : [];
  if (!els.length) return;
  let i = els.findIndex((el) => el.dataset.card === currentId);
  if (i < 0) i = Math.min(currentIndex, els.length - 1);
  currentIndex = i;
  currentId = els[i].dataset.card;
  els[i].classList.add("current");
  if (arriving) {
    arriving = false;
    els[i].classList.add("arrived");
    els[i].scrollIntoView({ block: "nearest" });
  }
}
function setCurrent(i) {
  const els = cardEls();
  if (!els.length) return;
  currentIndex = Math.max(0, Math.min(i, els.length - 1));
  currentId = els[currentIndex].dataset.card;
  for (const el of els) el.classList.toggle("current", el === els[currentIndex]);
  els[currentIndex].scrollIntoView({ block: "nearest" });
}
function keysBox() {
  return (
    '<div class="keys" id="keys"' + (keysOpen ? "" : " hidden") + '><b>Keys</b><table>' +
    KEY_HELP.map(([k, v]) => "<tr><td><kbd>" + esc(k) + "</kbd></td><td>" + esc(v) + "</td></tr>").join("") +
    "</table></div>"
  );
}
function press(sel) {
  const el = currentEl();
  const btn = el && el.querySelector(sel);
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}
function onKey(e) {
  const k = e.key;
  if (k === "?") {
    keysOpen = !keysOpen;
    document.getElementById("keys").hidden = !keysOpen;
    return true;
  }
  if (k === "Escape" && keysOpen) {
    keysOpen = false;
    document.getElementById("keys").hidden = true;
    return true;
  }
  if (k === "/") {
    const box = document.querySelector("[data-search]");
    if (box) box.focus();
    return Boolean(box);
  }
  if (!keyTabs()) return false;
  if (k === "j" || k === "ArrowDown") return setCurrent(currentIndex + 1), true;
  if (k === "k" || k === "ArrowUp") return setCurrent(currentIndex - 1), true;
  const el = currentEl();
  if (!el) return false;
  const id = el.dataset.card;
  if (k === "e") {
    const d = el.querySelector("details");
    if (d) d.open = !d.open;
    return Boolean(d);
  }
  if (tab === "backlog") {
    const cls = { g: "go", d: "design", h: "hold" }[k];
    const pri = /^[0-3]$/.test(k) ? "P" + k : null;
    if (cls || pri || k === "n") {
      if (!backlogPicks[id]) press("[data-bring]");
      if (cls) press('[data-bpick=choice][data-v="' + cls + '"]');
      if (pri) press('[data-bpick=priority][data-v="' + pri + '"]');
      if (k === "n") currentEl()?.querySelector("textarea")?.focus();
      return true;
    }
    if (k === "Escape") return press("[data-bcancel]");
    return false;
  }
  if (tab !== "open") return false;
  if (k === "n") {
    const ta = el.querySelector("textarea");
    if (ta) ta.focus();
    return Boolean(ta);
  }
  if (el.classList.contains("packet")) {
    if (KEY_CHOICE[k]) return press('[data-ppick=choice][data-v="' + KEY_CHOICE[k] + '"]');
    if (/^[0-3]$/.test(k)) return press('[data-ppick=priority][data-v="P' + k + '"]');
    const btns = [...el.querySelectorAll("[data-preset]")];
    if (k === "a") return press("[data-preset].rec");
    if (k === "p" && btns.length) {
      const at = btns.findIndex((b) => b.classList.contains("on"));
      btns[(at + 1) % btns.length].click();
      return true;
    }
    return false;
  }
  if (KEY_CHOICE[k]) return press('[data-pick=choice][data-v="' + KEY_CHOICE[k] + '"]');
  if (/^[0-3]$/.test(k)) return press('[data-pick=priority][data-v="P' + k + '"]');
  if (k === "a") {
    const i = items.find((x) => x.taskId === id);
    if (!i) return false;
    const p = i.proposal;
    const board = PRIORITIES.includes(i.task.priority) ? i.task.priority : null;
    picks[id] = { choice: p.choice, priority: p.priority || board, note: picks[id] ? picks[id].note : "" };
    render();
    return true;
  }
  return false;
}
// While a note has the cursor, only Ctrl/Cmd+Enter (below) and Esc count.
document.addEventListener("keydown", (e) => {
  const t = e.target;
  const typing = t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT";
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && toast && !typing) {
    e.preventDefault();
    runToastUndo();
    return;
  }
  // Ctrl+Enter (Cmd+Enter on a Mac) is the one confirm key (Nil,
  // 2026-10-19); in a note the listener below has it.
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !typing && !e.isComposing) {
    if (keyTabs() && press("[data-decide], [data-pdecide], [data-bconfirm]")) e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  if (typing) {
    if (e.key === "Escape") {
      t.blur();
      e.preventDefault();
    }
    return;
  }
  // Enter on a focused button keeps its own click.
  if (e.key === "Enter" && t.tagName === "BUTTON") return;
  if (onKey(e)) e.preventDefault();
});

// Chip and summary text for a value: a class may read differently from its tag.
function label(v) {
  return CLASS_LABEL[v] || v;
}
function details(key, summaryTip, summary, body) {
  return '<details data-dkey="' + esc(key) + '"' + (openDetails.has(key) ? " open" : "") + "><summary" + tip(summaryTip) + ">" + summary + "</summary>" + body + "</details>";
}
// The label is set after each render, from what the list shows.
function toggleAll(withSplit) {
  const sp = withSplit
    ? ' <span class="split-toggle"><button class="btn ghost" data-split="1"' + tip("splitView") + ">" + (split.on ? "Hide diagram" : "Diagram beside") + "</button> " + q("splitView") + "</span>"
    : "";
  return '<div class="small toolbar"><button class="btn ghost" data-dall="1"' + tip("toggleAll") + ">Expand all</button> " + q("toggleAll") +
    ' <button class="btn ghost" data-keys="1"' + tip("keys") + ">Keys</button>" + sp + "</div>" +
    helpBox(["toggleAll"], "toggleAll") + helpBox(["splitView"], "splitView");
}
// The cards' descriptions and packets, not the Filters fold.
const CARD_DETAILS = '#list details[data-dkey]:not([data-dkey^="filters:"])';
function syncToggleAll() {
  const btn = document.querySelector("[data-dall]");
  if (!btn) return;
  const all = [...document.querySelectorAll(CARD_DETAILS)];
  btn.hidden = all.length === 0;
  btn.textContent = all.length && all.every((d) => d.open) ? "Collapse all" : "Expand all";
}
// A task id with a button that copies it. SVG icons, not glyphs: iOS draws
// glyphs as emoji.
const COPY_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
// --- task id links (Nil, 2026-10-20) ---------------------------------------------
// A task id mentioned as a reference is a link to its card: a click opens the
// tab that holds the card, scrolls to it and flashes it.
function cardTab(id) {
  const it = signoffData.items.find((x) => x.taskId === id);
  if (it && (it.state === "waiting" || it.state === "rejected")) return "signoff";
  if (pushTasks().some((x) => x.t.id === id)) return "push";
  const i = items.find((x) => x.taskId === id);
  const p = packets.find((x) => x.taskId === id);
  const st = i ? itemState(i) : p ? p.state : null;
  if (st === "open") return "open";
  if (st === "decided" || st === "failed") return "decided";
  if (st === "applied") return "applied";
  if (backlogTasks.some((t) => t.id === id)) return "backlog";
  return null;
}
function idLink(id) {
  return cardTab(id)
    ? '<a href="#" class="idlink" data-goto="' + esc(id) + '"' + tip("idLink") + ">" + esc(id) + "</a>" + copyButton(id)
    : idCopy(id);
}
// Escaped text with every task id that has a card turned into a link.
function linkIds(text) {
  return esc(text).replace(/\b[0-9a-f]{8}\b/g, (id) => (cardTab(id) ? idLink(id) : id));
}
function gotoCard(id) {
  const t = cardTab(id);
  if (!t) return;
  hideToast();
  if (t !== tab) go(t);
  const el = cardById(id);
  if (!el) return showToast(id + " is hidden by the filters on this tab", null);
  if (keyTabs()) {
    const els = cardEls();
    currentIndex = els.indexOf(el);
    currentId = id;
    for (const c of els) c.classList.toggle("current", c === el);
  }
  el.scrollIntoView({ block: "center" });
  el.classList.remove("arrived");
  void el.offsetWidth;
  el.classList.add("arrived");
}
function copyButton(id) {
  return '<button class="copyid" data-copy="' + esc(id) + '"' + tip("copyId") + ' aria-label="Copy the task id">' + COPY_ICON + "</button>";
}
function idCopy(id) {
  return esc(id) + '<button class="copyid" data-copy="' + esc(id) + '"' + tip("copyId") + ' aria-label="Copy the task id">' + COPY_ICON + "</button>";
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard API (an http page): a selected textarea and execCommand.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
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
  if (location.pathname.startsWith("/push")) tab = "push";
}
function go(nextTab) {
  // A new tab starts at its first card.
  if (nextTab !== tab) {
    currentId = null;
    currentIndex = 0;
  }
  tab = nextTab;
  const path = tab === "signoff" ? "/signoff/" : tab === "push" ? "/push/" : "/";
  if (location.pathname !== path) history.pushState(null, "", path);
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => {
  readLocation();
  render();
});

async function load() {
  const [c, i, s, pk, so, bl] = await Promise.allSettled([
    api("/api/summary"),
    api("/api/items?state=all"),
    api("/api/status"),
    api("/api/packets"),
    api("/api/signoff"),
    api("/api/backlog"),
  ]);
  if (c.status === "fulfilled") counts = c.value;
  if (i.status === "fulfilled") items = i.value;
  if (s.status === "fulfilled") loopState = s.value;
  if (pk.status === "fulfilled") packets = pk.value;
  if (so.status === "fulfilled") signoffData = so.value;
  if (bl.status === "fulfilled") backlogTasks = bl.value;
  render();
}

// --- shared -----------------------------------------------------------------

function itemState(i) {
  if (!i.decision) return "open";
  if (i.applied && i.applied.decidedAt === i.decision.decidedAt) return i.applied.ok ? "applied" : "failed";
  return "decided";
}
// The same sets as the diagram's Triage and Sign-off states (src/states.ts):
// a task counts once.
function triageCount() {
  const ids = new Set(items.filter((i) => itemState(i) === "open").map((i) => i.taskId));
  for (const p of packets) if (p.state === "open") ids.add(p.taskId);
  return ids.size;
}
function decidedCount() {
  const ids = new Set(items.filter((i) => ["decided", "failed"].includes(itemState(i))).map((i) => i.taskId));
  for (const p of packets) if (p.state === "decided" || p.state === "failed") ids.add(p.taskId);
  return ids.size;
}
function signoffCount() {
  return signoffData.items.filter((x) => x.state === "waiting" || x.state === "rejected").length;
}
function renderTabs() {
  const pc = (st) => packets.filter((p) => st.includes(p.state)).length;
  const n = {
    open: triageCount(),
    decided: decidedCount(),
    applied: (counts.applied || 0) + pc(["applied"]),
    signoff: signoffCount(),
    push: pushTasks().length,
    backlog: backlogTasks.length,
  };
  document.getElementById("tabs").innerHTML = TABS.map(
    ([k, label]) =>
      '<button class="' + (k === tab ? "on" : "") + '" data-tab="' + k + '"' + tip(TAB_HELP[k]) + ">" + label + (k in n ? " (" + n[k] + ")" : "") + "</button>",
  ).join("");
  // On a phone the bar scrolls sideways: keep the open tab in view.
  const on = document.querySelector("#tabs button.on");
  const nav = document.getElementById("tabs");
  if (on && nav.scrollWidth > nav.clientWidth) {
    const r = on.getBoundingClientRect();
    const box = nav.getBoundingClientRect();
    nav.scrollLeft += r.left - box.left - (box.width - r.width) / 2;
  }
}
function taskLine(t, who, extra) {
  const m = t.title.match(/^\[\s*([a-z]+)\s*\|\s*([^\]]*?)\s*\]\s*(.*)$/s);
  const tag = m ? '<span class="tag">' + esc(m[1]) + " · " + esc(m[2]) + "</span>" : "";
  return (
    '<div class="line">' +
    (who ? '<span class="who">' + esc(who) + "</span> · " : "") +
    '<span class="tag">' + esc(t.priority || "-") + "</span>" + tag + esc(m ? m[3] : t.title) +
    ' <span class="small">' + idCopy(t.id) + esc(extra || "") + "</span></div>"
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
  const c = s.lastClassify;
  h += "<br><span" + tip("classify") + ">Curator wake: " + (c ? clock(c.at) + " · " + (c.error ? '<span class="warn">' + esc(c.error) + "</span>" : c.found.length + " to classify") : "not yet") + "</span>";
  h += q("runs") + "</div>" + helpBox(["runs", "classify"], "runs");
  h += '<div class="small"' + tip("signoff") + '>Sign-off: <a href="/signoff/" data-go="signoff">' + signoffCount() + '</a> · Push: <a href="/push/" data-go="push">' + pushTasks().length + "</a> " + q("signoff") + "</div>" + helpBox(["signoff", "tabPush"], "signoff");
  if (s.error) return h + '<div class="err">Board unreadable: ' + esc(s.error) + "</div>";
  const b = s.board;
  h += renderStates(b);
  h += section("Working", "working", b.holding.map((x) => taskLine(x.task, x.worker)), "No worker holds a task.");
  h += '<div class="small" style="margin-top:6px"' + tip("free") + ">Free: " + (b.freeWorkers.length ? esc(b.freeWorkers.join(", ")) : "none") + " " + q("free") + "</div>" + helpBox(["free"], "free");
  h += section("Ready queue (" + b.ready.length + ")", "ready", b.ready.map((x) => taskLine(x)), "Nothing is ready.");
  h += section("Merging (" + b.merging.length + ")", "merging", b.merging.map((x) => taskLine(x)), "Nothing is merging.");
  const st = b.states;
  h += section("On hold (" + st.hold.count + ")", "hold", st.hold.tasks.map(briefLine), "No task is on hold.");
  h += section("Done (" + st.done.count + ") · last " + st.done.tasks.length, "recentDone", st.done.tasks.map(briefLine), "Nothing is done yet.");
  h += section("Obsolete (" + st.obsolete.count + ") · last " + st.obsolete.tasks.length, "recentObsolete", st.obsolete.tasks.map(briefLine), "Nothing is obsolete.");
  return h;
}

// --- triage -----------------------------------------------------------------

function chips(kind, list, chosen, proposed, id, attr = "pick") {
  return list
    .map(
      (v) =>
        '<button class="chip' + (v === chosen ? " on" : "") + (v === proposed ? " proposed" : "") +
        '" data-' + attr + '="' + kind + '" data-id="' + esc(id) + '" data-v="' + v + '" title="' + esc(HELP[v] + (v === proposed ? " The curator proposes this." : "")) + '">' + label(v) +
        (v === proposed ? '<span class="dot" aria-label="curator\'s proposal"></span>' : "") + "</button>",
    )
    .join("");
}
function filed(ms) {
  if (!ms) return "";
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? "today" : d === 1 ? "1 day ago" : d + " days ago";
}
// "P1 · go", or "backlog" and "obsolete", which have no priority.
function summary(x) {
  return tagged(x.choice) ? (x.priority || "no priority") + " · " + label(x.choice) : label(x.choice);
}
// sel: the selection (open card) or the decision (decided card).
function head(i, sel, showProposal) {
  const p = i.proposal;
  const m = i.task.title.match(/^\[\s*([a-z]+)\s*\|\s*([^\]]*?)\s*\]/);
  const board = (i.task.priority || "no priority") + " · " + (m ? m[1] + " | " + m[2] : "no tag");
  return (
    '<div class="meta"' + tip("head") + "><span>Board: " + esc(board) + " → yours: <b>" + esc(summary(sel)) + " · " + effortText(p) +
    "</b></span>" + (showProposal ? "<span>curator proposed: " + esc(summary(p)) + "</span>" : "") +
    q("head", i.taskId) + "</div>" + helpBox(["head", "effort"], "head", i.taskId) +
    '<div class="meta"' + tip("head") + "><span>Filed by " + esc(i.task.createdBy || "unknown") + "</span><span>" +
    filed(i.task.createdAt) + "</span><span>Task " + idCopy(i.taskId) + "</span></div>" +
    '<div class="title">' + esc(i.task.title) + "</div>"
  );
}
// x: a proposal or a backlog task; "effort ?" when the curator gave none.
// Plain text in the head line, once per card (Nil, 2026-10-20).
function effortText(x) {
  const e = x.effort || "?";
  return '<span title="' + esc(HELP[e]) + '">effort ' + e + "</span>";
}
function body(i) {
  const p = i.proposal;
  let h = '<div class="why"><span class="label"' + tip("why") + ">Why</span><br>" + esc(p.why) +
    (p.effortWhy ? "<br><span" + tip("effort") + ">Effort: " + esc(p.effortWhy) + "</span>" : "") + "</div>";
  if (p.title || p.scope) {
    h += '<div class="proposed-scope"><span class="label"' + tip("scope") + ">Proposed scope</span>";
    if (p.title) h += '<div class="title">' + esc(p.title) + "</div>";
    if (p.scope) h += '<div class="desc">' + esc(p.scope) + "</div>";
    h += "</div>";
  }
  if (i.task.description)
    h += details("desc:" + i.taskId, "description", "Current description", '<div class="desc">' + esc(i.task.description) + "</div>");
  return h;
}
function row(label, kind, list, k, p, id) {
  return (
    '<div class="row"><span class="label"' + tip(kind) + ">" + label + " " + q(kind, id) + "</span>" +
    helpBox([kind].concat(list, ["dot"]), kind, id) + chips(kind, list, k[kind], p[kind], id) + "</div>"
  );
}
function openCard(i) {
  const p = i.proposal;
  // A proposal without a priority (backlog, obsolete) starts from the board's.
  const board = PRIORITIES.includes(i.task.priority) ? i.task.priority : null;
  const k = picks[i.taskId] || (picks[i.taskId] = { choice: p.choice, priority: p.priority || board, note: "" });
  return (
    cardOpen(i.taskId) + head(i, k, false) + body(i) +
    row("Choice", "choice", CHOICES, k, p, i.taskId) +
    (tagged(k.choice) ? row("Priority", "priority", PRIORITIES, k, p, i.taskId) : "") +
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
    s === "applied" ? '<span class="ok"' + tip("applied") + ">Past decision</span>"
    : s === "failed" ? '<span class="warn"' + tip("failed") + ">Failed: " + esc(i.applied.error || "no reason given") + "</span>"
    : "<span" + tip("pending") + ">Decided: waiting for the curator</span>";
  const stateKey = s === "applied" ? "applied" : s === "failed" ? "failed" : "pending";
  let h =
    cardOpen(i.taskId) + head(i, d, true) +
    '<div class="why"><span class="label"' + tip("decision") + ">Your decision</span><br><b>" + esc(summary(d)) + "</b>" +
    (d.note ? "<br>" + esc(d.note) : "") + "</div>" + '<div class="meta">' + status + q("state", i.taskId) + "</div>" +
    helpBox([stateKey, s === "applied" ? "reopen" : "undo"], "state", i.taskId);
  h += '<div class="err" data-err="' + esc(i.taskId) + '"></div><div class="actions"><button class="btn ghost" data-undo="' + esc(i.taskId) + '"' + tip(s === "applied" ? "reopen" : "undo") + ">Undo</button></div>";
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
  if (!all.length) return '<div class="empty">' + (tab === "open" ? "Nothing in Triage." : "Nothing here.") + "</div>";
  // The cards first: they set the "Showing n of m" count the bar shows.
  if (tab === "open") {
    const cards = triageCards(all);
    return toggleAll(true) + viewBar("triage", all) + '<div id="cards">' + cards + "</div>";
  }
  return all.map((e) => (e.kind === "packet" ? decidedPacketCard(e.x) : decidedCard(e.x))).join("");
}
function triageCards(all) {
  const shown = viewList("triage", all);
  setShown("triage", shown.length, all.length);
  if (!shown.length) return '<div class="empty">No card matches the filters.</div>';
  return shown.map((e) => (e.kind === "packet" ? packetCard(e.x) : openCard(e.x))).join("");
}

// --- sort and filter (Nil, 2026-10-19) ------------------------------------------
// Per tab, kept in this browser. The tab count and the diagram stay the full
// total; the keys follow the order shown.
const VIEW_DEFAULT = {
  triage: { sort: "proposed", kind: [], choice: [], pri: [], effort: [], change: [], by: [], q: "" },
  backlog: { sort: "oldest", by: [], q: "" },
};
const view = {};
for (const k of Object.keys(VIEW_DEFAULT))
  view[k] = Object.assign(JSON.parse(JSON.stringify(VIEW_DEFAULT[k])), JSON.parse(localStorage.getItem("loop.view." + k) || "{}"));
const saveView = (k) => localStorage.setItem("loop.view." + k, JSON.stringify(view[k]));
const SORTS = {
  triage: [["proposed", "proposed priority"], ["board", "board priority"], ["oldest", "oldest task"], ["newest", "newest task"], ["card", "newest card"], ["effort", "smallest effort"]],
  backlog: [["oldest", "oldest task"], ["newest", "newest task"]],
};
const FILTER_ROWS = {
  triage: [
    ["kind", "Kind", () => [["proposal", "proposal"], ["packet", "design packet"]]],
    ["choice", "Proposed", () => CHOICES.map((c) => [c, label(c)])],
    ["pri", "Priority", () => PRIORITIES.map((p) => [p, p])],
    ["effort", "Effort", () => EFFORTS.concat("?").map((e) => [e, e])],
    ["change", "Change", () => [["up", "priority up"], ["down", "priority down"], ["same", "same priority"], ["new", "new task"]]],
    ["by", "Filed by", (list) => filers(list)],
  ],
  backlog: [["by", "Filed by", (list) => filers(list)]],
};
const shownCount = {};
// One shape for triage cards, packets and backlog tasks.
function facts(e) {
  if (e.kind === "packet") {
    const p = e.x;
    return { id: p.taskId, kind: "packet", by: null, board: p.priority, proposed: undefined, choice: undefined, created: p.createdAt, card: p.createdAt,
      text: [p.title, p.question, p.body, p.taskId].join(" ") };
  }
  if (e.kind === "backlog") {
    const t = e.x;
    return { id: t.id, kind: "backlog", by: t.createdBy || "unknown", board: "P4", created: t.createdAt, card: t.createdAt,
      text: [t.title, t.description, t.id].join(" ") };
  }
  const i = e.x;
  return { id: i.taskId, kind: "proposal", by: i.task.createdBy || "unknown", board: i.task.priority, proposed: i.proposal.priority, choice: i.proposal.choice,
    effort: i.proposal.effort || "?", created: i.task.createdAt, card: i.proposedAt,
    text: [i.task.title, i.task.description, i.taskId, i.proposal.why, i.proposal.title, i.proposal.scope].join(" ") };
}
const rank = (p) => (p ? Number(String(p).slice(1)) : null);
const effortRank = (e) => (EFFORTS.includes(e) ? EFFORTS.indexOf(e) : 9);
// up / down / same compared with the board; "new" when the board has no priority.
function change(f) {
  if (f.kind !== "proposal") return null;
  const board = rank(f.board);
  if (board === null) return "new";
  const to = f.choice === "backlog" ? 4 : f.choice === "obsolete" ? null : rank(f.proposed);
  if (to === null) return null;
  return to < board ? "up" : to > board ? "down" : "same";
}
function filers(list) {
  const n = {};
  for (const e of list) {
    const by = facts(e).by;
    if (by) n[by] = (n[by] || 0) + 1;
  }
  return Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b)).slice(0, 10).map((b) => [b, b + " (" + n[b] + ")"]);
}
// Nil, 2026-10-20: a filter never hides a design packet by accident. Priority
// matches a packet by its board priority; the rows a packet has no value for
// (Proposed, Effort, Change, Filed by) let it pass. Only Kind and the search
// can hide one.
function matches(f, v) {
  const pk = f.kind === "packet";
  if (v.kind && v.kind.length && !v.kind.includes(f.kind)) return false;
  if (v.pri && v.pri.length && !v.pri.includes(pk ? f.board : f.proposed)) return false;
  if (!pk) {
    if (v.choice && v.choice.length && !v.choice.includes(f.choice)) return false;
    if (v.effort && v.effort.length && !v.effort.includes(f.effort)) return false;
    if (v.change && v.change.length && !v.change.includes(change(f))) return false;
    if (v.by && v.by.length && !v.by.includes(f.by)) return false;
  }
  const q = v.q.trim().toLowerCase();
  return !q || f.text.toLowerCase().includes(q);
}
function activeFilters(k) {
  const v = view[k];
  return FILTER_ROWS[k].reduce((n, [field]) => n + v[field].length, 0) + (v.q.trim() ? 1 : 0);
}
// The default order is the list's own (Triage: packets first, then proposed
// priority and age). Later cards stay at the end in every order.
function viewList(k, all) {
  const v = view[k];
  const by = {
    board: (a, b) => (rank(a.board) ?? 9) - (rank(b.board) ?? 9) || a.created - b.created,
    oldest: (a, b) => a.created - b.created,
    newest: (a, b) => b.created - a.created,
    card: (a, b) => b.card - a.card,
    // Not estimated (and packets) last.
    effort: (a, b) => effortRank(a.effort) - effortRank(b.effort) || a.created - b.created,
  }[v.sort];
  let list = all.map((e) => ({ e, f: facts(e) })).filter((x) => matches(x.f, v));
  if (by) list = list.sort((a, b) => by(a.f, b.f));
  if (k === "triage") list = list.filter((x) => !later.has(x.f.id)).concat(list.filter((x) => later.has(x.f.id)));
  return list.map((x) => x.e);
}
function setShown(k, n, total) {
  shownCount[k] = [n, total];
  const el = document.getElementById("shown-" + k);
  if (el) el.textContent = showingText(k);
}
function showingText(k) {
  const [n, total] = shownCount[k] || [0, 0];
  return "Showing " + n + " of " + total;
}
function viewBar(k, all) {
  const v = view[k];
  const on = activeFilters(k);
  const rows = FILTER_ROWS[k]
    .map(([field, name, values]) => {
      const vals = values(all);
      if (!vals.length) return "";
      return '<div class="row"><span class="label">' + name + "</span>" +
        vals.map(([val, text]) => '<button class="chip' + (v[field].includes(val) ? " on" : "") + '" data-vf="' + esc(JSON.stringify([k, field, val])) + '">' + esc(text) + "</button>").join("") + "</div>";
    })
    .join("");
  return (
    '<div class="viewbar small"' + tip("viewbar") + "><label>Sort <select data-sort=\"" + k + "\">" +
    SORTS[k].map(([val, text]) => '<option value="' + val + '"' + (v.sort === val ? " selected" : "") + ">" + text + "</option>").join("") + "</select></label>" +
    '<input type="search" data-search="' + k + '" placeholder="Search (/)" value="' + esc(v.q) + '"' + tip("search") + ">" +
    '<span id="shown-' + k + '">' + showingText(k) + "</span>" +
    '<button class="btn ghost" data-clearview="' + k + '"' + (on ? "" : " hidden") + tip("clearView") + ">Clear</button> " + q("viewbar") + "</div>" +
    helpBox(["viewbar", "search", "filters"], "viewbar") +
    details("filters:" + k, "filters", "Filters" + (on ? " (" + on + " on)" : ""), '<div class="filters">' + rows + "</div>")
  );
}
// Typing in the search box re-renders the cards only, so the box keeps the cursor.
function rerenderCards() {
  const box = document.getElementById("cards");
  if (!box) return render();
  box.innerHTML = tab === "backlog" ? backlogCards() : triageCards(triageEntries());
  syncCurrent();
  syncToggleAll();
}
function triageEntries() {
  const open = items.filter((i) => itemState(i) === "open").map((i) => ({ kind: "triage", x: i }));
  return packets.filter((p) => p.state === "open").map((p) => ({ kind: "packet", x: p })).concat(open);
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
// --- image viewer (Nil, 2026-10-20) ---------------------------------------------
// Images open in place, over the page: fit to the screen, a click or tap
// toggles 100% (scroll to pan), Esc / the backdrop / Close dismiss, arrows or
// a swipe move through the item's images. A before/after pair opens as the
// pair. Triage keys are off while it is open.
const lbGroups = {};
let lb = null;
function lbAttr(group, i, caption) {
  return ' data-lb="' + esc(group) + '" data-lbi="' + i + '" title="' + esc((caption ? caption + ". " : "") + "Open in the viewer") + '"';
}
function lbFigure(im, label) {
  if (!im) return '<figure class="lb-missing"><figcaption>' + esc("No " + label.toLowerCase() + " image") + "</figcaption></figure>";
  return "<figure>" + (label ? '<div class="lb-label">' + esc(label) + "</div>" : "") + '<img src="' + esc(im.url) + '" alt="' + esc(im.caption) + '">' +
    (im.caption ? "<figcaption>" + esc(im.caption) + "</figcaption>" : "") + "</figure>";
}
function renderLb() {
  let el = document.getElementById("lb");
  if (!el) {
    document.body.insertAdjacentHTML("beforeend", '<div class="lb" id="lb" role="dialog" aria-modal="true" hidden></div>');
    el = document.getElementById("lb");
  }
  if (!lb) {
    el.hidden = true;
    document.body.classList.remove("lb-open");
    return;
  }
  const slides = lbGroups[lb.group] || [];
  const sl = slides[lb.i];
  if (!sl) return closeLb();
  const many = slides.length > 1;
  el.className = "lb" + (lb.zoom ? " zoom" : "");
  el.innerHTML =
    '<div class="lb-bar"><span>' + (sl.pair ? esc("Screenshots: " + sl.pair.name) : "") + (many ? " " + (lb.i + 1) + " / " + slides.length : "") + "</span>" +
    (many ? '<button class="btn ghost" data-lbprev="1" title="Previous (Left arrow)" aria-label="Previous">‹</button><button class="btn ghost" data-lbnext="1" title="Next (Right arrow)" aria-label="Next">›</button>' : "") +
    '<button class="btn ghost" data-lbclose="1" title="Close (Esc)" aria-label="Close">Close</button></div>' +
    '<div class="lb-body' + (sl.pair ? " pair" : "") + '">' + (sl.pair ? lbFigure(sl.pair.before, "Before") + lbFigure(sl.pair.after, "After") : lbFigure(sl.one, "")) + "</div>";
  el.hidden = false;
  document.body.classList.add("lb-open");
}
function openLb(group, i) {
  lb = { group, i, zoom: false };
  renderLb();
}
function closeLb() {
  lb = null;
  renderLb();
}
function stepLb(d) {
  const n = (lbGroups[lb.group] || []).length;
  if (n < 2) return;
  lb = { group: lb.group, i: (lb.i + d + n) % n, zoom: false };
  renderLb();
}
// Capture phase: the viewer gets clicks and keys before the rest of the page.
document.addEventListener(
  "click",
  (e) => {
    const open = e.target.closest && e.target.closest("[data-lb]");
    if (open && !lb) {
      e.preventDefault();
      e.stopPropagation();
      return openLb(open.dataset.lb, Number(open.dataset.lbi));
    }
    if (!lb || !e.target.closest("#lb")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.target.closest("[data-lbclose]")) return closeLb();
    if (e.target.closest("[data-lbprev]")) return stepLb(-1);
    if (e.target.closest("[data-lbnext]")) return stepLb(1);
    if (e.target.tagName === "IMG") {
      lb.zoom = !lb.zoom;
      return renderLb();
    }
    // The backdrop: anything that is not the bar, an image or a caption.
    if (!e.target.closest(".lb-bar, figure")) closeLb();
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (!lb) return;
    e.stopPropagation();
    if (e.key === "Escape") closeLb();
    else if (e.key === "ArrowLeft") stepLb(-1);
    else if (e.key === "ArrowRight") stepLb(1);
    else return;
    e.preventDefault();
  },
  true,
);
let lbTouch = null;
document.addEventListener("touchstart", (e) => {
  if (lb && !lb.zoom && e.touches.length === 1) lbTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  else lbTouch = null;
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (!lb || !lbTouch || lb.zoom) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - lbTouch.x;
  const dy = t.clientY - lbTouch.y;
  lbTouch = null;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 60) stepLb(dx < 0 ? 1 : -1);
});

function imagesHtml(kind, taskId, images) {
  if (!images || !images.length) return "";
  const group = kind + ":" + taskId;
  lbGroups[group] = images.map((im) => ({ one: { url: "/img/" + kind + "/" + encodeURIComponent(taskId) + "/" + im.file, caption: im.caption } }));
  return (
    '<div class="label"' + tip("images") + ">Screenshots " + q("images", kind + taskId) + "</div>" + helpBox(["images"], "images", kind + taskId) +
    '<div class="thumbs">' +
    images
      .map((im, n) => {
        const url = "/img/" + kind + "/" + encodeURIComponent(taskId) + "/" + im.file;
        return '<a href="' + url + '"' + lbAttr(group, n, im.caption) + '><img src="' + url + '" alt="' + esc(im.caption) + '">' +
          (im.caption ? "<span>" + esc(im.caption) + "</span>" : "") + "</a>";
      })
      .join("") +
    "</div>"
  );
}
// Nil, 2026-10-20: the question is the card's one heading; the task title
// moves to the meta line, shortened when long.
function packetHead(p) {
  const title = p.title.replace(/^\[[^\]]*\]\s*/, "");
  const short = title.length > 60 ? title.slice(0, 57).trimEnd() + "…" : title;
  return (
    '<div class="meta"' + tip("packet") + '><span class="badge">Design packet</span><span>' + esc(p.priority || "no priority") + '</span><span title="' + esc(title) + '">' + esc(short) +
    "</span><span>Task " + idCopy(p.taskId) + "</span><span>" + clock(p.createdAt) + "</span>" + q("packet", p.taskId) + "</div>" + helpBox(["packet"], "packet", p.taskId) +
    '<div class="question"' + tip("question") + ">" + esc(p.question) + "</div>"
  );
}
// The body's first paragraph (up to the first blank line outside a code
// fence) is the answer, shown open; the rest is the evidence, folded.
function splitBody(body) {
  const lines = body.replace(/^\s*\n/, "").split("\n");
  let fence = false;
  let seen = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fence = !fence;
    if (!fence && seen && !lines[i].trim()) return [lines.slice(0, i).join("\n"), lines.slice(i + 1).join("\n").trim()];
    if (lines[i].trim()) seen = true;
  }
  return [lines.join("\n").trim(), ""];
}
function packetCard(p) {
  // The recommended option is marked, not picked (Nil, 2026-10-20).
  const board = PRIORITIES.includes(p.priority) ? p.priority : null;
  const k = packetPicks[p.taskId] || (packetPicks[p.taskId] = { choice: null, priority: board, note: "", preset: null });
  const opt = (o) =>
    '<button class="option' + (k.preset === o.label ? " on" : "") + (o.recommended ? " rec" : "") + '" data-preset="' + esc(o.label) + '" data-id="' + esc(p.taskId) + '"' +
    ' title="' + esc(o.label + (o.cost ? ": " + o.cost : "") + ". Sets " + label(o.decision) + " and fills the note." + (o.recommended ? " The worker recommends this." : "")) + '">' +
    "<b>" + esc(o.label) + "</b>" + (o.recommended ? '<span class="rec-label">recommended</span>' : "") +
    '<span class="cost">→ ' + esc(label(o.decision)) + (o.cost ? " · " + esc(o.cost) : "") + "</span></button>";
  const pickRow = (name, kind, list) =>
    '<div class="row"><span class="label"' + tip(kind) + ">" + name + " " + q("p" + kind, p.taskId) + "</span>" +
    helpBox([kind].concat(list), "p" + kind, p.taskId) + chips(kind, list, k[kind], undefined, p.taskId, "ppick") + "</div>";
  const [answer, evidence] = splitBody(p.body || "");
  let links = "";
  if (p.branch) links += "<span>Branch <code>" + esc(p.branch) + "</code></span>";
  if (p.diffUrl) links += '<a href="' + esc(p.diffUrl) + '" target="_blank" rel="noopener">Diff</a>';
  return (
    cardOpen(p.taskId, "packet") + packetHead(p) +
    '<div class="row"><span class="label"' + tip("options") + ">Options " + q("options", p.taskId) + "</span>" + helpBox(["options", "presetRec"], "options", p.taskId) +
    '<div class="options">' + p.options.map(opt).join("") + "</div></div>" +
    (answer ? '<div class="mdbody answer"' + tip("answer") + ">" + md(answer) + "</div>" : "") +
    (evidence ? details("packet:" + p.taskId, "evidence", "Evidence", '<div class="mdbody">' + md(evidence) + "</div>") : "") +
    imagesHtml("packets", p.taskId, p.images) +
    (links ? '<div class="links"' + tip("links") + ">" + links + "</div>" : "") +
    pickRow("Choice", "choice", CHOICES) +
    (tagged(k.choice) ? pickRow("Priority", "priority", PRIORITIES) : "") +
    '<textarea rows="1" placeholder="Note for the curator (go: the design to build)" data-pnote="' + esc(p.taskId) + '"' + tip("packetNote") + ">" + esc(k.note) + "</textarea>" +
    '<div class="err" data-err="' + esc(p.taskId) + '"></div>' +
    '<div class="actions"><button class="btn primary" data-pdecide="' + esc(p.taskId) + '"' + tip("packetConfirm") + ">Confirm</button>" +
    '<button class="btn ghost" data-later="' + esc(p.taskId) + '"' + tip("later") + ">Later</button>" + q("pactions", p.taskId) + "</div>" +
    helpBox(["packetConfirm", "later", "packetNote"], "pactions", p.taskId) + "</div>"
  );
}
function decidedPacketCard(p) {
  const d = p.decision;
  const s = p.state;
  const status =
    s === "applied" ? '<span class="ok"' + tip("applied") + ">Past decision</span>"
    : s === "failed" ? '<span class="warn"' + tip("failed") + ">Failed: " + esc(p.applied.error || "no reason given") + "</span>"
    : "<span" + tip("pending") + ">Decided: waiting for the curator</span>";
  const rec = p.options.find((o) => o.recommended);
  let h =
    cardOpen(p.taskId, "packet") + packetHead(p) +
    '<div class="why"><span class="label"' + tip("decision") + ">Your decision</span><br><b>" + esc(summary(d)) + "</b>" +
    (d.preset ? ' <span class="small">from option ' + esc(d.preset) + "</span>" : "") +
    (rec ? ' <span class="small">(worker recommended ' + esc(rec.label) + ")</span>" : "") + (d.note ? "<br>" + esc(d.note) : "") + "</div>" +
    '<div class="meta">' + status + "</div>";
  h += '<div class="err" data-err="' + esc(p.taskId) + '"></div><div class="actions"><button class="btn ghost" data-pundo="' + esc(p.taskId) + '"' + tip(s === "applied" ? "reopen" : "undo") + ">Undo</button></div>";
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
// --- backlog ------------------------------------------------------------------

function renderBacklog() {
  let h = '<div class="small"' + tip("tabBacklog") + ">" + backlogTasks.length + " P4 tasks with no card. The loop never picks them. " + q("tabBacklog") + "</div>" + helpBox(["tabBacklog", "bringIn"], "tabBacklog") + toggleAll();
  if (!backlogTasks.length) return h + '<div class="empty">The backlog is empty.</div>';
  const all = backlogTasks.map((t) => ({ kind: "backlog", x: t }));
  const cards = backlogCards();
  return h + viewBar("backlog", all) + '<div id="cards">' + cards + "</div>";
}
function backlogCards() {
  const all = backlogTasks.map((t) => ({ kind: "backlog", x: t }));
  const shown = viewList("backlog", all);
  setShown("backlog", shown.length, all.length);
  if (!shown.length) return '<div class="empty">No task matches the filters.</div>';
  let h = "";
  for (const t of shown.map((e) => e.x)) {
    const k = backlogPicks[t.id];
    h += cardOpen(t.id) + '<div class="meta"><span>Filed by ' + esc(t.createdBy || "unknown") + "</span><span>" + filed(t.createdAt) + "</span><span>Task " + idCopy(t.id) + "</span>" +
      (t.effort ? '<span title="' + esc(HELP[t.effort] + (t.effortWhy ? " " + t.effortWhy : "")) + '">effort ' + esc(t.effort) + "</span>" : "") + "</div>" +
      '<div class="title">' + esc(t.title) + "</div>" +
      (t.description ? details("bdesc:" + t.id, "description", "Description", '<div class="desc">' + esc(t.description) + "</div>") : "");
    if (!k) {
      h += '<div class="actions"><button class="btn ghost" data-bring="' + esc(t.id) + '"' + tip("bringIn") + ">Bring in</button></div>";
    } else {
      const chipRow = (kind, list) =>
        list.map((v) => '<button class="chip' + (k[kind] === v ? " on" : "") + '" data-bpick="' + kind + '" data-id="' + esc(t.id) + '" data-v="' + v + '"' + tip(v) + ">" + label(v) + "</button>").join("");
      h += '<div class="row"><span class="label"' + tip("choice") + ">Choice</span>" + chipRow("choice", TAGGED) + "</div>" +
        '<div class="row"><span class="label"' + tip("priority") + ">Priority</span>" + chipRow("priority", PRIORITIES) + "</div>" +
        '<textarea rows="1" placeholder="Note for the curator (optional)" data-bnote="' + esc(t.id) + '"' + tip("note") + ">" + esc(k.note) + "</textarea>" +
        '<div class="err" data-err="' + esc(t.id) + '"></div>' +
        '<div class="actions"><button class="btn primary" data-bconfirm="' + esc(t.id) + '"' + tip("bringIn") + ">Bring in</button>" +
        '<button class="btn ghost" data-bcancel="' + esc(t.id) + '">Cancel</button></div>';
    }
    h += "</div>";
  }
  return h;
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
// The button says what it will do: with comments it also files the edits.
function approveLabel(taskId) {
  return hasComments(taskId) ? "Approve, file edits" : "Approve";
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
// The Sign-off stage: items that wait for Nil, or for their revert.
function signoffItems() {
  return signoffData.items.filter((x) => x.state === "waiting" || x.state === "rejected");
}
// The Push stage, from the diagram's own list, with each task's commit and
// its approved item (if it had one).
function pushTasks() {
  const st = loopState && loopState.board && loopState.board.states.push;
  if (!st) return [];
  const un = Object.fromEntries((signoffData.unpushed || []).map((u) => [u.taskId, u]));
  const item = Object.fromEntries(signoffData.items.map((i) => [i.taskId, i]));
  return st.tasks.map((t) => ({ t, u: un[t.id], it: item[t.id] }));
}
function pushBanner(goes) {
  const so = signoffData;
  const pt = so.push;
  const sha8 = pt.sha ? pt.sha.slice(0, 8) : "";
  const last = so.lastSha ? so.lastSha.commit : null;
  return (
    '<div class="banner ' + (pt.ok ? "run" : "paused") + '"><div><b' + tip("push") + ">" +
    (pt.sha ? "Push up to <code>" + esc(sha8) + "</code>: " + goes + (goes === 1 ? " task" : " tasks") : "Push (" + pushTasks().length + ")") + "</b>" +
    '<div class="small"' + tip("sha") + ">main " + (last ? "<code>" + esc(last.slice(0, 10)) + "</code> · " + clock(so.lastSha.at) : "not reported yet") + "</div>" +
    (pt.ok ? "" : '<div class="small">' + linkIds(pt.reason) + "</div>") +
    '</div><span><button class="btn primary" data-push="1"' + (pt.ok ? "" : " disabled") + tip("push") + ">" + (pt.sha ? "Push up to " + esc(sha8) : "Push") + "</button> " + q("push") + "</span></div>" +
    helpBox(["push", "pushPoint", "sha"], "push") + '<div class="err" data-err="push"></div>'
  );
}
function pushCard({ t, u, it }, waitsFor) {
  const approved = it && it.state === "approved";
  const status = approved
    ? it.decision.edits
      ? '<span class="ok"' + tip("editsFiled") + ">Approved, edits filed: task " + idLink(it.decision.edits) + "</span>"
      : '<span class="ok"' + tip("approvedSign") + ">Approved</span>"
    : u && u.sent ? "<span" + tip("sentPush") + ">Push sent, waiting for Isomux Main</span>"
    : "<span" + tip("nothingToSign") + ">Nothing to sign off</span>";
  const wait = waitsFor ? ' <span class="warn"' + tip("waitsFor") + ">waits for " + idLink(waitsFor) + "</span>" : "";
  return cardOpen(t.id, "signoff-card") + '<div class="sotitle">' + esc(t.title) + "</div>" +
    '<div class="meta"><span>Task ' + idCopy(t.id) + "</span>" +
    (u ? "<span" + tip("sha") + ">commit <code>" + esc(u.commit.slice(0, 10)) + "</code></span><span>merged " + clock(u.at) + "</span>" : "") + status + wait + "</div>" +
    '<div class="err" data-err="' + esc(t.id) + '"></div>' +
    (approved && !it.decision.edits ? '<div class="actions"><button class="btn ghost" data-sundo="' + esc(t.id) + '"' + tip("undoApprove") + ">Undo</button></div>" : "") +
    "</div>";
}
// Main is linear: the push takes every merge up to the push point; the
// merges after it wait for the oldest item that still needs Nil.
function renderPush() {
  // Merge order here: that is the order a push takes them in.
  const list = pushTasks().sort((a, b) => (a.u ? a.u.seq : Infinity) - (b.u ? b.u.seq : Infinity));
  const pt = signoffData.push;
  const inPush = (x) => x.u && pt.seq !== null && pt.seq !== undefined && x.u.seq <= pt.seq;
  const goes = list.filter(inPush);
  const waits = list.filter((x) => !inPush(x));
  const blocker = (x) => (pt.blockers || []).find((b) => !x.u || b.seq < x.u.seq);
  let h = '<div class="small"' + tip("tabPush") + ">" + esc(HELP.tabPush) + "</div>" + pushBanner(goes.length);
  if (!list.length) return h + '<div class="empty">Nothing waits for the push.</div>';
  if (goes.length) h += "<h2" + tip("goesOut") + ">Goes out (" + goes.length + ") " + q("goesOut") + "</h2>" + helpBox(["goesOut"], "goesOut") + goes.map((x) => pushCard(x, null)).join("");
  if (waits.length)
    h += "<h2" + tip("waitsBehind") + ">Waits (" + waits.length + ") " + q("waitsBehind") + "</h2>" + helpBox(["waitsBehind"], "waitsBehind") +
      waits.map((x) => pushCard(x, (blocker(x) || {}).taskId || null)).join("");
  return h;
}
function renderSignoff() {
  const items = signoffItems();
  let h = '<div class="small"' + tip("tabSignoff") + ">" + esc(HELP.tabSignoff) + "</div>";
  if (!items.length) return h + '<div class="empty">Nothing waits for your sign-off.</div>';
  for (const it of items) {
    const waiting = it.state === "waiting";
    const stateText =
      it.state === "approved"
        ? it.decision.edits
          ? '<span class="ok"' + tip("editsFiled") + ">Approved, edits filed: task " + idLink(it.decision.edits) + "</span>"
          : '<span class="ok"' + tip("approvedSign") + ">Approved</span>"
      : it.state === "rejected" ? '<span class="warn"' + tip("rejected") + ">Rejected, waiting for revert: " + esc(it.decision.note) + "</span>"
      : "<span" + tip("waitingSign") + ">Waiting for you</span>";
    h += cardOpen(it.taskId, "signoff-card") + '<div class="sotitle">' + esc(it.title) + "</div>" +
      '<div class="meta"><span>Task ' + idCopy(it.taskId) + "</span><span" + tip("sha") + ">commit <code>" + esc(it.merged.commit.slice(0, 10)) + "</code></span><span>merged " +
      clock(it.merged.at) + "</span>" + stateText + "</div>";
    if (it.summary) h += '<div class="mdbody"' + tip("summary") + ">" + md(it.summary) + "</div>";
    // Copy members read comes first at full weight; copy for agents follows,
    // dimmer and folded to one line. n stays the entry's index (comments).
    const entries = it.copy.map((c, n) => [c, n]);
    const forAgents = (c) => c.audience === "agent";
    for (const [c, n] of entries.filter(([c]) => !forAgents(c)).concat(entries.filter(([c]) => forAgents(c)))) {
      const [o, nw] = diff(unwrap(c.old || ""), unwrap(c.new));
      const agent = forAgents(c);
      const tag = '<span class="aud ' + (agent ? "agent" : "member") + '"' + tip(agent ? "audAgent" : "audMember") + ">" +
        (agent ? "for agents" : "for members") + (c.guessed ? " · guessed" : "") + "</span>";
      const cols = '<div class="cols"><div><h2' + tip("old") + '>Old</h2><div class="copytext">' + (c.old ? o : '<span class="small">New copy</span>') +
        '</div></div><div><h2' + tip("new") + '>New</h2><div class="copytext">' + nw + "</div></div></div>" + (waiting ? commentBox(it, "copy", n) : "");
      h += agent
        ? '<div class="entry agent">' + details("aud:" + it.taskId + ":" + n, "audAgent", tag + " " + esc(c.where), cols) + "</div>"
        : '<div class="entry"><div class="where"' + tip("where") + ">" + tag + " " + esc(c.where) + "</div>" + cols + "</div>";
    }
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
    // The item's images as one series in the viewer: each pair, then each lone image.
    const group = "signoff:" + it.taskId;
    const one = (im) => im && { url: imgUrl(im), caption: im.caption };
    lbGroups[group] = pairs.map((pr) => ({ pair: { name: pr.name, before: one(pr.before), after: one(pr.after) } })).concat(lone.map(([im]) => ({ one: one(im) })));
    for (const [k, pr] of pairs.entries()) {
      const side = (im, label, key) =>
        "<div><h2" + tip(key) + ">" + label + "</h2>" +
        (im
          ? '<a class="pairimg" href="' + imgUrl(im) + '"' + lbAttr(group, k, im.caption) + '><img src="' + imgUrl(im) + '" alt="' + esc(im.caption) + '"></a>' +
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
      for (const [j, [im, n]] of lone.entries())
        h += '<div class="shot"><a href="' + imgUrl(im) + '"' + lbAttr(group, pairs.length + j, im.caption) + '><img src="' + imgUrl(im) + '" alt="' + esc(im.caption) + '"></a>' +
          (im.caption ? '<div class="small">' + esc(im.caption) + "</div>" : "") + (waiting ? commentBox(it, "images", n) : "") + "</div>";
      h += "</div></div>";
    }
    h += '<div class="err" data-err="' + esc(it.taskId) + '"></div>';
    if (waiting)
      h += '<div class="entry"><textarea rows="1" placeholder="Why you reject it (needed to reject)" data-rnote="' + esc(it.taskId) + '"' + tip("rejectNote") + ">" + esc(rejectNotes[it.taskId] || "") + "</textarea>" +
        '<div class="actions"><button class="btn primary" data-approve="' + esc(it.taskId) + '"' + tip("approve") + ">" + approveLabel(it.taskId) + "</button>" +
        '<button class="btn ghost" data-reject="' + esc(it.taskId) + '"' + tip("reject") + ">Reject</button>" + q("sactions", it.taskId) + "</div>" +
        helpBox(["approve", "reject", "comment", "rejectNote"], "sactions", it.taskId) + "</div>";
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
  const splitOn = tab === "open" && split.on;
  if (splitOn) el.className = "split-main";
  document.body.classList.toggle("split-on", splitOn);
  // Each pane scrolls on its own: a render keeps both positions.
  const keep = [".split .side", ".split .pane"].map((sel) => document.querySelector(sel)?.scrollTop ?? 0);
  el.innerHTML = splitOn
    ? '<div class="split" style="--split:' + split.pct + '%"><div class="side" id="side">' + sidePane() + "</div>" +
      '<div class="divider" role="separator" aria-orientation="vertical"' + tip("divider") + "></div>" +
      '<div class="pane">' + renderTriage() + "</div></div>"
    : tab === "status" ? renderStatus() : tab === "signoff" ? renderSignoff() : tab === "push" ? renderPush() : tab === "backlog" ? renderBacklog() : renderTriage();
  syncCurrent();
  if (pulsing) {
    pulsing = false;
    for (const sel of ["#side g.st-triage", "#side g.st-decided", '#tabs button[data-tab="open"]', '#tabs button[data-tab="decided"]', '#tabs button[data-tab="backlog"]'])
      document.querySelector(sel)?.classList.add("pulse");
  }
  document.body.insertAdjacentHTML("beforeend", document.getElementById("keys") ? "" : keysBox());
  if (splitOn)
    [".split .side", ".split .pane"].forEach((sel, n) => {
      const pane = document.querySelector(sel);
      if (pane) pane.scrollTop = keep[n];
    });
  syncToggleAll();
}
function sidePane() {
  const s = loopState;
  if (!s) return '<div class="empty">Loading.</div>';
  if (s.error || !s.board) return '<div class="err">Board unreadable: ' + esc(s.error || "no data") + "</div>";
  return renderStates(s.board);
}
// The diagram beside Triage, and the tab counts, read the app every 15 s
// while the page shows them.
async function refreshSide() {
  if (document.hidden || tab !== "open" || !split.on || !wideScreen.matches) return;
  try {
    [loopState, items, packets] = await Promise.all([api("/api/status"), api("/api/items?state=all"), api("/api/packets")]);
  } catch {
    return;
  }
  // The list itself waits for the next full render, so a note being typed stays.
  renderTabs();
  const side = document.getElementById("side");
  if (side) side.innerHTML = sidePane();
}
setInterval(refreshSide, 15000);
document.addEventListener("visibilitychange", refreshSide);
// Dragging the divider sets the width split. CSS clamps it so neither pane
// gets too narrow; the saved value is clamped the same way here.
document.addEventListener("pointerdown", (e) => {
  const div = e.target.closest && e.target.closest(".divider");
  if (!div) return;
  e.preventDefault();
  const box = div.parentElement;
  div.setPointerCapture(e.pointerId);
  div.classList.add("dragging");
  const move = (ev) => {
    const r = box.getBoundingClientRect();
    const min = (260 / r.width) * 100;
    const max = ((r.width - 430) / r.width) * 100;
    split.pct = Math.round(Math.min(Math.max(((ev.clientX - r.left) / r.width) * 100, min), Math.max(min, max)) * 10) / 10;
    box.style.setProperty("--split", split.pct + "%");
  };
  const up = () => {
    div.removeEventListener("pointermove", move);
    div.removeEventListener("pointerup", up);
    div.removeEventListener("pointercancel", up);
    div.classList.remove("dragging");
    saveSplit();
  };
  div.addEventListener("pointermove", move);
  div.addEventListener("pointerup", up);
  div.addEventListener("pointercancel", up);
});
// toggle does not bubble: listen in the capture phase.
document.addEventListener(
  "toggle",
  (e) => {
    const d = e.target;
    if (!d.dataset || !d.dataset.dkey) return;
    if (d.open) openDetails.add(d.dataset.dkey);
    else openDetails.delete(d.dataset.dkey);
    syncToggleAll();
  },
  true,
);
function showErr(id, msg) {
  const el = document.querySelector('[data-err="' + CSS.escape(id) + '"]');
  if (el) el.textContent = msg;
}
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-toastundo]")) return runToastUndo();
  // A click on a card makes it current, as for the keys.
  const cardEl = e.target.closest("#list [data-card]");
  if (cardEl) {
    currentId = cardEl.dataset.card;
    currentIndex = cardEls().indexOf(cardEl);
    for (const el of cardEls()) el.classList.toggle("current", el === cardEl);
  }
  const gl = e.target.closest("[data-goto]");
  if (gl) {
    e.preventDefault();
    return gotoCard(gl.dataset.goto);
  }
  const cp = e.target.closest("[data-copy]");
  if (cp) {
    e.preventDefault();
    e.stopPropagation();
    if (await copyText(cp.dataset.copy)) {
      cp.innerHTML = DONE_ICON;
      cp.classList.add("done");
      setTimeout(() => {
        cp.innerHTML = COPY_ICON;
        cp.classList.remove("done");
      }, 1200);
    }
    return;
  }
  if (e.target.closest("[data-keys]")) {
    keysOpen = !keysOpen;
    document.getElementById("keys").hidden = !keysOpen;
    return;
  }
  const vf = e.target.closest("[data-vf]");
  if (vf) {
    const [k, field, val] = JSON.parse(vf.dataset.vf);
    const list = view[k][field];
    view[k][field] = list.includes(val) ? list.filter((x) => x !== val) : list.concat(val);
    saveView(k);
    return render();
  }
  const cv = e.target.closest("[data-clearview]");
  if (cv) {
    view[cv.dataset.clearview] = JSON.parse(JSON.stringify(VIEW_DEFAULT[cv.dataset.clearview]));
    saveView(cv.dataset.clearview);
    return render();
  }
  if (e.target.closest("[data-split]")) {
    split.on = !split.on;
    saveSplit();
    render();
    return;
  }
  if (e.target.closest("[data-dall]")) {
    const all = [...document.querySelectorAll(CARD_DETAILS)];
    const open = !all.every((d) => d.open);
    for (const d of all) {
      d.open = open;
      if (open) openDetails.add(d.dataset.dkey);
      else openDetails.delete(d.dataset.dkey);
    }
    syncToggleAll();
    return;
  }
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
  if (d.bring) {
    backlogPicks[d.bring] = { choice: null, priority: null, note: "" };
    return render();
  }
  if (d.bcancel) {
    delete backlogPicks[d.bcancel];
    return render();
  }
  if (d.bpick) {
    backlogPicks[d.id][d.bpick] = d.v;
    return render();
  }
  if (d.bconfirm) {
    const id = d.bconfirm;
    const k = backlogPicks[id];
    if (!k.choice || !k.priority) return showErr(id, "Pick a choice and a priority first.");
    return sendOff(id, t, async () => {
      await api("/api/backlog/" + encodeURIComponent(id) + "/bring", { method: "POST", body: k });
      delete backlogPicks[id];
    }, "Brought in: " + id, () => undoTriage(id));
  }
  if (d.preset) {
    const o = packets.find((x) => x.taskId === d.id).options.find((x) => x.label === d.preset);
    Object.assign(packetPicks[d.id], { choice: o.decision, note: o.note, preset: o.label });
    return render();
  }
  if (d.ppick) {
    packetPicks[d.id][d.ppick] = d.v;
    return render();
  }
  if (d.pdecide) {
    const k = packetPicks[d.pdecide];
    if (!k.choice) return showErr(d.pdecide, "Pick a choice or an option first.");
    if (tagged(k.choice) && !k.priority) return showErr(d.pdecide, "Pick a priority first.");
    if (k.choice === "go" && !k.note.trim()) return showErr(d.pdecide, "go needs a note: the design to build. An option fills it.");
    const id = d.pdecide;
    return sendOff(id, t, async () => {
      await api("/api/packets/" + encodeURIComponent(id) + "/decide", { method: "POST", body: k });
      later.delete(id);
    }, "Decided: " + id, () => undoPacket(id));
  }
  if (d.pundo) return undoPacket(d.pundo);
  if (d.approve) {
    const id = d.approve;
    let edits = null;
    return sendOff(id, t, async () => {
      clearTimeout(commentTimers[id]);
      if (soComments[id]) await api("/api/signoff/" + encodeURIComponent(id) + "/comments", { method: "POST", body: soComments[id] });
      const it = await api("/api/signoff/" + encodeURIComponent(id) + "/approve", { method: "POST" });
      edits = it && it.decision && it.decision.edits;
    }, () =>
      edits
        ? { text: "Approved, edits filed: task " + edits, undo: null }
        : { text: "Approved: " + id + ", moved to Push", undo: () => act(id, () => api("/api/signoff/" + encodeURIComponent(id) + "/undo", { method: "POST" })) });
  }
  if (d.sundo) return act(d.sundo, () => api("/api/signoff/" + encodeURIComponent(d.sundo) + "/undo", { method: "POST" }));
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
    const id = d.later;
    return sendOff(id, null, async () => later.add(id), "Moved to the end: " + id, async () => {
      later.delete(id);
      render();
    }, false);
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
    const id = d.decide;
    const k = picks[id];
    if (tagged(k.choice) && !k.priority) return showErr(id, "Pick a priority first.");
    return sendOff(id, t, async () => {
      await api("/api/items/" + encodeURIComponent(id) + "/decide", { method: "POST", body: k });
      later.delete(id);
    }, "Decided: " + id, () => undoTriage(id));
  }
  if (d.undo) return undoTriage(d.undo);
});
// Ctrl+Enter (Cmd+Enter) in a note presses the card's Confirm (or Bring in)
// button, so the same checks and errors apply. Enter and Shift+Enter add a line.
const NOTE_CONFIRM = { note: "decide", pnote: "pdecide", bnote: "bconfirm" };
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing || e.target.tagName !== "TEXTAREA") return;
  for (const [field, button] of Object.entries(NOTE_CONFIRM)) {
    const id = e.target.dataset[field];
    if (id === undefined) continue;
    const btn = document.querySelector("[data-" + button + '="' + CSS.escape(id) + '"]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    btn.click();
    return;
  }
});
document.addEventListener("change", (e) => {
  const k = e.target.dataset && e.target.dataset.sort;
  if (!k) return;
  view[k].sort = e.target.value;
  saveView(k);
  render();
});
document.addEventListener("input", (e) => {
  const ds = e.target.dataset || {};
  if (ds.search !== undefined) {
    view[ds.search].q = e.target.value;
    saveView(ds.search);
    rerenderCards();
    // The bar itself stays, so the box keeps the cursor.
    const n = activeFilters(ds.search);
    const clear = document.querySelector('[data-clearview="' + ds.search + '"]');
    if (clear) clear.hidden = !n;
    const sum = document.querySelector('details[data-dkey="filters:' + ds.search + '"] summary');
    if (sum) sum.textContent = "Filters" + (n ? " (" + n + " on)" : "");
    return;
  }
  if (ds.note !== undefined && picks[ds.note]) picks[ds.note].note = e.target.value;
  if (ds.pnote !== undefined && packetPicks[ds.pnote]) packetPicks[ds.pnote].note = e.target.value;
  if (ds.rnote !== undefined) rejectNotes[ds.rnote] = e.target.value;
  if (ds.bnote !== undefined && backlogPicks[ds.bnote]) backlogPicks[ds.bnote].note = e.target.value;
  if (ds.comment !== undefined) {
    const [taskId, kind, n] = ds.comment.split(":");
    const c = soComments[taskId];
    if (!c) return;
    c[kind][n] = e.target.value;
    const btn = document.querySelector('[data-approve="' + CSS.escape(taskId) + '"]');
    if (btn) btn.textContent = approveLabel(taskId);
    clearTimeout(commentTimers[taskId]);
    commentTimers[taskId] = setTimeout(() => {
      api("/api/signoff/" + encodeURIComponent(taskId) + "/comments", { method: "POST", body: c }).catch((err) => showErr(taskId, err.message));
    }, 600);
  }
});
readLocation();
// Open on Triage while cards wait for Nil, else on the status.
load().then(() => {
  if (tab === "status" && triageCount() > 0) {
    tab = "open";
    render();
  }
});
setInterval(() => {
  if (!document.activeElement || !["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement.tagName)) load();
}, 60000);
