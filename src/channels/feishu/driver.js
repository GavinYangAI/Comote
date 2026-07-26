export class FeishuDriver {
  constructor({
    appId,
    appSecret,
    verificationToken = null,
    encryptKey = null,
    domain = "feishu",
    baseUrl = "https://open.feishu.cn/open-apis",
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!appId) {
      throw new Error("Feishu appId is required");
    }
    if (!appSecret) {
      throw new Error("Feishu appSecret is required");
    }
    if (!fetchImpl) {
      throw new Error("fetch implementation is required");
    }
    this.appId = appId;
    this.appSecret = appSecret;
    this.verificationToken = verificationToken;
    this.encryptKey = encryptKey;
    this.domain = domain;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.tenantAccessToken = null;
    this.tenantAccessTokenExpiry = 0;
    this._tokenPromise = null;
    this.userNameCache = new Map();
    this.wsClient = null;
  }

  getStatus() {
    return {
      state: "configured",
      runtime: "comote-native",
      driver: "feishu-openapi",
      appId: this.appId,
      domain: this.domain,
      websocket: Boolean(this.wsClient),
    };
  }

  verifyEvent(payload) {
    if (!this.verificationToken) {
      return true;
    }
    return payload?.token === this.verificationToken || payload?.header?.token === this.verificationToken;
  }

  async sendText({ receiveId, receiveIdType = "chat_id", text }) {
    if (!receiveId) {
      throw new Error("receiveId is required");
    }
    if (!text) {
      throw new Error("text is required");
    }
    const token = await this.getTenantAccessToken();
    const response = await this.fetch(
      `${this.baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Feishu send failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    this._assertApiSuccess(body);
    return body;
  }

  async sendCard({ receiveId, receiveIdType = "chat_id", card }) {
    if (!receiveId) {
      throw new Error("receiveId is required");
    }
    if (!card) {
      throw new Error("card is required");
    }
    const token = await this.getTenantAccessToken();
    const response = await this.fetch(
      `${this.baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Feishu card send failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    this._assertApiSuccess(body);
    return { messageId: body.data?.message_id ?? null, raw: body };
  }

  async updateCard({ messageId, card }) {
    if (!messageId) {
      throw new Error("messageId is required");
    }
    if (!card) {
      throw new Error("card is required");
    }
    const token = await this.getTenantAccessToken();
    const response = await this.fetch(
      `${this.baseUrl}/im/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: JSON.stringify(card) }),
      },
    );
    if (!response.ok) {
      throw new Error(`Feishu card update failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    this._assertApiSuccess(body);
    return body;
  }

  async addMessageReaction({ messageId, emojiType = "EYES" }) {
    if (!messageId) throw new Error("messageId is required");
    const token = await this.getTenantAccessToken();
    const response = await this.fetch(
      `${this.baseUrl}/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      },
    );
    if (!response.ok) {
      throw new Error(`Feishu reaction add failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    this._assertApiSuccess(body);
    return { reactionId: body.data?.reaction_id ?? null, raw: body };
  }

  async removeMessageReaction({ messageId, reactionId }) {
    if (!messageId) throw new Error("messageId is required");
    if (!reactionId) return false;
    const token = await this.getTenantAccessToken();
    const response = await this.fetch(
      `${this.baseUrl}/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok) {
      throw new Error(`Feishu reaction remove failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    this._assertApiSuccess(body);
    return true;
  }

  async uploadImage(localPath) {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const token = await this.getTenantAccessToken();
    const bytes = await readFile(localPath);
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new Blob([bytes]), basename(localPath));
    const response = await this.fetch(`${this.baseUrl}/im/v1/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Feishu image upload failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    this._assertApiSuccess(body);
    return body.data?.image_key ?? null;
  }

  async uploadFile(localPath, fileName) {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const token = await this.getTenantAccessToken();
    const bytes = await readFile(localPath);
    const name = fileName ?? basename(localPath);
    const form = new FormData();
    form.append("file_type", "stream");
    form.append("file_name", name);
    form.append("file", new Blob([bytes]), name);
    const response = await this.fetch(`${this.baseUrl}/im/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Feishu file upload failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    this._assertApiSuccess(body);
    return body.data?.file_key ?? null;
  }

  async sendImage({ receiveId, receiveIdType = "chat_id", imageKey }) {
    if (!receiveId) {
      throw new Error("receiveId is required");
    }
    if (!imageKey) {
      throw new Error("imageKey is required");
    }
    return this._sendMessage({
      receiveId,
      receiveIdType,
      msgType: "image",
      content: { image_key: imageKey },
    });
  }

  async sendFile({ receiveId, receiveIdType = "chat_id", fileKey }) {
    if (!receiveId) {
      throw new Error("receiveId is required");
    }
    if (!fileKey) {
      throw new Error("fileKey is required");
    }
    return this._sendMessage({
      receiveId,
      receiveIdType,
      msgType: "file",
      content: { file_key: fileKey },
    });
  }

  async _sendMessage({ receiveId, receiveIdType, msgType, content }) {
    const token = await this.getTenantAccessToken();
    const response = await this.fetch(
      `${this.baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: msgType,
          content: JSON.stringify(content),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Feishu ${msgType} send failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    this._assertApiSuccess(body);
    return { messageId: body.data?.message_id ?? null, raw: body };
  }

  async downloadMessageResource({ messageId, fileKey, type = "file", destPath }) {
    if (!messageId) {
      throw new Error("messageId is required");
    }
    if (!fileKey) {
      throw new Error("fileKey is required");
    }
    if (!destPath) {
      throw new Error("destPath is required");
    }
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const token = await this.getTenantAccessToken();
    const response = await this.fetch(
      `${this.baseUrl}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(type)}`,
      { method: "GET", headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new Error(`Feishu resource download failed: ${response.status} ${await response.text()}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, bytes);
    return destPath;
  }

  async getTenantAccessToken() {
    if (this.tenantAccessToken && Date.now() < this.tenantAccessTokenExpiry) {
      return this.tenantAccessToken;
    }
    if (this._tokenPromise) {
      return this._tokenPromise;
    }
    this._tokenPromise = (async () => {
      const response = await this.fetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      });
      if (!response.ok) {
        throw new Error(`Feishu token failed: ${response.status} ${await response.text()}`);
      }
      const body = await response.json();
      this.tenantAccessToken = body.tenant_access_token;
      // expire field is seconds; use a 60s safety margin. Default to 110 minutes.
      const expireSeconds = typeof body.expire === "number" ? body.expire : 6600;
      this.tenantAccessTokenExpiry = Date.now() + (expireSeconds - 60) * 1000;
      return this.tenantAccessToken;
    })();
    try {
      return await this._tokenPromise;
    } finally {
      this._tokenPromise = null;
    }
  }

  // Checks the parsed Feishu API response body for a nonzero code field.
  // If found, clears the cached token (to force re-auth on next call) and
  // throws an Error that includes the code and message.
  _assertApiSuccess(body) {
    if (body && typeof body.code === "number" && body.code !== 0) {
      this.tenantAccessToken = null;
      this.tenantAccessTokenExpiry = 0;
      throw new Error(`Feishu API error: code=${body.code} msg=${body.msg ?? "(no message)"}`);
    }
  }

  async resolveUserName(openId) {
    if (!openId) {
      return null;
    }
    if (this.userNameCache.has(openId)) {
      return this.userNameCache.get(openId);
    }
    // Best effort: needs the `contact:user.base:readonly` scope. On any failure
    // (missing permission, network error, non-zero code) cache and return null
    // so the caller falls back to showing the open_id.
    let name = null;
    try {
      const token = await this.getTenantAccessToken();
      const response = await this.fetch(
        `${this.baseUrl}/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
        { method: "GET", headers: { authorization: `Bearer ${token}` } },
      );
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.code === 0) {
        name = body.data?.user?.name ?? null;
      }
    } catch {
      name = null;
    }
    this.userNameCache.set(openId, name);
    return name;
  }

  async startLogin({ domain = this.domain } = {}) {
    await initAppRegistration({ domain, fetchImpl: this.fetch });
    const started = await beginAppRegistration({ domain, fetchImpl: this.fetch });
    return started;
  }

  async getLoginStatus({ loginId, domain = this.domain, interval = 5, expireIn = 600 }) {
    if (!loginId) {
      throw new Error("loginId is required");
    }
    const result = await pollAppRegistration({
      deviceCode: loginId,
      interval,
      expireIn,
      domain,
      fetchImpl: this.fetch,
      singlePoll: true,
    });
    if (result.status !== "success") {
      return { state: result.status, raw: result };
    }
    return {
      state: "confirmed",
      appId: result.result.appId,
      appSecret: result.result.appSecret,
      domain: result.result.domain,
      userId: result.result.openId,
      raw: result,
    };
  }

  async startEventStream({ onEvent, onAction = null, onError = null }) {
    const Lark = await import("@larksuiteoapi/node-sdk");
    const dispatcher = new Lark.EventDispatcher({
      encryptKey: this.encryptKey ?? "",
      verificationToken: this.verificationToken ?? "",
    });
    dispatcher.register(buildEventHandlers({ onEvent, onAction }));
    if (this.wsClient) {
      this.stopEventStream();
    }
    // Diagnostic switch: set COMOTE_FEISHU_WS_DEBUG=1 to raise the Lark SDK to
    // debug logging. On a card-button click this reveals whether a frame even
    // arrives and its message_type — the decisive evidence for why Feishu
    // approval buttons may not reach Comote:
    //   - "receive message, message_type: event ... no card.action.trigger handle"
    //       → frame arrives as an event but the type key doesn't match (SDK/parse).
    //   - "receive message, message_type: card"
    //       → card-type frame the WSClient drops (old-style card callback).
    //   - no frame logged on click
    //       → the app isn't delivering card callbacks over the long connection
    //         (Events & Callbacks subscription / delivery-mode not configured).
    const wsDebug = Boolean(process.env.COMOTE_FEISHU_WS_DEBUG);
    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.sdkDomain(Lark),
      loggerLevel: wsDebug ? Lark.LoggerLevel.debug : Lark.LoggerLevel.info,
    });
    Promise.resolve(this.wsClient.start({ eventDispatcher: dispatcher })).catch((error) => {
      onError?.(error);
    });
    return { ok: true };
  }

  stopEventStream() {
    if (!this.wsClient) {
      return;
    }
    this.wsClient.close({ force: true });
    this.wsClient = null;
  }

  sdkDomain(Lark) {
    if (this.domain === "lark") {
      return Lark.Domain.Lark;
    }
    if (this.domain === "feishu") {
      return Lark.Domain.Feishu;
    }
    return this.domain.replace(/\/+$/, "");
  }
}

// Builds the handler table for the Lark EventDispatcher. Pure + exported so
// the wiring is unit-testable without spinning up a real WebSocket client.
export function buildEventHandlers({ onEvent, onAction = null }) {
  return {
    "im.message.receive_v1": async (data) => onEvent(data),
    "card.action.trigger": async (data) => {
      const result = await onAction?.(data);
      return result ?? {};
    },
  };
}

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const SCAN_TO_CREATE_TP = "ob_cli_app";

async function initAppRegistration({ domain, fetchImpl }) {
  const response = await postRegistration({
    domain,
    fetchImpl,
    body: { action: "init" },
  });
  if (!response.supported_auth_methods?.includes("client_secret")) {
    throw new Error("Feishu QR setup does not support client_secret registration");
  }
}

async function beginAppRegistration({ domain, fetchImpl }) {
  const response = await postRegistration({
    domain,
    fetchImpl,
    body: {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    },
  });
  const qrUrl = new URL(response.verification_uri_complete);
  qrUrl.searchParams.set("from", "comote");
  qrUrl.searchParams.set("tp", SCAN_TO_CREATE_TP);
  return {
    loginId: response.device_code,
    qrUrl: qrUrl.toString(),
    userCode: response.user_code,
    interval: response.interval || 5,
    expireIn: response.expire_in || 600,
    domain,
    raw: response,
  };
}

async function pollAppRegistration({ deviceCode, interval, expireIn, domain, fetchImpl, singlePoll = false }) {
  const deadline = Date.now() + expireIn * 1000;
  let currentInterval = interval;
  let currentDomain = domain;
  while (Date.now() < deadline) {
    const response = await postRegistration({
      domain: currentDomain,
      fetchImpl,
      body: {
        action: "poll",
        device_code: deviceCode,
        tp: SCAN_TO_CREATE_TP,
      },
    }).catch((error) => ({ error: "network_error", error_description: error.message }));

    if (response.user_info?.tenant_brand === "lark" && currentDomain !== "lark") {
      currentDomain = "lark";
      if (!singlePoll) {
        continue;
      }
    }
    if (response.client_id && response.client_secret) {
      return {
        status: "success",
        result: {
          appId: response.client_id,
          appSecret: response.client_secret,
          domain: currentDomain,
          openId: response.user_info?.open_id,
        },
      };
    }
    if (response.error === "authorization_pending") {
      if (singlePoll) {
        return { status: "pending", raw: response };
      }
    } else if (response.error === "slow_down") {
      currentInterval += 5;
      if (singlePoll) {
        return { status: "pending", raw: response };
      }
    } else if (response.error === "access_denied") {
      return { status: "access_denied", raw: response };
    } else if (response.error === "expired_token") {
      return { status: "expired", raw: response };
    } else if (response.error) {
      return { status: "error", message: response.error_description ?? response.error, raw: response };
    }
    if (singlePoll) {
      return { status: "pending", raw: response };
    }
    await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000));
  }
  return { status: "timeout" };
}

async function postRegistration({ domain, fetchImpl, body }) {
  const response = await fetchImpl(`${accountsBaseUrl(domain)}${REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = undefined;
  }
  // Device-flow OAuth errors (authorization_pending, slow_down, access_denied,
  // expired_token) come back as HTTP 400 with a JSON `error` field per RFC 8628.
  // Return them so pollAppRegistration can classify the state; only throw when
  // the response carries no structured error to act on.
  if (parsed && typeof parsed.error === "string") {
    return parsed;
  }
  if (!response.ok) {
    throw new Error(`Feishu registration failed: ${response.status} ${text}`);
  }
  return parsed ?? {};
}

function accountsBaseUrl(domain) {
  return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}
