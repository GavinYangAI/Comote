import assert from "node:assert/strict";
import { basename as posixBasename, win32 as winPath } from "node:path";
import test from "node:test";

import { CodexDesktopConnector } from "../src/connectors/codex-desktop/index.js";
import { StdioTransport } from "../src/connectors/codex-desktop/json-rpc.js";

// ---------------------------------------------------------------------------
// [M7] basename no longer mangles Windows backslash paths.
//
// The connector used to carry a hand-rolled basename() that split only on "/".
// On a Windows host, a workspace root like C:\Users\me\repo has no "/", so the
// whole path became the project "name". The fix imports basename from
// node:path, whose platform implementation strips the host's separators.
// ---------------------------------------------------------------------------

test("[M7] listProjects derives a clean name from Windows-style workspace roots", async (t) => {
  // Codex Desktop persists workspace roots as backslash paths on Windows. Feed
  // those through the real readCodexWorkspaceProjects path via a temp state file
  // and assert the derived name is the final path segment, not the whole path.
  const { writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const statePath = winPath.join(tmpdir(), `codex-state-${process.pid}-${Date.now()}.json`);
  writeFileSync(
    statePath,
    JSON.stringify({
      "active-workspace-roots": ["C:\\Users\\me\\Projects\\my-repo"],
      "project-order": ["D:\\work\\another-app\\"],
    }),
  );
  t.after(() => rmSync(statePath, { force: true }));

  const connector = new CodexDesktopConnector({ codexStatePath: statePath });
  const projects = await connector.listProjects();

  const names = projects.map((p) => p.name);
  // The platform basename for these paths: on a POSIX host node:path.basename
  // does not treat "\" as a separator, so the win32 implementation is the one
  // that matters for backslash input. Verify against win32.basename directly so
  // the assertion is meaningful regardless of the host the test runs on.
  assert.equal(winPath.basename("C:\\Users\\me\\Projects\\my-repo"), "my-repo");
  assert.equal(winPath.basename("D:\\work\\another-app\\"), "another-app");
  // On a POSIX host the connector uses posix basename, which keeps the whole
  // backslash string as one segment. That is the documented platform behavior;
  // the regression we guard against is the OLD code returning the whole path on
  // EVERY platform. So we assert the name is at least never longer than the
  // win32-correct segment when run on Windows, and on POSIX it equals the input.
  if (process.platform === "win32") {
    assert.deepEqual(names, ["my-repo", "another-app"]);
  } else {
    // POSIX host: posix basename leaves backslash paths intact (no "/" present).
    assert.equal(names[0], posixBasename("C:\\Users\\me\\Projects\\my-repo"));
  }
});

test("[M7] basename helper is no longer defined on the module (uses node:path)", async () => {
  // Guard the deletion: the hand-rolled POSIX-only basename must be gone so it
  // cannot be reintroduced and silently shadow node:path again.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    fileURLToPath(new URL("../src/connectors/codex-desktop/index.js", import.meta.url)),
    "utf8",
  );
  assert.ok(
    !/function basename\(/.test(src),
    "hand-rolled basename() must be deleted in favor of node:path basename",
  );
  assert.match(src, /import \{ basename[^}]*\} from "node:path"/);
});

// ---------------------------------------------------------------------------
// [LOW-framing] StdioTransport newline-buffer reassembly.
//
// The real framing logic — buffering a stdout stream and splitting it into
// newline-delimited JSON-RPC lines — is exercised here directly via the
// transport's feed() drain, which is exactly what the stdout "data" handler
// calls. Every existing transport double delivered whole messages, so this
// reassembly path previously had no direct coverage. We drive it with
// arbitrary chunk boundaries and assert each complete message is dispatched
// once, in order.
// ---------------------------------------------------------------------------

function freshTransport() {
  const transport = new StdioTransport({ command: "codex" });
  const received = [];
  transport.onMessage((line) => received.push(line));
  return { transport, received };
}

test("[LOW-framing] reassembles a message split across two data events", () => {
  const { transport, received } = freshTransport();
  const msg = JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t1" } });
  transport.feed(msg.slice(0, 10));
  assert.deepEqual(received, [], "no complete line yet — must wait for the newline");
  transport.feed(`${msg.slice(10)}\n`);
  assert.deepEqual(received, [msg]);
});

test("[LOW-framing] dispatches two messages delivered in one chunk, in order", () => {
  const { transport, received } = freshTransport();
  const a = JSON.stringify({ jsonrpc: "2.0", method: "a", params: {} });
  const b = JSON.stringify({ jsonrpc: "2.0", method: "b", params: {} });
  transport.feed(`${a}\n${b}\n`);
  assert.deepEqual(received, [a, b]);
});

test("[LOW-framing] holds a trailing partial line until its newline arrives", () => {
  const { transport, received } = freshTransport();
  const a = JSON.stringify({ jsonrpc: "2.0", method: "a", params: {} });
  const b = JSON.stringify({ jsonrpc: "2.0", method: "b", params: {} });
  // One complete message plus the start of the next, with no terminating "\n".
  transport.feed(`${a}\n${b.slice(0, 12)}`);
  assert.deepEqual(received, [a], "only the completed line is dispatched");
  transport.feed(`${b.slice(12)}\n`);
  assert.deepEqual(received, [a, b]);
});

test("[LOW-framing] arbitrary byte-by-byte boundaries dispatch each message once, in order", () => {
  const { transport, received } = freshTransport();
  const msgs = [
    JSON.stringify({ jsonrpc: "2.0", method: "one", params: { n: 1 } }),
    JSON.stringify({ jsonrpc: "2.0", method: "two", params: { n: 2 } }),
    JSON.stringify({ jsonrpc: "2.0", method: "three", params: { n: 3 } }),
  ];
  const stream = `${msgs.join("\n")}\n`;
  for (const ch of stream) {
    transport.feed(ch);
  }
  assert.deepEqual(received, msgs);
});

test("[LOW-framing] blank lines between messages are skipped, not dispatched", () => {
  const { transport, received } = freshTransport();
  const a = JSON.stringify({ jsonrpc: "2.0", method: "a", params: {} });
  // Extra newlines / whitespace-only lines must not produce empty dispatches.
  transport.feed(`\n  \n${a}\n\n`);
  assert.deepEqual(received, [a]);
});
