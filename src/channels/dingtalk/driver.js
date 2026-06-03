// DingTalk (enterprise internal app) driver. Mirrors the FeishuDriver method
// surface (getStatus / sendText / card create+update / media / downloadMessageResource
// / startEventStream+stopEventStream) but talks to DingTalk OpenAPI + the official
// dingtalk-stream WebSocket SDK. OpenAPI calls go through an injected fetchImpl so
// they are unit-testable; the Stream client is late-imported so tests never touch it.

const API_BASE = "https://api.dingtalk.com";
const OAPI_BASE = "https://oapi.dingtalk.com";

export class DingTalkDriver {
  constructor({ appKey, appSecret, fetchImpl = globalThis.fetch } = {}) {
    if (!appKey) throw new Error("DingTalk appKey is required");
    if (!appSecret) throw new Error("DingTalk appSecret is required");
    if (!fetchImpl) throw new Error("fetch implementation is required");
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.robotCode = appKey; // internal app: robotCode == AppKey
    this.fetch = fetchImpl;
    this.accessToken = null;
    this.accessTokenExpiry = 0;
    this._tokenPromise = null;
    this.client = null; // dingtalk-stream DWClient
  }

  getStatus() {
    return {
      state: "configured",
      runtime: "comote-native",
      driver: "dingtalk-stream",
      appKey: this.appKey,
      websocket: Boolean(this.client),
    };
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiry) return this.accessToken;
    if (this._tokenPromise) return this._tokenPromise;
    this._tokenPromise = (async () => {
      const res = await this.fetch(`${API_BASE}/v1.0/oauth2/accessToken`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: this.appKey, appSecret: this.appSecret }),
      });
      if (!res.ok) throw new Error(`DingTalk token failed: ${res.status} ${await res.text()}`);
      const body = await res.json();
      this.accessToken = body.accessToken;
      const ttl = typeof body.expireIn === "number" ? body.expireIn : 7200;
      this.accessTokenExpiry = Date.now() + (ttl - 120) * 1000; // 120s safety margin
      return this.accessToken;
    })();
    try {
      return await this._tokenPromise;
    } finally {
      this._tokenPromise = null;
    }
  }

  async _apiPost(path, body) {
    const token = await this.getAccessToken();
    const res = await this.fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // a non-2xx may be an expired token; clear so the next call re-auths.
      this.accessToken = null;
      this.accessTokenExpiry = 0;
      throw new Error(`DingTalk ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async _robotSend({ receiveId, msgKey, msgParam }) {
    return this._apiPost("/v1.0/robot/oToMessages/batchSend", {
      robotCode: this.robotCode,
      userIds: [receiveId],
      msgKey,
      msgParam: JSON.stringify(msgParam),
    });
  }

  async sendText({ receiveId, text }) {
    if (!receiveId) throw new Error("receiveId is required");
    if (!text) throw new Error("text is required");
    return this._robotSend({ receiveId, msgKey: "sampleText", msgParam: { content: text } });
  }

  async sendMarkdown({ receiveId, title, text }) {
    if (!receiveId) throw new Error("receiveId is required");
    return this._robotSend({ receiveId, msgKey: "sampleMarkdown", msgParam: { title: title ?? "Codex", text: text ?? "" } });
  }

  // Create + deliver an interactive card instance to a 1:1 robot space.
  async createCard({ cardTemplateId, outTrackId, receiveId, cardParamMap }) {
    if (!cardTemplateId) throw new Error("cardTemplateId is required");
    if (!outTrackId) throw new Error("outTrackId is required");
    if (!receiveId) throw new Error("receiveId is required");
    const body = await this._apiPost("/v1.0/card/instances/createAndDeliver", {
      cardTemplateId,
      outTrackId,
      callbackType: "STREAM",
      cardData: { cardParamMap: cardParamMap ?? {} },
      openSpaceId: `dtv1.card//IM_ROBOT.${receiveId}`,
      imRobotOpenSpaceModel: { supportForward: true },
      imRobotOpenDeliverModel: { spaceType: "IM_ROBOT" },
    });
    return { outTrackId: body?.result?.outTrackId ?? outTrackId, raw: body };
  }

  // Update a delivered card in place (partial update by key).
  async updateCard({ outTrackId, cardParamMap }) {
    if (!outTrackId) throw new Error("outTrackId is required");
    const token = await this.getAccessToken();
    const res = await this.fetch(`${API_BASE}/v1.0/card/instances`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify({
        outTrackId,
        cardData: { cardParamMap: cardParamMap ?? {} },
        cardUpdateOptions: { updateCardDataByKey: true },
      }),
    });
    if (!res.ok) {
      this.accessToken = null;
      this.accessTokenExpiry = 0;
      throw new Error(`DingTalk card update failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async uploadMedia(localPath, type) {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const token = await this.getAccessToken();
    const bytes = await readFile(localPath);
    const form = new FormData();
    form.append("media", new Blob([bytes]), basename(localPath));
    const res = await this.fetch(`${OAPI_BASE}/media/upload?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`DingTalk media upload failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    if (body.errcode && body.errcode !== 0) throw new Error(`DingTalk media upload error: ${body.errcode} ${body.errmsg}`);
    return body.media_id;
  }

  async sendImage({ receiveId, mediaId }) {
    if (!mediaId) throw new Error("mediaId is required");
    return this._robotSend({ receiveId, msgKey: "sampleImageMsg", msgParam: { photoURL: mediaId } });
  }

  async sendFile({ receiveId, mediaId, fileName, fileType }) {
    if (!mediaId) throw new Error("mediaId is required");
    return this._robotSend({
      receiveId,
      msgKey: "sampleFile",
      msgParam: { mediaId, fileName: fileName ?? "file", fileType: fileType ?? "bin" },
    });
  }

  // Resolve a downloadCode (from an inbound file/image message) to a temp URL and
  // stream the bytes to destPath.
  async downloadMessageResource({ downloadCode, destPath }) {
    if (!downloadCode) throw new Error("downloadCode is required");
    if (!destPath) throw new Error("destPath is required");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const meta = await this._apiPost("/v1.0/robot/messageFiles/download", {
      downloadCode,
      robotCode: this.robotCode,
    });
    const url = meta?.downloadUrl;
    if (!url) throw new Error("DingTalk download: no downloadUrl in response");
    const res = await this.fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`DingTalk file download failed: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, bytes);
    return destPath;
  }

  // Open the Stream connection. onEvent ← bot IM messages; onAction ← card button
  // callbacks (return value is sent back as the card-update ACK); onError ← fatal.
  async startEventStream({ onEvent, onAction = null, onError = null }) {
    const mod = await import("dingtalk-stream");
    const { DWClient, TOPIC_ROBOT, TOPIC_CARD, EventAck } = mod;
    if (this.client) this.stopEventStream();
    const client = new DWClient({ clientId: this.appKey, clientSecret: this.appSecret });
    this.client = client;
    const ack = (messageId, payload) => client.socketCallBackResponse(messageId, payload);
    const handlers = buildStreamHandlers({ onEvent, onAction, ack, EventAck });
    client
      .registerCallbackListener(TOPIC_ROBOT, (event) => handlers.robot(event))
      .registerCallbackListener(TOPIC_CARD, (event) => handlers.card(event));
    Promise.resolve(client.connect()).catch((error) => onError?.(error));
    return { ok: true };
  }

  stopEventStream() {
    if (!this.client) return;
    try {
      this.client.disconnect();
    } catch {
      // best effort
    }
    this.client = null;
  }
}

// Pure wiring for the two Stream topics — exported so the routing + ACK contract
// is unit-testable without a live socket. `ack(messageId, payload)` performs the
// socketCallBackResponse; robot messages ACK EventAck.SUCCESS, card callbacks ACK
// whatever onAction returns (the in-frame card update), defaulting to SUCCESS.
export function buildStreamHandlers({ onEvent, onAction, ack, EventAck }) {
  return {
    async robot(event) {
      const payload = JSON.parse(event.data);
      try {
        await onEvent(payload);
      } finally {
        ack(event.headers.messageId, EventAck.SUCCESS);
      }
    },
    async card(event) {
      const payload = JSON.parse(event.data);
      let response = EventAck.SUCCESS;
      try {
        const result = await onAction?.(payload);
        if (result) response = result;
      } finally {
        ack(event.headers.messageId, response);
      }
    },
  };
}
