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
    expect(config.discordHistoryLimit).toBe(0);
    expect(config.discordHistoryMaxChars).toBe(8000);
    expect(config.queueLimit).toBe(10);
  });

  it("loads Discord history settings", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_GUILD_ID: "guild",
      DISCORD_HISTORY_LIMIT: "20",
      DISCORD_HISTORY_MAX_CHARS: "12000",
    });

    expect(config.discordHistoryLimit).toBe(20);
    expect(config.discordHistoryMaxChars).toBe(12000);
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
});
