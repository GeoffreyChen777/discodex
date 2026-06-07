import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import type { AppConfig } from "./config.js";

export type CodexRunInput = {
  prompt: string;
  threadId: string | null;
  workspacePath: string;
  onEvent: (event: CodexDisplayEvent) => Promise<void> | void;
};

export type ActiveCodexRun = {
  cancel: () => void;
  done: Promise<CodexRunResult>;
};

export type CodexRunResult = {
  threadId: string | null;
};

export type CodexDisplayEvent =
  | { type: "thread"; threadId: string }
  | { type: "progress"; text: string }
  | { type: "agent_message"; text: string }
  | { type: "error"; text: string }
  | { type: "completed"; text: string };

export type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string; code?: number } | string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    status?: string;
    exit_code?: number;
    name?: string;
  };
  [key: string]: unknown;
};

export class CodexRunner {
  constructor(private readonly config: AppConfig) {}

  start(input: CodexRunInput): ActiveCodexRun {
    const args = this.buildArgs(input.threadId, input.prompt, input.workspacePath);
    const env = {
      ...process.env,
      ...(this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {}),
      NO_COLOR: "1",
    };
    const child = spawn("codex", args, {
      cwd: input.workspacePath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let threadId = input.threadId;
    let lastAgentMessage = "";
    const timeout = setTimeout(() => {
      input.onEvent({
        type: "error",
        text: `Codex turn timed out after ${Math.round(this.config.turnTimeoutMs / 1000)}s. A command may be waiting for input.`,
      });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref();
    }, this.config.turnTimeoutMs);
    timeout.unref();

    const done = new Promise<CodexRunResult>((resolve, reject) => {
      const stdout = createInterface({ input: child.stdout });
      const stderr = createInterface({ input: child.stderr });

      stdout.on("line", (line) => {
        const parsed = parseCodexJsonLine(line);
        if (!parsed) {
          return;
        }
        const events = displayEventsFromCodex(parsed);
        for (const event of events) {
          if (event.type === "thread") {
            threadId = event.threadId;
          }
          if (event.type === "agent_message") {
            lastAgentMessage = event.text;
          }
          void input.onEvent(event);
        }
      });

      stderr.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed) {
          void input.onEvent({ type: "progress", text: `Codex: ${trimmed}` });
        }
      });

      child.once("error", (error) => {
        clearTimeout(timeout);
        settled = true;
        reject(error);
      });

      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        stdout.close();
        stderr.close();
        if (settled) {
          return;
        }
        settled = true;
        if (code === 0) {
          if (lastAgentMessage) {
            void input.onEvent({ type: "completed", text: "Codex turn completed." });
          }
          resolve({ threadId });
          return;
        }
        reject(new Error(`Codex exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`));
      });
    });

    return {
      cancel: () => terminate(child),
      done,
    };
  }

  buildArgs(threadId: string | null, prompt: string, workspacePath: string): string[] {
    const common = [
      "--json",
      "-c",
      'approval_policy="on-request"',
      "-c",
      `approvals_reviewer="${this.config.codexApprovalsReviewer}"`,
    ];
    if (this.config.codexModel) {
      common.push("--model", this.config.codexModel);
    }
    if (threadId) {
      return ["exec", ...common, "resume", threadId, prompt];
    }
    return [
      "exec",
      ...common,
      "--sandbox",
      this.config.codexSandbox,
      "--cd",
      workspacePath,
      prompt,
    ];
  }
}

export function parseCodexJsonLine(line: string): CodexJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as CodexJsonEvent;
  } catch {
    return null;
  }
}

export function displayEventsFromCodex(event: CodexJsonEvent): CodexDisplayEvent[] {
  const events: CodexDisplayEvent[] = [];
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    events.push({ type: "thread", threadId: event.thread_id });
    events.push({ type: "progress", text: `Codex thread started: ${event.thread_id}` });
  }

  if (event.type === "turn.failed" || event.type === "error") {
    events.push({ type: "error", text: describeError(event) });
  }

  if (event.type === "turn.completed") {
    events.push({ type: "completed", text: "Codex turn completed." });
  }

  if (event.type === "item.started" && event.item?.type === "command_execution") {
    events.push({ type: "progress", text: `Running command: \`${truncate(event.item.command ?? "unknown", 500)}\`` });
  }

  if (event.type === "item.completed" && event.item?.type === "command_execution") {
    const exit = event.item.exit_code === undefined ? "" : ` exit=${event.item.exit_code}`;
    events.push({ type: "progress", text: `Command completed:${exit}` });
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
    events.push({ type: "agent_message", text: event.item.text });
  }

  const serialized = JSON.stringify(event);
  if (/approval|review/i.test(serialized) && /(denied|timeout|timed out|failed|aborted)/i.test(serialized)) {
    events.push({
      type: "error",
      text: `Approval review event: ${truncate(serialized, 1200)}`,
    });
  }

  return events;
}

function describeError(event: CodexJsonEvent): string {
  if (typeof event.error === "string") {
    return event.error;
  }
  if (event.error?.message) {
    return event.error.message;
  }
  if (event.message) {
    return event.message;
  }
  return `Codex reported an error: ${truncate(JSON.stringify(event), 1200)}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function terminate(child: ChildProcess): void {
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 5_000).unref();
}
