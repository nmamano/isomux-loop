import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bun runs a module once per run, so an afterEach here would hold in the first
// test file only. bunfig.toml preloads this file: the hook holds in every file.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "loop-store-"));
  dirs.push(d);
  return d;
}
