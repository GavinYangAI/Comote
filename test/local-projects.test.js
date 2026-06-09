import assert from "node:assert/strict";
import { test } from "node:test";

import { scanLocalProjects } from "../src/core/local-projects.js";

// A minimal fake fs: readdirSync returns Dirent-like entries.
function fakeFs(byPath) {
  return {
    readdirSync(dir) {
      const entries = byPath[dir];
      if (!entries) {
        const err = new Error(`ENOENT: ${dir}`);
        err.code = "ENOENT";
        throw err;
      }
      return entries.map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
      }));
    },
  };
}

test("lists immediate subdirectories as projects, skipping files", () => {
  const fs = fakeFs({
    "/work": [
      ["alpha", true],
      ["beta", true],
      ["notes.txt", false],
    ],
  });
  const projects = scanLocalProjects({ root: "/work", fs });
  assert.deepEqual(
    projects.map((p) => p.path),
    ["/work/alpha", "/work/beta"],
  );
});

test("skips hidden (dotfile) directories", () => {
  const fs = fakeFs({
    "/work": [
      ["repo", true],
      [".cache", true],
      [".git", true],
    ],
  });
  const projects = scanLocalProjects({ root: "/work", fs });
  assert.deepEqual(
    projects.map((p) => p.name),
    ["repo"],
  );
});

test("stamps source local-scan and available status", () => {
  const fs = fakeFs({ "/work": [["repo", true]] });
  const [project] = scanLocalProjects({ root: "/work", fs });
  assert.equal(project.source, "local-scan");
  assert.equal(project.status, "available");
  assert.equal(project.name, "repo");
  assert.equal(project.path, "/work/repo");
});

test("COMOTE_PROJECT_ROOT env wins over home directory", () => {
  const fs = fakeFs({ "/configured": [["x", true]] });
  const projects = scanLocalProjects({
    fs,
    env: { COMOTE_PROJECT_ROOT: "/configured" },
    homedir: () => "/home/user",
  });
  assert.deepEqual(projects.map((p) => p.path), ["/configured/x"]);
});

test("falls back to home directory when env is unset", () => {
  const fs = fakeFs({ "/home/user": [["x", true]] });
  const projects = scanLocalProjects({
    fs,
    env: {},
    homedir: () => "/home/user",
  });
  assert.deepEqual(projects.map((p) => p.path), ["/home/user/x"]);
});

test("returns empty list when the root cannot be read", () => {
  const fs = fakeFs({});
  const projects = scanLocalProjects({ root: "/missing", fs });
  assert.deepEqual(projects, []);
});

test("sorts projects by name for stable ordering", () => {
  const fs = fakeFs({
    "/work": [
      ["gamma", true],
      ["alpha", true],
      ["beta", true],
    ],
  });
  const projects = scanLocalProjects({ root: "/work", fs });
  assert.deepEqual(
    projects.map((p) => p.name),
    ["alpha", "beta", "gamma"],
  );
});
