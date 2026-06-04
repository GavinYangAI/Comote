import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthorizationStore } from "../src/core/authorization.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { CommandRouter } from "../src/core/commands.js";

function makeRouter() {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const router = new CommandRouter({ authorization, projects, sessions });
  return { authorization, projects, sessions, router };
}

test("denies commands from unconfirmed identities", () => {
  const { router } = makeRouter();

  const reply = router.handleMessage({
    identity: { channel: "wechat", stableId: "wxid_unknown", displayName: "Unknown" },
    text: "/status",
  });

  assert.equal(reply.kind, "denied");
});

test("returns status for confirmed identity", () => {
  const { authorization, router } = makeRouter();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  authorization.confirmIdentity(identity);

  const reply = router.handleMessage({ identity, text: "/status" });

  assert.equal(reply.kind, "text");
  assert.match(reply.text, /Comote/);
  assert.match(reply.text, /wechat:Alice/);
});

test("lists projects and sessions using phone commands", () => {
  const { authorization, projects, router } = makeRouter();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{
    name: "comote",
    path: "/home/test/projects/comote",
    source: "manual",
    status: "available",
  }]);

  const projectReply = router.handleMessage({ identity, text: "/projects" });
  const openReply = router.handleMessage({ identity, text: "/open 1" });
  const newReply = router.handleMessage({ identity, text: "/new Build the bridge" });
  const sessionReply = router.handleMessage({ identity, text: "/sessions" });

  assert.match(projectReply.text, /1\. comote/);
  assert.match(openReply.text, /已进入 comote/);
  assert.match(newReply.text, /已创建对话/);
  assert.match(sessionReply.text, /Build the bridge/);
});

test("async sessions command lists Codex Desktop threads when connected", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    listThreads: async ({ cwd }) => ({
      data: [
        {
          id: "thread_1",
          preview: "Continue Comote",
          cwd,
        },
      ],
    }),
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{
    name: "comote",
    path: "/home/test/projects/comote",
    source: "manual",
    status: "available",
  }]);

  router.handleMessage({ identity, text: "/open 1" });
  const reply = await router.handleMessageAsync({ identity, text: "/sessions" });

  assert.equal(reply.kind, "text");
  assert.match(reply.text, /请选择对话/);
  assert.match(reply.text, /0\. 新建对话/);
  assert.match(reply.text, /Continue Comote/);
  assert.ok(reply.picker, "reply has a picker descriptor");
  assert.equal(reply.picker.pickKind, "session");
  assert.ok(reply.picker.items.some((item) => item.label === "Continue Comote" && item.index === "1"));
});

test("async projects command lists Desktop and CLI projects with source labels", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    listProjects: async () => [
      {
        name: "desktop-project",
        path: "/repo/desktop-project",
        source: "codex-desktop",
        status: "available",
      },
      {
        name: "cli-project",
        path: "/repo/cli-project",
        source: "codex-cli",
        status: "available",
      },
    ],
    listThreads: async ({ cwd }) => ({
      data: [
        {
          id: "thread_1",
          preview: "Desktop thread",
          cwd,
        },
      ],
    }),
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{ name: "cli-project", path: "/repo/cli-project", source: "codex-cli", status: "available" }]);

  const projectReply = await router.handleMessageAsync({ identity, text: "/projects" });
  const openReply = await router.handleMessageAsync({ identity, text: "/open 1" });

  assert.match(projectReply.text, /请选择要操作的 Codex Desktop 项目/);
  assert.match(projectReply.text, /1\. desktop-project/);
  assert.match(projectReply.text, /来源: Desktop/);
  assert.match(projectReply.text, /2\. cli-project/);
  assert.match(projectReply.text, /来源: CLI/);
  assert.match(openReply.text, /已进入 desktop-project/);
  assert.match(openReply.text, /请选择对话/);
  assert.match(openReply.text, /0\. 新建对话/);
  assert.match(openReply.text, /Desktop thread/);
});

test("plain phone messages guide project and session selection before sending", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const calls = [];
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    listProjects: async () => [
      {
        name: "desktop-project",
        path: "/repo/desktop-project",
        source: "codex-desktop",
        status: "available",
      },
    ],
    listThreads: async ({ cwd }) => ({
      data: [
        {
          id: "thread_1",
          preview: "Existing thread",
          cwd,
        },
      ],
    }),
    resumeThread: async ({ threadId }) => {
      calls.push(["resumeThread", threadId]);
      return { thread: { id: threadId, preview: "Existing thread" } };
    },
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);

  const projectMenu = await router.handleMessageAsync({ identity, text: "开始" });
  const sessionMenu = await router.handleMessageAsync({ identity, text: "1" });
  const selected = await router.handleMessageAsync({ identity, text: "1" });

  assert.match(projectMenu.text, /请选择要操作的 Codex Desktop 项目/);
  assert.match(projectMenu.text, /1\. desktop-project/);
  assert.match(sessionMenu.text, /已进入 desktop-project/);
  assert.match(sessionMenu.text, /0\. 新建对话/);
  assert.match(sessionMenu.text, /1\. Existing thread/);
  assert.match(selected.text, /已进入对话：Existing thread/);
  assert.match(selected.text, /现在可以直接发消息/);
  assert.deepEqual(calls, [["resumeThread", "thread_1"]]);
  assert.equal(sessions.getActiveSession("/repo/desktop-project").id, "thread_1");
});

test("phone session menu uses 0 to start a new Codex Desktop conversation", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const calls = [];
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    listProjects: async () => [
      {
        name: "desktop-project",
        path: "/repo/desktop-project",
        source: "codex-desktop",
        status: "available",
      },
    ],
    listThreads: async () => ({ data: [] }),
    startThread: async ({ cwd }) => {
      calls.push(["startThread", cwd]);
      return { thread: { id: "thread_new" } };
    },
    startTurn: async ({ threadId, text, cwd }) => {
      calls.push(["startTurn", threadId, text, cwd]);
      return { turnId: "turn_new" };
    },
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);

  await router.handleMessageAsync({ identity, text: "/projects" });
  const sessionMenu = await router.handleMessageAsync({ identity, text: "1" });
  const prompt = await router.handleMessageAsync({ identity, text: "0" });
  const created = await router.handleMessageAsync({ identity, text: "帮我检查测试" });

  assert.match(sessionMenu.text, /0\. 新建对话/);
  assert.match(prompt.text, /请输入新对话的第一条消息/);
  assert.match(created.text, /已新建对话，并发送给 Codex Desktop/);
  assert.deepEqual(calls, [
    ["startThread", "/repo/desktop-project"],
    ["startTurn", "thread_new", "帮我检查测试", "/repo/desktop-project"],
  ]);
  assert.equal(sessions.getActiveSession("/repo/desktop-project").id, "thread_new");
});

test("phone session selection asks for a number when text is sent too early", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    listProjects: async () => [
      {
        name: "desktop-project",
        path: "/repo/desktop-project",
        source: "codex-desktop",
        status: "available",
      },
    ],
    listThreads: async () => ({ data: [{ id: "thread_1", preview: "Existing thread" }] }),
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);

  await router.handleMessageAsync({ identity, text: "开始" });
  await router.handleMessageAsync({ identity, text: "1" });
  const reply = await router.handleMessageAsync({ identity, text: "帮我继续" });

  assert.match(reply.text, /请回复对话编号，或回复 0 新建对话/);
});

test("async /new starts a Codex Desktop thread and turn when connected", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const calls = [];
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    startThread: async ({ cwd }) => {
      calls.push(["startThread", cwd]);
      return { thread: { id: "thread_new" } };
    },
    startTurn: async ({ threadId, text, cwd }) => {
      calls.push(["startTurn", threadId, text, cwd]);
      return { turnId: "turn_new" };
    },
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{ name: "comote", path: "/repo", source: "codex-desktop", status: "available" }]);

  router.handleMessage({ identity, text: "/open 1" });
  const reply = await router.handleMessageAsync({ identity, text: "/new fix tests" });

  assert.equal(reply.kind, "text");
  assert.match(reply.text, /已新建对话，并发送给 Codex Desktop/);
  assert.deepEqual(calls, [
    ["startThread", "/repo"],
    ["startTurn", "thread_new", "fix tests", "/repo"],
  ]);
  assert.equal(sessions.getActiveSession("/repo").id, "thread_new");
});

test("plain messages continue the active Codex Desktop thread", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const calls = [];
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    startTurn: async ({ threadId, text, cwd }) => {
      calls.push({ threadId, text, cwd });
      return { turnId: "turn_2" };
    },
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{ name: "comote", path: "/repo", source: "codex-desktop", status: "available" }]);

  router.handleMessage({ identity, text: "/open 1" });
  sessions.upsertExternalSession({ projectPath: "/repo", id: "thread_1", title: "Existing thread" });
  sessions.useSession("/repo", "thread_1");
  const reply = await router.handleMessageAsync({ identity, text: "continue implementing" });

  assert.match(reply.text, /已发送给 Codex Desktop/);
  assert.deepEqual(calls, [{ threadId: "thread_1", text: "continue implementing", cwd: "/repo" }]);
});

test("plain messages resume the active Codex Desktop thread before starting a turn", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const calls = [];
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    resumeThread: async ({ threadId, cwd }) => {
      calls.push(["resumeThread", threadId, cwd]);
      return { thread: { id: threadId, preview: "Existing thread" } };
    },
    startTurn: async ({ threadId, text, cwd }) => {
      calls.push(["startTurn", threadId, text, cwd]);
      return { turnId: "turn_2" };
    },
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{ name: "comote", path: "/repo", source: "codex-desktop", status: "available" }]);

  router.handleMessage({ identity, text: "/open 1" });
  sessions.upsertExternalSession({ projectPath: "/repo", id: "thread_1", title: "Existing thread" });
  sessions.useSession("/repo", "thread_1");
  const reply = await router.handleMessageAsync({ identity, text: "continue implementing" });

  assert.match(reply.text, /已发送给 Codex Desktop/);
  assert.deepEqual(calls, [
    ["resumeThread", "thread_1", "/repo"],
    ["startTurn", "thread_1", "continue implementing", "/repo"],
  ]);
});

test("inbound image attachments are forwarded to startTurn as resolved image paths", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "telegram", stableId: "tg_owner", displayName: "Alice" };
  const calls = [];
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    resumeThread: async () => ({ thread: { id: "thread_1" } }),
    startTurn: async ({ threadId, text, cwd, images }) => {
      calls.push({ threadId, text, cwd, images });
      return { turnId: "turn_1" };
    },
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{ name: "comote", path: "/repo", source: "codex-desktop", status: "available" }]);

  router.handleMessage({ identity, text: "/open 1" });
  sessions.upsertExternalSession({ projectPath: "/repo", id: "thread_1", title: "Existing thread" });
  sessions.useSession("/repo", "thread_1");

  await router.handleMessageAsync({
    identity,
    text: "what is in this picture?",
    attachments: [
      { type: "image", kind: "image", localPath: ".comote/uploads/a.png", fileName: "a.png" },
      { type: "file", kind: "file", localPath: ".comote/uploads/notes.txt", fileName: "notes.txt" },
    ],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "what is in this picture?");
  // Only the image attachment is forwarded as an image, resolved to an absolute
  // path within the project; the non-image file is not. The expected path is
  // computed via path.resolve so the assertion holds on both POSIX and Windows.
  assert.deepEqual(calls[0].images, [resolve("/repo", ".comote/uploads/a.png")]);
});

test("/approve and /deny resolve pending Codex Desktop approvals", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const decisions = [];
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    resolveApproval: async (id, decision) => {
      decisions.push([id, decision]);
      return { ok: true };
    },
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  authorization.confirmIdentity(identity);

  const approved = await router.handleMessageAsync({ identity, text: "/approve approval_1" });
  const denied = await router.handleMessageAsync({ identity, text: "/deny approval_2" });

  assert.match(approved.text, /已批准 approval_1/);
  assert.match(denied.text, /已拒绝 approval_2/);
  assert.deepEqual(decisions, [
    ["approval_1", "accept"],
    ["approval_2", "decline"],
  ]);
});

test("/new falls back to Codex CLI when Desktop is disconnected", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  const codexDesktop = { getStatus: () => ({ state: "not_connected" }) };
  const codexCli = {
    runPrompt: async ({ cwd, text }) => ({
      id: "cli_1",
      cwd,
      text,
      output: "CLI response",
    }),
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop, codexCli });
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{ name: "comote", path: "/repo", source: "codex-desktop", status: "available" }]);

  router.handleMessage({ identity, text: "/open 1" });
  const reply = await router.handleMessageAsync({ identity, text: "/new inspect repo" });

  assert.match(reply.text, /已启动 Codex CLI 备用会话/);
  assert.match(reply.text, /CLI response/);
});

test("projects reply carries a picker descriptor", async () => {
  const authorization = new AuthorizationStore();
  authorization.confirmIdentity({ channel: "feishu", stableId: "ou_owner", displayName: "Alice" });
  const projects = new ProjectStore();
  projects.replaceProjects([{ name: "comote", path: "/repo/comote", source: "codex-desktop", status: "available" }]);
  const router = new CommandRouter({
    authorization,
    projects,
    sessions: new SessionStore(),
  });

  const reply = await router.handleMessageAsync({
    identity: { channel: "feishu", stableId: "ou_owner", displayName: "Alice" },
    text: "/projects",
  });

  assert.ok(reply.picker, "reply has a picker descriptor");
  assert.equal(reply.picker.pickKind, "project");
  assert.equal(reply.picker.items[0].label, "comote");
  assert.equal(reply.picker.items[0].index, "1");
});

test("cancelThread interrupts the thread via the desktop connector", async () => {
  const cancelled = [];
  const router = new CommandRouter({
    authorization: new AuthorizationStore(),
    projects: new ProjectStore(),
    sessions: new SessionStore(),
    codexDesktop: {
      cancelTurn: async ({ threadId }) => cancelled.push(threadId),
    },
  });

  await router.cancelThread("thread_x");
  assert.deepEqual(cancelled, ["thread_x"]);
});

test("/file on a non-feishu channel delivers (no feishuOnly rejection)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-cmd-"));
  try {
    const p = join(dir, "notes.md");
    await writeFile(p, "# hi\nbody line\n");

    const authorization = new AuthorizationStore();
    const projects = new ProjectStore();
    const sessions = new SessionStore();
    const enqueued = [];
    const outboundQueue = { enqueue: (r) => enqueued.push(r) };
    const identity = { channel: "telegram", stableId: "tg_owner", displayName: "A" };
    const router = new CommandRouter({ authorization, projects, sessions, outboundQueue });
    authorization.confirmIdentity(identity);
    projects.replaceProjects([{ name: "proj", path: dir, source: "codex-desktop", status: "available" }]);

    router.handleMessage({ identity, text: "/open 1" });
    await router.handleMessageAsync({ identity, text: "hi", conversation: { channel: "telegram", conversationId: "chat1" } });

    enqueued.length = 0;
    const reply = await router.handleMessageAsync({ identity, text: "/file notes.md", conversation: { channel: "telegram", conversationId: "chat1" } });

    const textReplies = enqueued.filter((r) => r.kind === "text");
    assert.equal(textReplies.length, 1);
    assert.equal(textReplies[0].channel, "telegram");
    assert.equal(textReplies[0].conversationId, "chat1");
    assert.match(textReplies[0].text, /notes\.md/);
    assert.match(textReplies[0].text, /body line/);
    assert.ok(textReplies[0].dedupeKey, "dedupeKey set so repeats re-send");
    assert.equal(reply.kind, "ignored");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/file with a binary file enqueues a media reply on telegram", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-cmd-"));
  try {
    const p = join(dir, "pic.png");
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const authorization = new AuthorizationStore();
    const projects = new ProjectStore();
    const sessions = new SessionStore();
    const enqueued = [];
    const outboundQueue = { enqueue: (r) => enqueued.push(r) };
    const identity = { channel: "telegram", stableId: "tg_owner2" };
    const router = new CommandRouter({ authorization, projects, sessions, outboundQueue });
    authorization.confirmIdentity(identity);
    projects.replaceProjects([{ name: "proj", path: dir, source: "codex-desktop", status: "available" }]);
    router.handleMessage({ identity, text: "/open 1" });
    await router.handleMessageAsync({ identity, text: "hi", conversation: { channel: "telegram", conversationId: "chat2" } });

    enqueued.length = 0;
    await router.handleMessageAsync({ identity, text: "/file pic.png", conversation: { channel: "telegram", conversationId: "chat2" } });

    const media = enqueued.filter((r) => r.kind === "media");
    assert.equal(media.length, 1);
    assert.equal(media[0].mediaKind, "image");
    assert.equal(media[0].channel, "telegram");
    assert.equal(media[0].path, p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
