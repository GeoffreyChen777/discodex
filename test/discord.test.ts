import { describe, expect, it } from "vitest";
import type { Message } from "discord.js";

import {
  buildCodexPrompt,
  extractBotText,
  fetchDiscordHistory,
  parseBotMessage,
  redactSecrets,
  splitDiscordMessage,
} from "../src/discord.js";

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

  it("builds prompts with recent channel history", () => {
    const prompt = buildCodexPrompt(fakeMessage(), "answer this", [
      {
        authorId: "user-a",
        authorName: "Alice",
        content: "context line",
        createdAt: "2026-06-07T00:00:00.000Z",
        isBot: false,
      },
    ]);

    expect(prompt).toContain("Recent Discord channel history before this request");
    expect(prompt).toContain("Alice (user-a): context line");
    expect(prompt).toContain("Current user request:\nanswer this");
  });

  it("fetches, sorts, and redacts recent channel history", async () => {
    const message = fakeMessage([
      fakeHistoryMessage("newer", "Bob", "token sk-abcdefghijklmnopqrstuvwxyz123456", 20),
      fakeHistoryMessage("older", "Alice", "first", 10),
    ]);

    const history = await fetchDiscordHistory(message, 10, 8000);

    expect(history.map((entry) => entry.authorName)).toEqual(["Alice", "Bob"]);
    expect(history[1]?.content).toContain("[redacted-openai-key]");
  });
});

function fakeMessage(history: Message[] = []) {
  return {
    id: "message",
    channelId: "channel",
    guildId: "guild",
    url: "https://discord.com/channels/guild/channel/message",
    content: "<@123> hello",
    createdTimestamp: 30,
    attachments: new Map(),
    author: {
      id: "user",
      username: "alice",
      globalName: "Alice",
      bot: false,
    },
    channel: {
      messages: {
        fetch: async () => new Map(history.map((item) => [item.id, item])),
      },
    },
  } as unknown as Message;
}

function fakeHistoryMessage(id: string, name: string, content: string, timestamp: number) {
  return {
    id,
    content,
    createdTimestamp: timestamp,
    attachments: new Map(),
    author: {
      id: `user-${id}`,
      username: name.toLowerCase(),
      globalName: name,
      bot: false,
    },
  } as unknown as Message;
}
