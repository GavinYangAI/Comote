import { spawn } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class JsonRpcClient {
  constructor({ transport, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    if (!transport) {
      throw new Error("transport is required");
    }
    this.transport = transport;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequestHandler = null;
    this.notificationHandler = null;
    this.closeHandler = null;
    this.connected = false;
    this.closing = false;
  }

  async connect() {
    if (this.connected) {
      return;
    }
    await this.transport.connect();
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onClose?.(() => this.handleClose());
    this.connected = true;
  }

  async request(method, params) {
    await this.connect();
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      // A request that never gets a response must not hang forever — a dead
      // socket that emits no close event is otherwise undetectable.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Codex app-server 请求超时：${method}`));
        }
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  async respond(id, result) {
    await this.connect();
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  onServerRequest(handler) {
    this.serverRequestHandler = handler;
  }

  onNotification(handler) {
    this.notificationHandler = handler;
  }

  onClose(handler) {
    this.closeHandler = handler;
  }

  #settle(id, apply) {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    apply(pending);
  }

  handleMessage(message) {
    let payload;
    if (typeof message === "string") {
      try {
        payload = JSON.parse(message);
      } catch (err) {
        // A single non-JSON line on the child's stdout must never tear down the
        // read loop or reject pending requests — log and drop it.
        const snippet = message.length > 200 ? `${message.slice(0, 200)}…` : message;
        console.warn(`Codex app-server 收到非 JSON 行，已忽略：${snippet} (${err.message})`);
        return;
      }
    } else {
      payload = message;
    }

    if (Object.hasOwn(payload, "id") && (Object.hasOwn(payload, "result") || Object.hasOwn(payload, "error"))) {
      this.#settle(payload.id, (pending) => {
        if (payload.error) {
          const err = new Error(payload.error.message ?? "Codex app-server request failed");
          // Preserve the JSON-RPC numeric error code so callers can branch on
          // it (e.g. -32601 "Method not found") without string-matching the
          // message. Purely additive — message and behavior are unchanged.
          if (payload.error.code !== undefined) {
            err.code = payload.error.code;
          }
          pending.reject(err);
        } else {
          pending.resolve(payload.result);
        }
      });
      return;
    }

    if (Object.hasOwn(payload, "id") && payload.method) {
      this.serverRequestHandler?.(payload);
      return;
    }

    if (payload.method) {
      this.notificationHandler?.(payload);
    }
  }

  // The transport lost its connection: fail every in-flight request so callers
  // never hang, and notify the owner so it can reconnect.
  handleClose() {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    const error = new Error("Codex app-server 连接已断开");
    for (const id of [...this.pending.keys()]) {
      this.#settle(id, (pending) => pending.reject(error));
    }
    if (!this.closing) {
      this.closeHandler?.();
    }
  }

  async close() {
    this.closing = true;
    await this.transport.close?.();
    this.connected = false;
  }
}

/**
 * Talks JSON-RPC to a `codex app-server` child process over its stdin/stdout.
 * Current Codex (0.131+) speaks newline-delimited JSON on stdio — the old
 * `--listen ws://` WebSocket transport was removed.
 */
export class StdioTransport {
  constructor({ command = "codex", args = ["app-server"] } = {}) {
    this.command = command;
    this.args = args;
    this.child = null;
    this.messageHandler = null;
    this.closeHandler = null;
    this.buffer = "";
  }

  async connect() {
    if (this.child) {
      return;
    }
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "ignore"] });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.feed(chunk));
    const onGone = () => {
      if (this.child === child) {
        this.child = null;
      }
      this.closeHandler?.();
    };
    child.once("exit", onGone);
    child.once("error", onGone);
  }

  // Appends a stdout chunk to the buffer and dispatches every complete,
  // newline-terminated line. A trailing partial line stays buffered until its
  // newline arrives, so messages split across chunk boundaries are reassembled
  // intact and multiple messages in one chunk are dispatched in order. Blank
  // and whitespace-only lines are skipped.
  feed(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.messageHandler?.(line);
      }
    }
  }

  send(message) {
    if (!this.child) {
      throw new Error("codex app-server 进程未连接");
    }
    this.child.stdin.write(`${message}\n`);
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  onClose(handler) {
    this.closeHandler = handler;
  }

  async close() {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}
