import { describe, expect, it } from "vitest";

import { CodexRunner, displayEventsFromCodex, parseCodexJsonLine } from "../src/codex.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  discordToken: "token",
  discordGuildId: "guild",
  allowedChannelIds: null,
  codexBaseWorkdir: "/workspace-base",
  codexWorkspacesDir: "/workspaces",
  codexSandbox: "workspace-write",
  codexApprovalsReviewer: "auto_review",
  stateDbPath: ":memory:",
  queueLimit: 10,
  turnTimeoutMs: 1000,
};

describe("codex helpers", () => {
  it("parses JSONL lines", () => {
    expect(parseCodexJsonLine('{"type":"turn.completed"}')).toEqual({ type: "turn.completed" });
    expect(parseCodexJsonLine("not json")).toBeNull();
  });

  it("maps thread and agent message events", () => {
    expect(displayEventsFromCodex({ type: "thread.started", thread_id: "abc" })).toEqual([{
      type: "thread",
      threadId: "abc",
    }]);
    expect(
      displayEventsFromCodex({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
    ).toContainEqual({ type: "agent_message", text: "done" });
  });

  it("builds new and resume command args with auto-review", () => {
    const runner = new CodexRunner(config);
    expect(runner.buildArgs(null, "hello", "/workspaces/channel-1")).toEqual([
      "exec",
      "--json",
      "-c",
      'approval_policy="on-request"',
      "-c",
      'approvals_reviewer="auto_review"',
      "--sandbox",
      "workspace-write",
      "--cd",
      "/workspaces/channel-1",
      "hello",
    ]);
    expect(runner.buildArgs("thr", "again", "/workspaces/channel-1")).toEqual([
      "exec",
      "--json",
      "-c",
      'approval_policy="on-request"',
      "-c",
      'approvals_reviewer="auto_review"',
      "resume",
      "thr",
      "again",
    ]);
  });

  it("surfaces approval denials", () => {
    const events = displayEventsFromCodex({
      type: "item.completed",
      item: { type: "approval_review", status: "denied" },
    });
    expect(events.some((event) => event.type === "error")).toBe(true);
  });
});
