import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const defaultExecFileAsync = promisify(execFile);

export class CodexCliConnector {
  constructor({ execFileAsync = defaultExecFileAsync } = {}) {
    this.execFileAsync = execFileAsync;
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
    const { stdout, stderr } = await this.execFileAsync("codex", args, {
      maxBuffer: 1024 * 1024 * 8,
    });
    return {
      id: `cli_${randomUUID()}`,
      cwd,
      text,
      output: (stdout || stderr || "").trim(),
    };
  }
}
