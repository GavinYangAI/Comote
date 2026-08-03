// Pure Feishu interactive-card builders. No network calls, no mutable state.
// Cards use the "config + elements" format already used by this channel.

import { t } from "../../core/i18n/index.js";

const PHASES = {
  started: { titleKey: "card.phase.started", template: "blue" },
  progress: { titleKey: "card.phase.progress", template: "blue" },
  streaming: { titleKey: "card.phase.streaming", template: "blue" },
  completed: { titleKey: "card.phase.completed", template: "green" },
  error: { titleKey: "card.phase.error", template: "red" },
  cancelled: { titleKey: "card.phase.cancelled", template: "grey" },
};

// Feishu caps a markdown element at ~4096 chars; stay well below that limit
// by splitting long output into multiple elements.
const MARKDOWN_ELEMENT_LIMIT = 3000;

export function renderMarkdown(text) {
  const value = String(text ?? "").trim();
  if (!value) {
    return [{ tag: "markdown", content: t("card.empty") }];
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

export function statusCard({ phase, threadId = null, steps = 0, text = "", done = false, files = [], activities = [], content = [], model = null, reasoningEffort = undefined }) {
  const meta = PHASES[phase] ?? PHASES.progress;
  const elements = [];
  if (phase === "started" || phase === "progress") {
    elements.push({ tag: "markdown", content: stepsLine(steps) });
  }
  const settings = modelSettingsLine(model, reasoningEffort);
  if (settings) {
    elements.push({ tag: "markdown", content: settings });
  }
  const orderedContent = content.length > 0
    ? content
    : [
        ...(activities.length > 0 ? [{ type: "activities", activities }] : []),
        ...(text ? [{ type: "text", text }] : []),
      ];
  for (const block of orderedContent) {
    if (block.type === "activities" && block.activities?.length > 0) {
      elements.push(activityPanel(block.activities));
    } else if (block.type === "text" && block.text) {
      elements.push(...renderMarkdown(block.text));
    }
  }
  if (!done && threadId) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: t("card.cancelButton") },
          type: "danger",
          value: { kind: "cancel", threadId },
        },
      ],
    });
  }
  if (files.length > 0 && threadId) {
    elements.push({ tag: "markdown", content: t("card.changedFiles.intro") });
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
        content: t("card.changedFiles.more", { count: files.length - 8 }),
      });
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: t(meta.titleKey) }, template: meta.template },
    elements: elements.length > 0 ? elements : [{ tag: "markdown", content: "…" }],
  };
}

function activityPanel(activities) {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: t("card.tools.title", { count: activities.length }),
      },
    },
    elements: renderMarkdown(activities.map(formatActivityMarkdown).join("\n\n")),
  };
}

export function approvalCard({ shortCode, detail, autoApproved = false }) {
  const elements = [
    { tag: "markdown", content: String(detail ?? t("card.approval.detailFallback")) },
  ];
  if (autoApproved) {
    elements.push({ tag: "markdown", content: t("state.approval.autoApproved") });
  } else {
    elements.push(
      // Text-command fallback: card-action button callbacks are not guaranteed to
      // reach Comote (Feishu long-connection delivery of `card.action.trigger` is
      // app-config dependent), but `/approve|/deny <code>` always works over the
      // message-event path.
      { tag: "markdown", content: t("state.approval.instructions", { code: shortCode }) },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: t("card.approval.approve") },
            type: "primary",
            value: { kind: "approval", code: shortCode, decision: "accept" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: t("card.approval.acceptForSession") },
            value: { kind: "approval", code: shortCode, decision: "acceptForSession" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: t("card.approval.reject") },
            type: "danger",
            value: { kind: "approval", code: shortCode, decision: "decline" },
          },
        ],
      },
    );
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: t("card.approval.title", { code: shortCode }) },
      template: "orange",
    },
    elements,
  };
}

export function approvalResolvedCard({ code, decision, detail = "" }) {
  const accepted = decision === "accept" || decision === "acceptForSession";
  const status = accepted
    ? t("card.approval.accepted", { code })
    : t("card.approval.rejected", { code });
  const elements = [];
  if (detail) {
    elements.push({ tag: "markdown", content: String(detail) });
  }
  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: status },
        // Feishu has no green success button type. Primary is the documented
        // blue fallback; rejected approvals use the red danger type.
        type: accepted ? "primary" : "danger",
      },
    ],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: status },
      template: accepted ? "green" : "red",
    },
    elements,
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
  const headerTitle = title ?? pickerTitle(kind);
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: headerTitle }, template: "blue" },
    elements,
  };
}

function pickerTitle(kind) {
  if (kind === "model") return t("card.picker.model");
  if (kind === "reasoning") return t("card.picker.reasoning");
  return t(kind === "project" ? "card.picker.project" : "card.picker.conversation");
}

function modelSettingsLine(model, reasoningEffort) {
  if (!model && reasoningEffort === undefined) {
    return null;
  }
  return t("card.model.settings", {
    model: model ?? t("card.model.unknown"),
    reasoningEffort: reasoningEffort ?? t("card.model.defaultReasoning"),
  });
}

function stepsLine(steps) {
  return steps > 0 ? t("card.steps.running", { steps }) : t("card.steps.starting");
}

function formatActivityMarkdown(activity) {
  if (typeof activity === "string") return `- ${activity}`;
  const label = String(activity?.label ?? "");
  const detail = String(activity?.detail ?? "").trim();
  if (!detail) return `- ${label}`;
  return `- **${label}**\n\`\`\`\n${detail.replace(/\`\`\`/g, "` ` `")}\n\`\`\``;
}

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
