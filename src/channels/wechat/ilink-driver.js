import crypto from "node:crypto";

export const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_ILINK_BOT_TYPE = "3";
export const OPENCLAW_WEIXIN_VERSION = "2.4.3";
export const OPENCLAW_ILINK_APP_ID = "bot";

export class WeChatIlinkDriver {
  constructor({
    baseUrl = DEFAULT_WECHAT_BASE_URL,
    token = null,
    accountId = "default",
    botType = DEFAULT_ILINK_BOT_TYPE,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!fetchImpl) {
      throw new Error("fetch implementation is required");
    }
    this.baseUrl = trimTrailingSlash(baseUrl);
    this.token = token;
    this.accountId = accountId;
    this.botType = botType;
    this.fetch = fetchImpl;
  }

  getStatus() {
    return {
      state: "configured",
      runtime: "comote-native",
      driver: "tencent-ilink-json-api",
      baseUrl: this.baseUrl,
      accountId: this.accountId,
      hasToken: Boolean(this.token),
    };
  }

  async getUpdates({ cursor = null } = {}) {
    this.#requireToken();
    const response = await this.#post("ilink/bot/getupdates", {
      get_updates_buf: cursor ?? "",
      base_info: buildBaseInfo(),
    });
    const data = response.data ?? response;
    const updates = data.msgs ?? data.updates ?? data.messages ?? data.messageList ?? [];
    return {
      updates,
      nextCursor: data.get_updates_buf ?? data.nextCursor ?? data.next_cursor ?? data.cursor ?? null,
      raw: response,
    };
  }

  // Base runtime's poll loop calls fetchUpdates(); keep getUpdates() too.
  fetchUpdates(options = {}) {
    return this.getUpdates(options);
  }

  normalizeUpdate(update) {
    const sender = update.sender ?? update.from ?? {};
    const message = update.message ?? update.msg ?? update;
    const peerId =
      update.from_user_id ??
      sender.id ??
      sender.user_id ??
      update.peerId ??
      update.peer_id ??
      update.fromUserId ??
      update.from_user_id;
    if (!peerId) {
      throw new Error("WeChat update requires a sender id");
    }

    const conversationId = directConversationId(peerId, [
      update.conversationId,
      update.conversation_id,
      update.chatId,
      update.chat_id,
    ]);

    const textItem = (update.item_list ?? [])
      .map((item) => item.text_item?.text ?? item.text ?? "")
      .find((text) => text);

    return {
      accountId: update.accountId ?? update.account_id ?? this.accountId,
      peer: {
        id: peerId,
        name:
          sender.name ??
          sender.nickname ??
          update.senderName ??
          update.sender_name ??
          peerId,
      },
      conversation: {
        id: conversationId,
        type: update.conversationType ?? update.conversation_type ?? "direct",
      },
      message: {
        id: update.context_token ?? message.id ?? update.messageId ?? update.message_id ?? update.message_id ?? null,
        text:
          textItem ??
          message.text ??
          message.content ??
          update.text ??
          update.content ??
          "",
        attachments: message.attachments ?? update.attachments ?? [],
      },
    };
  }

  async sendText({ conversationId, accountId = this.accountId, inReplyTo = null, text }) {
    this.#requireToken();
    if (!text) {
      throw new Error("text is required");
    }
    const toUserId = extractDirectConversationUserId(conversationId);
    if (!toUserId) {
      throw new Error("conversationId is required for WeChat delivery");
    }
    // WeChat desktop (PC) collapses a lone "\n" into a space, so multi-line
    // replies (/help, Codex output) render as one blob there while mobile honours
    // it. Normalising to CRLF makes the desktop client break lines too; mobile
    // still renders a single break. Surfaced via #4.
    const body = String(text).replace(/\r?\n/g, "\r\n");
    return this.#post("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: `comote-${crypto.randomUUID()}`,
        context_token: inReplyTo,
        item_list: [{ type: 1, text_item: { text: body } }],
        message_type: 2,
        message_state: 2,
      },
      base_info: buildBaseInfo(),
    });
  }

  async sendTyping({ conversationId, accountId = this.accountId }) {
    this.#requireToken();
    const toUserId = extractDirectConversationUserId(conversationId);
    if (!toUserId) {
      throw new Error("conversationId is required for typing");
    }
    return this.#post("ilink/bot/sendtyping", {
      ilink_user_id: toUserId,
      context_token: conversationId,
      status: 1,
      base_info: buildBaseInfo(),
    });
  }

  async startLogin() {
    const response = await this.#post(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(this.botType)}`, {
      local_token_list: [],
    });
    const loginId = response.qrcode ?? response.loginId ?? response.login_id ?? response.data?.qrcode ?? null;
    const qrUrl =
      response.qrcode_img_content ??
      response.qrUrl ??
      response.qr_url ??
      response.data?.qrcode_img_content ??
      null;
    return {
      loginId,
      qrUrl: qrUrl ?? (loginId ? buildWeChatQrUrl({ loginId, botType: this.botType }) : null),
      raw: response,
    };
  }

  async getLoginStatus({ loginId }) {
    if (!loginId) {
      throw new Error("loginId is required");
    }
    const response = await this.#get(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(loginId)}`);
    return {
      state: response.status ?? response.state ?? response.data?.state ?? "unknown",
      accountId:
        response.ilink_bot_id ??
        response.accountId ??
        response.account_id ??
        response.data?.ilink_bot_id ??
        response.data?.account_id ??
        null,
      token: response.bot_token ?? response.token ?? response.data?.bot_token ?? null,
      baseUrl: response.baseurl ?? response.baseUrl ?? response.data?.baseurl ?? null,
      userId: response.ilink_user_id ?? response.userId ?? response.data?.ilink_user_id ?? null,
      userName:
        response.nickname ??
        response.nick_name ??
        response.user_name ??
        response.user_nickname ??
        response.data?.nickname ??
        response.data?.nick_name ??
        null,
      raw: response,
    };
  }

  #requireToken() {
    if (!this.token) {
      throw new Error("WeChat login is required before polling or sending messages");
    }
  }

  async #get(path) {
    const response = await this.fetch(`${this.baseUrl}/${path}`, {
      method: "GET",
      headers: this.#headers(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WeChat API ${path} failed: ${response.status} ${text}`);
    }
    return response.json();
  }

  async #post(path, body) {
    const response = await this.fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WeChat API ${path} failed: ${response.status} ${text}`);
    }
    return response.json();
  }

  #headers() {
    return {
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      "iLink-App-Id": OPENCLAW_ILINK_APP_ID,
      "iLink-App-ClientVersion": String(buildClientVersion(OPENCLAW_WEIXIN_VERSION)),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }
}

function buildBaseInfo() {
  return {
    channel_version: OPENCLAW_WEIXIN_VERSION,
    bot_agent: "OpenClaw",
  };
}

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function buildWeChatQrUrl({ loginId, botType }) {
  return `https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=${encodeURIComponent(loginId)}&bot_type=${encodeURIComponent(botType)}`;
}

function extractDirectConversationUserId(conversationId) {
  if (!conversationId) {
    return null;
  }
  return conversationId.startsWith("dm_") ? conversationId.slice(3) : conversationId;
}

function directConversationId(peerId, candidates = []) {
  const explicit = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  if (explicit) {
    return explicit;
  }
  return `dm_${peerId}`;
}
