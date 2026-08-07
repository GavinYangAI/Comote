import { approvalDetail } from "../base/approval-format.js";
import { t } from "../../core/i18n/index.js";

const STATE_TEMPLATES = {
  running: "blue",
  waiting: "orange",
  completed: "green",
  failed: "red",
  interrupted: "grey",
  unknown: "grey",
};

export function globalManagerDashboardCard(snapshot = {}) {
  const counts = snapshot.counts ?? {};
  const tasks = (snapshot.tasks ?? []).slice(0, 12);
  const lines = tasks.length > 0
    ? tasks.map((task, index) => {
        const project = task.project?.name ?? t("cmd.status.none");
        return `${index + 1}. **[${task.state}]** ${escapeMarkdown(project)} · ${escapeMarkdown(task.title)}`;
      }).join("\n")
    : t("globalManager.card.noTasks");
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: t("globalManager.card.dashboardTitle") },
      template: snapshot.state === "ready" ? "blue" : "grey",
    },
    elements: [
      {
        tag: "markdown",
        content: t("globalManager.card.counts", {
          running: counts.running ?? 0,
          waiting: counts.waiting ?? 0,
          attention: counts.attention ?? 0,
          completed: counts.completedToday ?? 0,
        }),
      },
      { tag: "hr" },
      { tag: "markdown", content: lines },
      { tag: "note", elements: [{ tag: "plain_text", content: t("globalManager.card.commandHint") }] },
    ],
  };
}

export function globalManagerTaskCard(task) {
  const actions = [];
  if (task.capabilities?.cancel) {
    actions.push({
      tag: "button",
      text: { tag: "plain_text", content: t("globalManager.card.cancel") },
      type: "danger",
      value: { kind: "global_manager_cancel", threadId: task.id },
    });
  }
  const elements = [
    {
      tag: "markdown",
      content: [
        `**${t("globalManager.card.project")}** ${escapeMarkdown(task.project?.name ?? t("cmd.status.none"))}`,
        `**${t("globalManager.card.task")}** ${escapeMarkdown(task.title)}`,
        `**${t("globalManager.card.state")}** ${escapeMarkdown(task.state)}`,
        task.lastActivity?.label ? `**${t("globalManager.card.activity")}** ${escapeMarkdown(task.lastActivity.label)}` : null,
        `\`${task.id}\``,
      ].filter(Boolean).join("\n"),
    },
  ];
  if (actions.length > 0) elements.push({ tag: "action", actions });
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: t("globalManager.card.taskHint", { id: task.id }) }] });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: t("globalManager.card.taskTitle") },
      template: STATE_TEMPLATES[task.state] ?? "grey",
    },
    elements,
  };
}

export function globalManagerApprovalCard(approval) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: t("card.approval.title", { code: approval.shortCode }) },
      template: "orange",
    },
    elements: [
      { tag: "markdown", content: approvalDetail(approval) },
      { tag: "markdown", content: t("state.approval.instructions", { code: approval.shortCode }) },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: t("card.approval.approve") },
            type: "primary",
            value: {
              kind: "global_manager_approval",
              code: approval.shortCode,
              threadId: approval.threadId,
              decision: "accept",
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: t("card.approval.reject") },
            type: "danger",
            value: {
              kind: "global_manager_approval",
              code: approval.shortCode,
              threadId: approval.threadId,
              decision: "decline",
            },
          },
        ],
      },
    ],
  };
}

export function globalManagerTestCard() {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: t("globalManager.card.testTitle") }, template: "green" },
    elements: [{ tag: "markdown", content: t("globalManager.card.testBody") }],
  };
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/([`*_[\]])/g, "\\$1");
}
