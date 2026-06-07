import type { Message } from "discord.js";

export const DISCORD_MESSAGE_LIMIT = 2000;
const SAFE_CHUNK_LIMIT = 1900;
const TYPING_REFRESH_MS = 8_000;
const DISCORD_HISTORY_FETCH_LIMIT = 100;

export type ParsedBotMessage =
  | { kind: "empty" }
  | { kind: "command"; command: "reset" | "cancel" | "status" | "workspace" | "reset-workspace" | "delete-workspace" }
  | { kind: "prompt"; prompt: string };

export type DiscordHistoryEntry = {
  authorName: string;
  authorId: string;
  content: string;
  createdAt: string;
  isBot: boolean;
};

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

export function buildCodexPrompt(message: Message, prompt: string, history: DiscordHistoryEntry[] = []): string {
  const authorName = message.author.globalName ?? message.author.username;
  const parts = [
    "Discord request context:",
    `- Author: ${authorName} (${message.author.id})`,
    `- Guild: ${message.guildId ?? "unknown"}`,
    `- Channel: ${message.channelId}`,
    `- Message: ${message.url}`,
    "",
  ];

  if (history.length > 0) {
    parts.push(
      "Recent Discord channel history before this request, oldest to newest:",
      ...history.map(formatHistoryEntry),
      "",
    );
  }

  parts.push(
    "Current user request:",
    prompt,
  );

  return parts.join("\n");
}

export async function fetchDiscordHistory(
  message: Message,
  limit: number,
  maxChars: number,
): Promise<DiscordHistoryEntry[]> {
  if (limit <= 0 || maxChars <= 0) {
    return [];
  }

  const channel = message.channel as unknown as {
    messages?: {
      fetch?: (options: { limit: number; before: string }) => Promise<{ values: () => IterableIterator<Message> }>;
    };
  };
  if (typeof channel.messages?.fetch !== "function") {
    return [];
  }

  try {
    const fetched = await channel.messages.fetch({
      limit: Math.min(limit, DISCORD_HISTORY_FETCH_LIMIT),
      before: message.id,
    });
    const entries = Array.from(fetched.values())
      .filter((item) => item.id !== message.id)
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .map(toHistoryEntry)
      .filter((entry): entry is DiscordHistoryEntry => Boolean(entry));

    return trimHistoryToMaxChars(entries, maxChars);
  } catch (error) {
    console.warn(`Failed to fetch Discord history for channel ${message.channelId}:`, error);
    return [];
  }
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

function formatHistoryEntry(entry: DiscordHistoryEntry): string {
  const botLabel = entry.isBot ? " bot" : "";
  return `- [${entry.createdAt}] ${entry.authorName}${botLabel} (${entry.authorId}): ${entry.content}`;
}

function toHistoryEntry(message: Message): DiscordHistoryEntry | null {
  const content = formatMessageContent(message);
  if (!content) {
    return null;
  }
  return {
    authorName: message.author.globalName ?? message.author.username,
    authorId: message.author.id,
    content: redactSecrets(content),
    createdAt: new Date(message.createdTimestamp).toISOString(),
    isBot: message.author.bot,
  };
}

function formatMessageContent(message: Message): string {
  const text = message.content.trim();
  const attachments = Array.from(message.attachments.values()).map((attachment) => {
    const name = attachment.name ?? "attachment";
    return `[attachment: ${name} ${attachment.url}]`;
  });
  return [text, ...attachments].filter(Boolean).join(" ").trim();
}

function trimHistoryToMaxChars(entries: DiscordHistoryEntry[], maxChars: number): DiscordHistoryEntry[] {
  const kept: DiscordHistoryEntry[] = [];
  let used = 0;

  for (const entry of [...entries].reverse()) {
    const lineLength = formatHistoryEntry(entry).length + 1;
    if (kept.length > 0 && used + lineLength > maxChars) {
      break;
    }
    if (lineLength > maxChars) {
      kept.unshift({
        ...entry,
        content: entry.content.slice(0, Math.max(0, maxChars - 80)).trimEnd(),
      });
      break;
    }
    kept.unshift(entry);
    used += lineLength;
  }

  return kept;
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
