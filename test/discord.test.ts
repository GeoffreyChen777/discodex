import { describe, expect, it } from "vitest";

import { extractBotText, parseBotMessage, redactSecrets, splitDiscordMessage } from "../src/discord.js";

describe("discord helpers", () => {
  it("extracts text after bot mention", () => {
    expect(extractBotText("<@123> hello", "123")).toBe("hello");
    expect(extractBotText("<@!123> hello <@123>", "123")).toBe("hello");
    expect(extractBotText("hello", "123")).toBeNull();
  });

  it("parses controls", () => {
    expect(parseBotMessage("reset")).toEqual({ kind: "command", command: "reset" });
    expect(parseBotMessage("/cancel")).toEqual({ kind: "command", command: "cancel" });
    expect(parseBotMessage("status")).toEqual({ kind: "command", command: "status" });
    expect(parseBotMessage("workspace")).toEqual({ kind: "command", command: "workspace" });
    expect(parseBotMessage("/reset-workspace")).toEqual({ kind: "command", command: "reset-workspace" });
    expect(parseBotMessage("fix this")).toEqual({ kind: "prompt", prompt: "fix this" });
  });

  it("splits long output", () => {
    const chunks = splitDiscordMessage("a".repeat(4500), 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
  });

  it("redacts common token shapes", () => {
    expect(redactSecrets("token sk-abcdefghijklmnopqrstuvwxyz123456")).toContain("[redacted-openai-key]");
  });
});
