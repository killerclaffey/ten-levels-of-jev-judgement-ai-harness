/**
 * Agent sessions: drives an agent harness process per lab run.
 *
 * Supports both OpenCode (default on systems where opencode is installed) and pi.
 * Commands go in, events come out. The level's plugin/extension reports every Jev
 * call and hook decision on stderr as `JEV_EVENT {json}` lines, which this module
 * folds into the same SSE event stream the Vue window subscribes to.
 *
 *   start(config)         spawn agent with the level's plugin, tools, cwd, and config
 *   session.prompt(text)  send a prompt, rejected while the agent is streaming
 *   session.abort()       interrupt, resolves once agent is idle again
 *   session.subscribe(fn) every event so far, then live
 *   session.close()       cleanup session resources
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const SESSIONS_DIR = join(APP, ".sessions");
const WORK_DIR = join(APP, ".sandboxes");
const IDLE_KILL_MS = 15 * 60_000;

export const isOpencodeAvailable = () => {
  try {
    execFileSync("which", ["opencode"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export const isPiAvailable = () => {
  try {
    execFileSync("which", ["pi"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export const detectHarness = () => {
  if (process.env.JEV_AGENT_HARNESS === "pi" && isPiAvailable()) return "pi";
  if (process.env.JEV_AGENT_HARNESS === "opencode" && isOpencodeAvailable()) return "opencode";
  if (isOpencodeAvailable()) return "opencode";
  if (isPiAvailable()) return "pi";
  return "opencode";
};

export const agentModel = () => process.env.JEV_AGENT_MODEL || "openrouter/google/gemini-3.8-flash";

const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
const JEV_KEYS = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"];

export function getOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  try {
    const authPath = join(process.env.HOME || "", ".local/share/opencode/auth.json");
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      return auth?.openrouter?.key?.trim() || undefined;
    }
  } catch {}
  return undefined;
}

export function getTypeSafeKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  try {
    const configPath = join(process.env.HOME || "", ".config/opencode/opencode.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      return cfg?.mcp?.jev?.environment?.TYPESAFE_API_KEY?.trim() || undefined;
    }
  } catch {}
  return undefined;
}

export function agentEnv(model, config) {
  const providerKey = `${model.split("/")[0].toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  const extra = (process.env.JEV_AGENT_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const names = new Set([...BASE_ENV, ...JEV_KEYS, providerKey, ...extra]);
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (names.has(name) || name.startsWith("JEV_"))) env[name] = value;
  }
  const typeSafeKey = getTypeSafeKey();
  if (typeSafeKey && !env.TYPESAFE_API_KEY) {
    env.TYPESAFE_API_KEY = typeSafeKey;
  }
  const openrouterKey = getOpenRouterKey();
  if (openrouterKey && !env.OPENROUTER_API_KEY) {
    env.OPENROUTER_API_KEY = openrouterKey;
  }
  const backend = process.env.JEV_BACKEND || (env.TYPESAFE_API_KEY ? "typesafe" : env.OPENROUTER_API_KEY ? "openrouter" : "mock");
  return { ...env, JEV_BACKEND: backend, JEV_LEVEL_CONFIG: JSON.stringify(config ?? {}) };
}

const sessions = new Map();

export function getSession(id) {
  return sessions.get(id);
}

export function start({ level, option, extension, tools, cwd, config }) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const session = new AgentSession({ level, option, extension, tools, cwd, config });
  sessions.set(session.id, session);
  return session;
}

class AgentSession {
  constructor({ level, option, extension, tools, cwd, config }) {
    this.id = randomUUID().slice(0, 8);
    this.level = level;
    this.option = option;
    this.model = agentModel();
    this.config = config ?? {};
    this.events = [];
    this.listeners = new Set();
    this.pending = new Map();
    this.streaming = false;
    this.closed = false;
    this.state = null;
    this.stats = null;
    this.seq = 0;
    this.harness = detectHarness();
    this.cwd = join(WORK_DIR, this.id);
    this.opencodeSessionId = null;
    this.activeProcess = null;

    cpSync(cwd, this.cwd, { recursive: true });
    cwd = this.cwd;

    // A git repo with baseline commit
    try {
      const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
      git("init", "-q");
      git("add", "-A");
      git("-c", "user.name=lab", "-c", "user.email=lab@local", "-c", "commit.gpgsign=false", "commit", "-qm", "sandbox baseline");
    } catch (err) {
      console.error(`sandbox git init failed: ${err?.message ?? err}`);
    }

    if (this.harness === "opencode") {
      this.initOpencodeSession(level, cwd);
    } else {
      this.initPiSession(extension, tools, cwd, config);
    }
  }

  initOpencodeSession(level, cwd) {
    const pluginsDir = join(cwd, ".opencode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });

    // Symlink plugin for this level so relative imports resolve from APP/plugins
    const pluginMap = {
      6: "jev-guard-plugin.ts",
      7: "jev-compact-plugin.ts",
      8: "ask-jev-file-plugin.ts",
      9: "ask-jev-files-plugin.ts",
      10: "ask-jev-plugin.ts",
    };

    if (pluginMap[level]) {
      const src = join(APP, "plugins", pluginMap[level]);
      const dest = join(pluginsDir, pluginMap[level]);
      try { rmSync(dest, { force: true }); } catch {}
      symlinkSync(src, dest);
    }

    this.touch();
    this.push("session", { id: this.id, level: this.level, option: this.option, model: this.model, cwd, harness: "opencode" });
    this.push("state", { model: { id: this.model, provider: "opencode" } });
  }

  initPiSession(extension, tools, cwd, config) {
    const args = [
      "--mode", "rpc", "--offline", "--approve",
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
      "--model", this.model, "--thinking", "low",
      "--session-dir", SESSIONS_DIR,
      "-e", extension,
      "--tools", tools.join(","),
    ];
    this.child = spawn("pi", args, { cwd, env: agentEnv(this.model, config), stdio: ["pipe", "pipe", "pipe"] });
    this.child.on("error", (err) => this.push("error", { message: String(err?.message ?? err) }));
    this.child.on("close", (code) => {
      this.closed = true;
      this.push("closed", { code });
      for (const p of this.pending.values()) p.reject(new Error("pi exited"));
      this.pending.clear();
    });
    this.readLines(this.child.stdout, (line) => this.onStdout(line));
    this.readLines(this.child.stderr, (line) => this.onStderr(line));
    this.touch();

    this.push("session", { id: this.id, level: this.level, option: this.option, model: this.model, cwd, harness: "pi" });
    this.send({ type: "get_state" }).then((r) => {
      this.state = r?.data ?? null;
      this.push("state", { model: r?.data?.model ?? null, sessionFile: r?.data?.sessionFile ?? null });
    }).catch(() => {});
  }

  readLines(stream, onLine) {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (line) onLine(line);
      }
    });
  }

  onStdout(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return this.push("log", { stream: "stdout", text: line }); }
    if (msg.type === "response") {
      const p = msg.id ? this.pending.get(msg.id) : null;
      if (p) { this.pending.delete(msg.id); p.resolve(msg); }
      return;
    }
    if (msg.type === "agent_start") this.streaming = true;
    if (msg.type === "agent_settled" || msg.type === "agent_end") this.streaming = false;
    this.push(msg.type, msg);
    if (msg.type === "turn_end" || msg.type === "agent_end" || msg.type === "compaction_end") this.refreshStats();
  }

  onStderr(line) {
    if (line.startsWith("JEV_EVENT ")) {
      try { return this.push("jev", JSON.parse(line.slice(10))); } catch { /* fall through */ }
    }
    this.push("log", { stream: "stderr", text: line.slice(0, 2000) });
  }

  async refreshStats() {
    if (this.harness === "pi") {
      try {
        const r = await this.send({ type: "get_session_stats" });
        if (r?.success) { this.stats = r.data; this.push("stats", r.data); }
      } catch { /* process gone */ }
    }
  }

  push(event, data) {
    const item = { seq: ++this.seq, event, data, at: Date.now() };
    this.events.push(item);
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
    for (const l of this.listeners) l(item);
    this.touch();
  }

  subscribe(listener) {
    for (const item of this.events) listener(item);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(cmd) {
    if (this.harness !== "pi") return Promise.resolve({ success: true });
    if (this.closed) return Promise.reject(new Error("session closed"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${cmd.type} timed out`)); }
      }, 120_000);
    });
  }

  async prompt(message) {
    if (this.streaming) throw new Error("the agent is still running; Stop it first");
    this.push("prompt", { message });

    if (this.harness === "opencode") {
      return this.promptOpencode(message);
    }

    const r = await this.send({ type: "prompt", message });
    if (!r.success) throw new Error(r.error ?? "prompt rejected");
    return r;
  }

  promptOpencode(message) {
    return new Promise((resolve, reject) => {
      this.streaming = true;
      this.push("agent_start", {});

      const args = ["run", message, "--format", "json", "--dir", this.cwd, "--auto"];
      if (this.opencodeSessionId) {
        args.push("-s", this.opencodeSessionId);
      }

      const proc = spawn("opencode", args, {
        cwd: this.cwd,
        env: agentEnv(this.model, this.config),
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.stdin.end();
      this.activeProcess = proc;

      const toolRows = new Map();

      this.readLines(proc.stdout, (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.push("log", { stream: "stdout", text: line });
          return;
        }

        if (msg.sessionID && !this.opencodeSessionId) {
          this.opencodeSessionId = msg.sessionID;
        }

        if (msg.type === "text" && msg.part?.text) {
          this.push("message_end", {
            message: {
              role: "assistant",
              content: [{ type: "text", text: msg.part.text }],
            },
          });
        } else if (msg.type === "tool_use" && msg.part?.tool) {
          const part = msg.part;
          const status = part.state?.status;
          const callId = part.callID || part.id;
          const isFinished = status === "completed" || status === "error";

          if (!toolRows.has(callId)) {
            toolRows.set(callId, true);
            this.push("tool_execution_start", {
              toolName: part.tool,
              toolCallId: callId,
              args: part.state?.input ?? {},
            });
          }

          if (isFinished) {
            const outText = part.state?.output || part.state?.error || "";
            this.push("tool_execution_end", {
              toolCallId: callId,
              result: { content: [{ type: "text", text: String(outText) }] },
              isError: status === "error",
            });
          }
        } else if (msg.type === "step_finish") {
          const tokens = msg.part?.tokens?.total ?? 0;
          const cost = Number(msg.part?.cost ?? 0);
          this.push("stats", {
            cost,
            contextUsage: {
              tokens,
              percent: Math.min(100, (tokens / 128_000) * 100),
              contextWindow: 128_000,
            },
          });
        }
      });

      this.readLines(proc.stderr, (line) => {
        this.onStderr(line);
      });

      proc.on("error", (err) => {
        this.streaming = false;
        this.activeProcess = null;
        this.push("error", { message: String(err?.message ?? err) });
        this.push("agent_settled", {});
        reject(err);
      });

      proc.on("close", (code) => {
        this.streaming = false;
        this.activeProcess = null;
        this.push("agent_settled", {});
        resolve({ success: code === 0 });
      });
    });
  }

  async abort() {
    this.push("abort", {});
    this.streaming = false;
    if (this.harness === "opencode") {
      if (this.activeProcess) {
        try { this.activeProcess.kill("SIGTERM"); } catch {}
        this.activeProcess = null;
      }
      this.push("agent_settled", {});
      return { success: true };
    }
    const r = await this.send({ type: "abort" });
    return r;
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_KILL_MS);
    this.idleTimer.unref?.();
  }

  close() {
    clearTimeout(this.idleTimer);
    sessions.delete(this.id);
    if (this.closed) return;
    this.closed = true;
    if (this.activeProcess) {
      try { this.activeProcess.kill("SIGTERM"); } catch {}
      this.activeProcess = null;
    }
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch {}
      }, 2000).unref?.();
    }
    setTimeout(() => {
      try { rmSync(this.cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    }, 2000).unref?.();
  }
}
