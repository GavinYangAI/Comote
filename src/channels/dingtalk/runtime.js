// src/channels/dingtalk/runtime.js
import { BaseChannelRuntime } from "../base/runtime.js";
import { routerReplyToSemantic } from "../base/messages.js";
import { createDingTalkRenderer } from "./renderer.js";
import { approvalResolvedCardData } from "./cards.js";
import { toParamMap } from "./cards.js";

// DingTalk runtime. Inbound (Stream), outbound queue delivery via the renderer,
// status and driver wiring are owned by BaseChannelRuntime. This subclass adds the
// card-button callback handling (handleCardAction via the driver onAction hook):
// approvals resolve + update the card in-frame; picks dispatch async (the callback
// has a tight ack window). Live thread-card methods are added in Part B.
export class DingTalkRuntimeService extends BaseChannelRuntime {
  constructor({ adapter, outboundQueue, renderer, driver = null, persist = null, eventLog = null }) {
    if (!adapter) throw new Error("adapter is required");
    if (!outboundQueue) throw new Error("outboundQueue is required");
    super({
      channelId: "dingtalk",
      inboundMode: "push",
      adapter,
      outboundQueue,
      renderer: renderer ?? createDingTalkRenderer(),
      driver,
      persist,
      eventLog,
      dedupMax: 500,
    });
    // Card-action callbacks arrive through the driver onAction hook; the base
    // start() wires this into driver.startEventStream.
    this.onAction = (action) => this.handleCardAction(action);
  }

  // Handles a DingTalk TOPIC_CARD callback payload. Returns an in-frame card-update
  // object (becomes the ACK) or {} when nothing to update.
  async handleCardAction(payload) {
    const params = readCallbackParams(payload);
    if (!params?.action) return {};
    const router = this.adapter?.commandRouter ?? null;

    if (params.action === "approve" || params.action === "reject") {
      const decision = params.action === "approve" ? "accept" : "decline";
      await router?.resolveApproval?.(params.code, decision);
      const resolved = approvalResolvedCardData({ code: params.code, decision });
      // In-frame card update: flip the card to its resolved face.
      return { cardUpdateOptions: { updateCardDataByKey: true }, cardData: { cardParamMap: toParamMap({ title: resolved.title, body: resolved.body, done: true }) } };
    }

    if (params.action === "pick") {
      const conversationId = params.conv;
      if (!router || !conversationId) return {};
      // The callback has a tight ack window; routing a pick involves a Codex RPC +
      // a follow-up card. Hand it off and ack immediately; the result lands as a
      // fresh message when ready (mirrors feishu).
      const identity = { channel: "dingtalk", stableId: conversationId };
      void this.dispatchPickAsync({ identity, selector: String(params.index), pickKind: params.pickKind, conversationId });
      return {};
    }

    return {};
  }

  async dispatchPickAsync({ identity, selector, pickKind, conversationId }) {
    const router = this.adapter?.commandRouter ?? null;
    if (!router) return;
    let reply;
    try {
      reply = pickKind === "project" ? await router.chooseProject(identity, selector) : await router.useSessionAsync(identity, selector);
    } catch (error) {
      this.eventLog?.error?.("钉钉卡片点击：路由失败", { error: error.message });
      const semantic = routerReplyToSemantic({ kind: "text", text: error.message }, { channel: "dingtalk", conversationId });
      if (semantic) {
        await this.adapter.sendReply(semantic).catch(() => {});
        await this.deliverQueued().catch(() => {});
      }
      return;
    }
    const normalized = typeof reply === "string" ? { kind: "text", text: reply } : reply;
    const dedupeKey = `dingtalk:pick:${identity.stableId}:${pickKind}:${selector}:${Date.now()}`;
    const semantic = routerReplyToSemantic(normalized, { channel: "dingtalk", conversationId });
    if (semantic) {
      await this.adapter.sendReply({ ...semantic, dedupeKey }).catch(() => {});
      await this.deliverQueued().catch(() => {});
    }
  }
}

// Pulls the button params out of a TOPIC_CARD callback payload. The params object
// is JSON-nested under content.cardPrivateData.params.
function readCallbackParams(payload) {
  try {
    const content = typeof payload.content === "string" ? JSON.parse(payload.content) : payload.content ?? {};
    return content?.cardPrivateData?.params ?? null;
  } catch {
    return null;
  }
}
