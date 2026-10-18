# isomux-loop

The Isomux app for the continuous loop (design: isomux `internal-docs/continuous-loop-design.md`, task 178dbb5a).

- Pause stops dispatch and the tick (Isomux PM pauses around restarts and while batch work holds workers).
- Dispatch, every 2 minutes: each free Isomux Worker gets the next ready board task (priority, then age), claimed with a versioned PATCH, and a `/isomux-loop-worker <task id>` message.
- Tick, hourly: idle workers that hold a task get a nudge; Isomux Main hears how many tasks wait to merge.
- Triage: the curator (the app's owner and message target) pushes one proposal per task; Nil decides on each card; the app messages the curator once per burst of decisions.
- Copy sign-off: Isomux PM pushes old and new copy per task; `/copy/<task id>` shows them side by side for an ask.
- Status: ready queue, holders, tasks waiting to merge, tasks parked for Nil.

The board is the loop's only state. The app keeps triage proposals, copy and the pause flag in `$ISOMUX_APP_DATA_DIR`. It reaches the board and other agents with the app token, which has its owner's reach since isomux task c0204eb6. Constants (room, worker names, intervals) are in `src/config.ts`.

API: `curl -s http://127.0.0.1:$PORT/api/help`. Run: `bun run start`. Tests: `bun test`.
