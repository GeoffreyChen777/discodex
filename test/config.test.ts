import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("loads required config and defaults", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_GUILD_ID: "guild",
    });
    expect(config.codexSandbox).toBe("workspace-write");
    expect(config.codexBaseWorkdir).toBe("/workspace-base");
    expect(config.codexWorkspacesDir).toBe("/workspaces");
    expect(config.codexApprovalsReviewer).toBe("auto_review");
    expect(config.queueLimit).toBe(10);
  });

  it("rejects danger-full-access", () => {
    expect(() =>
      loadConfig({
        DISCORD_TOKEN: "token",
        DISCORD_GUILD_ID: "guild",
        CODEX_SANDBOX: "danger-full-access",
      }),
    ).toThrow(/CODEX_SANDBOX/);
  });

  it("rejects non-auto approval reviewers", () => {
    expect(() =>
      loadConfig({
        DISCORD_TOKEN: "token",
        DISCORD_GUILD_ID: "guild",
        CODEX_APPROVALS_REVIEWER: "user",
      }),
    ).toThrow(/CODEX_APPROVALS_REVIEWER/);
  });

  it("allows guardian_subagent approval reviewer", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_GUILD_ID: "guild",
      CODEX_APPROVALS_REVIEWER: "guardian_subagent",
    });

    expect(config.codexApprovalsReviewer).toBe("guardian_subagent");
  });
});
