import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { resolveCodexCommand } from "../codex-desktop/index.js";
import { spawnEnvFor } from "../codex-desktop/json-rpc.js";

const defaultExecFileAsync = promisify(execFile);

export class CodexCliConnector {
  // Shares the desktop connector's executable resolution: a GUI-launched app
  // has a minimal PATH, so bare "codex" misses nvm/Homebrew installs.
  constructor({ execFileAsync = defaultExecFileAsync, command = null } = {}) {
    this.execFileAsync = execFileAsync;
    this.command = command ?? resolveCodexCommand();
  }

  getStatus() {
    return {
      name: "Codex CLI",
      role: "fallback",
      state: "available",
    };
  }

  async runPrompt({ cwd, text, images = [] }) {
    const args = ["exec", "--skip-git-repo-check", "-C", cwd];
    if (images.length > 0) {
      // `codex exec --image` accepts a comma-separated list of local paths, so
      // forwarded image attachments reach Codex as real images.
      args.push("--image", images.join(","));
    }
    args.push(text);
    const { stdout, stderr } = await this.execFileAsync(this.command, args, {
      maxBuffer: 1024 * 1024 * 8,
      env: spawnEnvFor(this.command),
    });
    return {
      id: `cli_${randomUUID()}`,
      cwd,
      text,
      output: (stdout || stderr || "").trim(),
    };
  }
}
