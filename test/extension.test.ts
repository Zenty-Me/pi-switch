import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi's native extension loader registers the panel command", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-capabilities-loader-"));
  const result = await discoverAndLoadExtensions([
    resolve(import.meta.dirname, "../src/index.ts"),
  ], temporary, temporary);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.ok(result.extensions[0].commands.has("project-capabilities"));
  assert.equal(result.extensions[0].tools.size, 0);
});
