import { BaseChannelRuntime } from "../base/runtime.js";
import { createWeChatRenderer } from "./renderer.js";

// WeChat runtime. Inbound (poll loop), outbound queue delivery via the renderer,
// status, dedup (DedupTracker), and cursor advance are all owned by
// BaseChannelRuntime's poll path. This subclass keeps only what is genuinely
// wechat-specific: the auth-failure policy (an expired bot token must stop the
// loop and flag a rebind), login passthrough (startLogin/getLoginStatus), the
// typing indicator, and the cursor/needsRelogin status fields.
export class WeChatRuntimeService extends BaseChannelRuntime {
  constructor({ adapter, outboundQueue, renderer, driver = null, pollIntervalMs = 2500, persist = null, cursor = null }) {
    if (!adapter) {
      throw new Error("adapter is required");
    }
    if (!outboundQueue) {
      throw new Error("outboundQueue is required");
    }
    super({
      channelId: "wechat",
      inboundMode: "poll",
      adapter,
      outboundQueue,
      // The renderer is the wechat semantic-reply renderer (A9). Callers (and
      // every test via createWeChatRenderer()) supply it; we default to a fresh
      // one so the not-yet-migrated state.js construction keeps working. The
      // runtime always has a working renderer either way.
      // Intentional fallback: state.js injects a renderer explicitly; the default (createWeChatRenderer) covers constructions that omit one (e.g. tests).
      renderer: renderer ?? createWeChatRenderer(),
      driver,
      persist,
      pollIntervalMs,
      dedupMax: 1000,
    });
    // Restored from disk so a restart does not re-fetch already-seen messages.
    this.cursor = cursor;
    this.needsRelogin = false;
  }

  configureDriver(driver) {
    super.configureDriver(driver);
    this.lastError = null;
    this.needsRelogin = false;
  }

  getStatus() {
    const base = super.getStatus();
    return {
      ...base,
      cursor: this.cursor,
      pollIntervalMs: this.pollIntervalMs,
      needsRelogin: this.needsRelogin,
    };
  }

  // An expired bot token would otherwise fail silently forever — stop the poll
  // loop and flag that the user must rebind WeChat. (Verbatim policy from the
  // pre-base runtime.)
  _handleFetchError(error) {
    if (isWeChatAuthError(error)) {
      this.needsRelogin = true;
      this.lastError = "微信登录已失效，请在设置里重新绑定微信。";
      this.stop();
    }
  }

  async startLogin() {
    if (!this.driver?.startLogin) {
      throw new Error("WeChat login is not configured");
    }
    return this.driver.startLogin();
  }

  async getLoginStatus({ loginId }) {
    if (!this.driver?.getLoginStatus) {
      throw new Error("WeChat login is not configured");
    }
    return this.driver.getLoginStatus({ loginId });
  }

  // Best-effort "Codex is typing" indicator while a turn is being processed.
  async sendTyping({ conversationId }) {
    if (!this.driver?.sendTyping || !conversationId) {
      return;
    }
    try {
      await this.driver.sendTyping({ conversationId });
    } catch {
      // A failed typing indicator must never disrupt the runtime.
    }
  }
}

function isWeChatAuthError(error) {
  const message = error?.message ?? String(error);
  return /\b40[13]\b/.test(message) || /unauthorized|invalid.?token|登录/i.test(message);
}
