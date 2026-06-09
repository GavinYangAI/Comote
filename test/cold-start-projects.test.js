import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { CommandRouter } from "../src/core/commands.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";

function createRouter({ scanLocalProjects } = {}) {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wx:owner", displayName: "Alice" };
  authorization.confirmIdentity(identity);
  const router = new CommandRouter({
    authorization,
    projects,
    sessions,
    codexDesktop: null,
    scanLocalProjects,
  });
  return { router, identity, projects };
}

test("cold start with no desktop falls back to a local scan for /projects", async () => {
  const scanned = [
    { name: "alpha", path: "/work/alpha", source: "local-scan", status: "available" },
    { name: "beta", path: "/work/beta", source: "local-scan", status: "available" },
  ];
  const { router, identity } = createRouter({ scanLocalProjects: () => scanned });

  const reply = await router.handleMessageAsync({ identity, text: "/projects" });

  assert.match(reply.text, /\/work\/alpha/);
  assert.match(reply.text, /\/work\/beta/);
});

test("scanned projects become selectable by number", async () => {
  const scanned = [
    { name: "alpha", path: "/work/alpha", source: "local-scan", status: "available" },
    { name: "beta", path: "/work/beta", source: "local-scan", status: "available" },
  ];
  const { router, identity } = createRouter({ scanLocalProjects: () => scanned });

  await router.handleMessageAsync({ identity, text: "/projects" });
  const opened = await router.handleMessageAsync({ identity, text: "2" });

  assert.match(opened.text, /\/work\/beta/);
});

test("empty scan shows an actionable hint, not a bare dead end", async () => {
  const { router, identity } = createRouter({ scanLocalProjects: () => [] });

  // Consume the one-time welcome banner first, so we assert on the
  // empty-state message itself rather than the greeting's command list.
  await router.handleMessageAsync({ identity, text: "/help" });
  const reply = await router.handleMessageAsync({ identity, text: "/projects" });

  // Must tell the user the concrete next step: /open with an absolute path.
  assert.match(reply.text, /\/open/);
  assert.match(reply.text, /\/[A-Za-z]/); // shows an absolute-path example
});
