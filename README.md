# isomux-loop

The Isomux app for the continuous loop (design: isomux `internal-docs/continuous-loop-design.md`, task 178dbb5a).

Triage, the first view: the curator agent pushes one proposal per board task (priority, class, keep/rescope/obsolete, why). Nil decides on each card. The app messages its target agent (the curator) once per burst of decisions, and the curator writes them to the board and reports back. App tokens cannot touch the task board, so the app never does.

Curator API: `curl -s http://127.0.0.1:$PORT/api/help`.

State: `$ISOMUX_APP_DATA_DIR/triage.json`. Run: `bun run start`. Tests: `bun test`.

Later views (copy review, the hourly tick, loop status) follow the design doc.
