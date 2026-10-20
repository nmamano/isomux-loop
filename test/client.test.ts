import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The page script has no build step, so nothing else parses it before a browser does.
test("the page script parses", () => {
  const js = readFileSync(new URL("../src/client.js", import.meta.url), "utf8");
  expect(() => new Function(js)).not.toThrow();
});
