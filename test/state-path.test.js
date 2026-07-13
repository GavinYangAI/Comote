// C-2: ONE state-path rule shared by the daemon and the CLI.
// Priority: --state-path flag > $COMOTE_STATE_PATH > legacy CWD-relative
// .comote/state.json (only when it exists and the new default does not) >
// default ~/.comote/state.json (absolute).

import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve, sep } from "node:path";

import {
  defaultStatePath,
  LEGACY_STATE_RELATIVE_PATH,
  resolveStatePath,
} from "../src/core/persistence.js";

const HOME = `${sep}home${sep}alice`;
const CWD = `${sep}work${sep}project`;
const home = () => HOME;
const cwd = () => CWD;
const DEFAULT = join(HOME, ".comote", "state.json");
const LEGACY = resolve(CWD, LEGACY_STATE_RELATIVE_PATH);

test("defaultStatePath: absolute ~/.comote/state.json", () => {
  assert.equal(defaultStatePath({ home }), DEFAULT);
});

test("resolveStatePath: --state-path flag wins over everything", () => {
  const { path, source } = resolveStatePath({
    flags: { "state-path": "/tmp/x.json" },
    env: { COMOTE_STATE_PATH: "/env/y.json" },
    exists: () => true,
    home,
    cwd,
  });
  assert.equal(path, "/tmp/x.json");
  assert.equal(source, "flag");
});

test("resolveStatePath: $COMOTE_STATE_PATH wins over default/legacy", () => {
  const { path, source } = resolveStatePath({
    env: { COMOTE_STATE_PATH: "/env/y.json" },
    exists: () => true,
    home,
    cwd,
  });
  assert.equal(path, "/env/y.json");
  assert.equal(source, "env");
});

test("resolveStatePath: nothing on disk → new ~/.comote default", () => {
  const { path, source } = resolveStatePath({ env: {}, exists: () => false, home, cwd });
  assert.equal(path, DEFAULT);
  assert.equal(source, "default");
});

test("resolveStatePath: legacy CWD file exists and default does not → legacy, with a warning", () => {
  const warnings = [];
  const { path, source } = resolveStatePath({
    env: {},
    exists: (p) => p === LEGACY,
    home,
    cwd,
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.equal(path, LEGACY);
  assert.equal(source, "legacy");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /legacy state file/);
  assert.ok(warnings[0].includes(LEGACY));
});

test("resolveStatePath: when BOTH exist the new default wins (no silent legacy pin)", () => {
  const { path, source } = resolveStatePath({ env: {}, exists: () => true, home, cwd });
  assert.equal(path, DEFAULT);
  assert.equal(source, "default");
});

test("resolveStatePath: CWD == home never double-counts the same file as legacy", () => {
  // resolve(home, ".comote/state.json") === defaultStatePath(home) — must
  // resolve to source "default" even when the file exists.
  const { path, source } = resolveStatePath({
    env: {},
    exists: (p) => p === DEFAULT,
    home,
    cwd: () => HOME,
  });
  assert.equal(path, DEFAULT);
  assert.equal(source, "default");
});
