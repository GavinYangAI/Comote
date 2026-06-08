import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);

function readRoot(relPath) {
  return readFileSync(fileURLToPath(new URL(relPath, ROOT)), "utf8");
}

test("bin/comote.js exists and starts with the node shebang", () => {
  const bin = readRoot("bin/comote.js");
  assert.equal(
    bin.split("\n")[0],
    "#!/usr/bin/env node",
    "first line must be the node shebang",
  );
});

test("package.json exposes the comote bin and a self-contained files whitelist", () => {
  const pkg = JSON.parse(readRoot("package.json"));

  // npm-installable as a global CLI: `comote` -> bin/comote.js
  assert.equal(pkg.bin?.comote, "bin/comote.js");

  // Only the daemon ships; the whitelist must carry every runtime dir.
  assert.ok(Array.isArray(pkg.files), "files must be an array");
  for (const dir of ["src", "public", "bin"]) {
    assert.ok(pkg.files.includes(dir), `files must include "${dir}"`);
  }

  // Publishable, and pins the Node floor the codex CLI / Node 22 features need.
  assert.equal(pkg.private, false, "private must be false to publish");
  assert.ok(pkg.engines?.node, "engines.node must be present");
});
