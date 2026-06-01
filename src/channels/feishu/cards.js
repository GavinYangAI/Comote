// Pure Feishu interactive-card builders. No network calls, no mutable state.
// Cards use the "config + elements" format already used by this channel.

const PHASES = {
  started: { title: "🚀 Codex 开始处理", template: "blue" },
  progress: { title: "⏳ Codex 处理中", template: "blue" },
  streaming: { title: "✍️ Codex 正在回复", template: "blue" },
  completed: { title: "✅ Codex 已完成", template: "green" },
  error: { title: "❌ Codex 出错", template: "red" },
  cancelled: { title: "⛔ 任务已取消", template: "grey" },
};

// Feishu caps a markdown element at ~4096 chars; stay well below that limit
// by splitting long output into multiple elements.
const MARKDOWN_ELEMENT_LIMIT = 3000;

export function renderMarkdown(text) {
  const value = String(text ?? "").trim();
  if (!value) {
    return [{ tag: "markdown", content: "_（无内容）_" }];
  }
  if (value.length <= MARKDOWN_ELEMENT_LIMIT) {
    return [{ tag: "markdown", content: value }];
  }
  // Split long output at line boundaries so a break never lands mid-line.
  // Track fenced code blocks: when a break falls inside a fence, close it on
  // the current element and reopen it on the next so each element is valid.
  const chunks = [];
  let current = "";
  let fenceOpen = false;
  for (const rawLine of value.split("\n")) {
    const togglesFence = rawLine.trimStart().startsWith("```");
    // Inside a fence each element also carries a reopened "```\n" prefix and a
    // "\n```" suffix; reserve room for both so no element exceeds the limit.
    const limit = fenceOpen ? MARKDOWN_ELEMENT_LIMIT - 8 : MARKDOWN_ELEMENT_LIMIT;
    // A single line longer than the limit must still be hard-split.
    const pieces =
      rawLine.length > limit
        ? rawLine.match(new RegExp(`[\\s\\S]{1,${limit}}`, "g")) ?? [rawLine]
        : [rawLine];
    for (const piece of pieces) {
      const candidate = current ? `${current}\n${piece}` : piece;
      if (current && candidate.length > limit) {
        chunks.push(fenceOpen ? `${current}\n\`\`\`` : current);
        current = fenceOpen ? `\`\`\`\n${piece}` : piece;
      } else {
        current = candidate;
      }
    }
    if (togglesFence) {
      fenceOpen = !fenceOpen;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.map((content) => ({ tag: "markdown", content }));
}

export function textCard(text) {
  return {
    config: { wide_screen_mode: true },
    elements: renderMarkdown(text),
  };
}

export function statusCard({ phase, threadId = null, steps = 0, text = "", done = false, files = [] }) {
  const meta = PHASES[phase] ?? PHASES.progress;
  const elements = [];
  if (phase === "started" || phase === "progress") {
    elements.push({ tag: "markdown", content: stepsLine(steps) });
  }
  if (text) {
    elements.push(...renderMarkdown(text));
  }
  if (!done && threadId) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "取消任务" },
          type: "danger",
          value: { kind: "cancel", threadId },
        },
      ],
    });
  }
  if (files.length > 0 && threadId) {
    elements.push({ tag: "markdown", content: "**Codex 改动的文件**（点按钮发到这里）：" });
    elements.push({
      tag: "action",
      actions: files.slice(0, 8).map((file) => ({
        tag: "button",
        text: {
          tag: "plain_text",
          content: `📎 ${truncate(file.name || file.path.split(/[/\\]/).pop() || "", 36)}`,
        },
        value: { kind: "pushfile", threadId, path: file.path },
      })),
    });
    if (files.length > 8) {
      elements.push({
        tag: "markdown",
        content: `…还有 ${files.length - 8} 个，用 \`/file <路径>\` 单独获取。`,
      });
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: meta.title }, template: meta.template },
    elements: elements.length > 0 ? elements : [{ tag: "markdown", content: "…" }],
  };
}

export function approvalCard({ shortCode, detail }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `⚠️ Codex 请求审批 [${shortCode}]` },
      template: "orange",
    },
    elements: [
      { tag: "markdown", content: String(detail ?? "Codex 请求执行一个操作。") },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "批准" },
            type: "primary",
            value: { kind: "approval", code: shortCode, decision: "accept" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "拒绝" },
            type: "danger",
            value: { kind: "approval", code: shortCode, decision: "decline" },
          },
        ],
      },
    ],
  };
}

export function approvalResolvedCard({ code, decision }) {
  const accepted = decision === "accept";
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: accepted ? `✅ 已批准 [${code}]` : `⛔ 已拒绝 [${code}]`,
      },
      template: accepted ? "green" : "grey",
    },
    elements: [{ tag: "markdown", content: accepted ? "已批准该请求。" : "已拒绝该请求。" }],
  };
}

export function pickerCard({ kind, title, items = [], text = "" }) {
  const elements = [];
  if (text) {
    elements.push(...renderMarkdown(text));
  }
  elements.push({
    tag: "action",
    actions: items.slice(0, 20).map((item) => ({
      tag: "button",
      text: { tag: "plain_text", content: truncate(item.label, 40) },
      value: { kind: "pick", pickKind: kind, index: String(item.index) },
    })),
  });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template: "blue" },
    elements,
  };
}

function stepsLine(steps) {
  return steps > 0 ? `已执行 **${steps}** 步…` : "正在启动…";
}

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
