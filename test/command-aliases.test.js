import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { CommandRouter, resolveCommandAlias } from "../src/core/commands.js";

function makeRouter() {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const router = new CommandRouter({ authorization, projects, sessions });
  return { authorization, projects, sessions, router };
}

test("resolveCommandAlias maps Chinese aliases to canonical commands", () => {
  assert.equal(resolveCommandAlias("/项目"), "/projects");
  assert.equal(resolveCommandAlias("/会话"), "/sessions");
  assert.equal(resolveCommandAlias("/图片"), "/img");
  assert.equal(resolveCommandAlias("/文件"), "/file");
  assert.equal(resolveCommandAlias("/取消"), "/cancel");
});

test("resolveCommandAlias is case-insensitive for English commands", () => {
  assert.equal(resolveCommandAlias("/Projects"), "/projects");
  assert.equal(resolveCommandAlias("/STATUS"), "/status");
  assert.equal(resolveCommandAlias("/Use"), "/use");
});

test("resolveCommandAlias leaves plain text and unknown words untouched", () => {
  assert.equal(resolveCommandAlias(""), "");
  assert.equal(resolveCommandAlias("Hello"), "Hello");
  assert.equal(resolveCommandAlias("/unknown"), "/unknown");
});

test("Chinese alias routes through handleMessage like the English command", () => {
  const { authorization, projects, router } = makeRouter();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  authorization.confirmIdentity(identity);
  projects.replaceProjects([
    { name: "comote", path: "/home/test/projects/comote", source: "manual", status: "available" },
  ]);

  const viaChinese = router.handleMessage({ identity, text: "/项目" });
  const viaUpper = router.handleMessage({ identity, text: "/Projects" });

  assert.match(viaChinese.text, /1\. comote/);
  assert.match(viaUpper.text, /1\. comote/);
});

test("help text lists Chinese aliases and case-insensitivity hint", () => {
  const { authorization, router } = makeRouter();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  authorization.confirmIdentity(identity);

  const reply = router.handleMessage({ identity, text: "/帮助" });

  assert.match(reply.text, /大小写不敏感/);
  assert.match(reply.text, /\/项目/);
  assert.match(reply.text, /\/img \(\/图片\)/);
});
