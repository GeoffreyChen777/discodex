import type { Message } from "discord.js";

export const DISCORD_MESSAGE_LIMIT = 2000;
const SAFE_CHUNK_LIMIT = 1900;
const TYPING_REFRESH_MS = 8_000;

export type ParsedBotMessage =
  | { kind: "empty" }
  | { kind: "command"; command: "reset" | "cancel" | "status" | "workspace" | "reset-workspace" | "delete-workspace" }
  | { kind: "prompt"; prompt: string };

export function extractBotText(content: string, botUserId: string): string | null {
  const mentionPattern = new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g");
  if (!mentionPattern.test(content)) {
    return null;
  }
  return content.replace(mentionPattern, "").trim();
}

export function parseBotMessage(text: string): ParsedBotMessage {
  const normalized = text.trim();
  if (!normalized) {
    return { kind: "empty" };
  }

  const command = normalized.toLowerCase();
  if (command === "reset" || command === "/reset") {
    return { kind: "command", command: "reset" };
  }
  if (command === "cancel" || command === "/cancel") {
    return { kind: "command", command: "cancel" };
  }
  if (command === "status" || command === "/status") {
    return { kind: "command", command: "status" };
  }
  if (command === "workspace" || command === "/workspace") {
    return { kind: "command", command: "workspace" };
  }
  if (command === "reset-workspace" || command === "/reset-workspace") {
    return { kind: "command", command: "reset-workspace" };
  }
  if (command === "delete-workspace" || command === "/delete-workspace") {
    return { kind: "command", command: "delete-workspace" };
  }

  return { kind: "prompt", prompt: normalized };
}

export function buildCodexPrompt(message: Message, prompt: string): string {
  const authorName = message.author.globalName ?? message.author.username;
  return [
    "Discord request context:",
    `- Author: ${authorName} (${message.author.id})`,
    `- Guild: ${message.guildId ?? "unknown"}`,
    `- Channel: ${message.channelId}`,
    `- Message: ${message.url}`,
    "",
    "User request:",
    prompt,
  ].join("\n");
}

export function splitDiscordMessage(input: string, limit = SAFE_CHUNK_LIMIT): string[] {
  const text = input.trim();
  if (!text) {
    return [];
  }
  if (limit <= 0 || limit > DISCORD_MESSAGE_LIMIT) {
    throw new Error("limit must be between 1 and Discord's message limit");
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const newlineIndex = remaining.lastIndexOf("\n", limit);
    const spaceIndex = remaining.lastIndexOf(" ", limit);
    const splitAt = Math.max(newlineIndex, spaceIndex, Math.floor(limit * 0.6));
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted-openai-key]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[redacted-slack-token]")
    .replace(/\b([A-Za-z0-9_]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})\b/g, "[redacted-token]");
}

export async function replySafely(message: Message, text: string): Promise<void> {
  const chunks = splitDiscordMessage(redactSecrets(text));
  for (const chunk of chunks) {
    await message.reply({
      content: chunk,
      allowedMentions: { parse: [] },
    });
  }
}

export function startTyping(message: Message): () => void {
  const channel = message.channel as unknown as { sendTyping?: () => Promise<unknown> };
  if (typeof channel.sendTyping !== "function") {
    return () => undefined;
  }

  const send = () => {
    void channel.sendTyping?.().catch(() => {
      // Typing indicators are best-effort; failing to send one should not fail a turn.
    });
  };

  send();
  const interval = setInterval(send, TYPING_REFRESH_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
