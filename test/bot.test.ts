import { describe, expect, it, vi } from "vitest";
import type { Message } from "discord.js";

import { BotController } from "../src/bot.js";
import type { AppConfig } from "../src/config.js";
import type { CodexRunInput, CodexRunResult } from "../src/codex.js";

const config: AppConfig = {
  discordToken: "token",
  discordGuildId: "guild",
  allowedChannelIds: null,
  discordHistoryLimit: 0,
  discordHistoryMaxChars: 8000,
  codexBaseWorkdir: "/workspace-base",
  codexWorkspacesDir: "/workspaces",
  codexSandbox: "workspace-write",
  codexApprovalsReviewer: "auto_review",
  stateDbPath: ":memory:",
  queueLimit: 2,
  turnTimeoutMs: 1000,
};

class FakeState {
  readonly sessions = new Map<string, { threadId: string | null; workspacePath: string | null; branchName: string | null }>();

  getChannelSession(channelId: string) {
    const row = this.sessions.get(channelId);
    return row ? { channelId, ...row, updatedAt: new Date().toISOString() } : null;
  }

  saveChannelSession(channelId: string, threadId: string) {
    const row = this.sessions.get(channelId) ?? { threadId: null, workspacePath: null, branchName: null };
    this.sessions.set(channelId, { ...row, threadId });
  }

  saveChannelWorkspace(channelId: string, workspacePath: string, branchName: string) {
    const row = this.sessions.get(channelId) ?? { threadId: null, workspacePath: null, branchName: null };
    this.sessions.set(channelId, { ...row, workspacePath, branchName });
  }

  clearChannelThread(channelId: string) {
    const row = this.sessions.get(channelId) ?? { threadId: null, workspacePath: null, branchName: null };
    this.sessions.set(channelId, { ...row, threadId: null });
  }

  deleteChannelSession(channelId: string) {
    this.sessions.delete(channelId);
  }
}

class FakeCodex {
  readonly starts: CodexRunInput[] = [];
  readonly cancels: ReturnType<typeof vi.fn>[] = [];
  private readonly resolvers: Array<(result: CodexRunResult) => void> = [];

  start(input: CodexRunInput) {
    this.starts.push(input);
    const cancel = vi.fn();
    this.cancels.push(cancel);
    const done = new Promise<CodexRunResult>((resolve) => {
      this.resolvers.push(resolve);
    });
    return { cancel, done };
  }

  finish(index: number, result: CodexRunResult = { threadId: `thread-${index}` }) {
    this.resolvers[index]?.(result);
  }
}

class FakeWorkspaces {
  deleteCalls = 0;

  async ensureChannelWorkspace(channelId: string) {
    return {
      channelId,
      workspacePath: `/workspaces/channel-${channelId}`,
      branchName: `discodex/channel-${channelId}`,
    };
  }

  getChannelWorkspace(channelId: string) {
    return {
      channelId,
      workspacePath: `/workspaces/channel-${channelId}`,
      branchName: `discodex/channel-${channelId}`,
    };
  }

  async deleteChannelWorkspace(_channelId: string) {
    this.deleteCalls += 1;
  }
}

describe("BotController", () => {
  it("queues per channel and starts the next turn after completion", async () => {
    const state = new FakeState();
    const codex = new FakeCodex();
    const workspaces = new FakeWorkspaces();
    const controller = new BotController(config, state as never, codex as never, workspaces as never);
    const message = fakeMessage();

    await controller.enqueue(message, "first");
    await controller.enqueue(message, "second");
    await flushMicrotasks();

    expect(codex.starts).toHaveLength(1);
    expect(controller.getChannelStatus("channel")).toEqual({ running: true, queued: 1 });
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.channel.sendTyping).toHaveBeenCalled();

    codex.finish(0, { threadId: "thread-a" });
    await flushMicrotasks();

    expect(state.sessions.get("channel")?.threadId).toBe("thread-a");
    expect(codex.starts).toHaveLength(2);
    expect(codex.starts[1]?.threadId).toBe("thread-a");
    expect(codex.starts[1]?.workspacePath).toBe("/workspaces/channel-channel");

    codex.finish(1, { threadId: "thread-a" });
    await flushMicrotasks();
  });

  it("rejects jobs over the queue limit", async () => {
    const state = new FakeState();
    const codex = new FakeCodex();
    const workspaces = new FakeWorkspaces();
    const controller = new BotController(config, state as never, codex as never, workspaces as never);
    const message = fakeMessage();

    await controller.enqueue(message, "first");
    await controller.enqueue(message, "second");
    await controller.enqueue(message, "third");
    await controller.enqueue(message, "fourth");
    await flushMicrotasks();

    expect(codex.starts).toHaveLength(1);
    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Queue is full") }));
  });

  it("does not forward progress events to Discord", async () => {
    const state = new FakeState();
    const codex = new FakeCodex();
    const workspaces = new FakeWorkspaces();
    const controller = new BotController(config, state as never, codex as never, workspaces as never);
    const message = fakeMessage();

    await controller.enqueue(message, "first");
    await flushMicrotasks();
    await codex.starts[0]?.onEvent({ type: "progress", text: "Running command" });
    await codex.starts[0]?.onEvent({ type: "agent_message", text: "hello" });

    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "hello" }));
  });

  it("adds recent Discord history to the Codex prompt", async () => {
    const state = new FakeState();
    const codex = new FakeCodex();
    const workspaces = new FakeWorkspaces();
    const controller = new BotController(
      { ...config, discordHistoryLimit: 2 },
      state as never,
      codex as never,
      workspaces as never,
    );
    const message = fakeMessage([
      fakeHistoryMessage("older", "Bob", "before that", 1),
      fakeHistoryMessage("newer", "Alice", "please remember this", 2),
    ]);

    await controller.enqueue(message, "use the context");
    await flushMicrotasks();

    expect(message.channel.messages.fetch).toHaveBeenCalledWith({ limit: 2, before: "message" });
    expect(codex.starts[0]?.prompt).toContain("Recent Discord channel history before this request");
    expect(codex.starts[0]?.prompt).toContain("Bob (user-older): before that");
    expect(codex.starts[0]?.prompt).toContain("Alice (user-newer): please remember this");
    expect(codex.starts[0]?.prompt).toContain("Current user request:\nuse the context");
  });

  it("stops typing when a turn finishes", async () => {
    vi.useFakeTimers();
    const state = new FakeState();
    const codex = new FakeCodex();
    const workspaces = new FakeWorkspaces();
    const controller = new BotController(config, state as never, codex as never, workspaces as never);
    const message = fakeMessage();

    await controller.enqueue(message, "first");
    await flushMicrotasks();
    expect(message.channel.sendTyping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(8_000);
    expect(message.channel.sendTyping).toHaveBeenCalledTimes(2);

    codex.finish(0, { threadId: "thread-a" });
    await flushMicrotasks();
    vi.advanceTimersByTime(8_000);

    expect(message.channel.sendTyping).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("cancels and resets channel work", async () => {
    const state = new FakeState();
    state.saveChannelSession("channel", "thread-a");
    const codex = new FakeCodex();
    const workspaces = new FakeWorkspaces();
    const controller = new BotController(config, state as never, codex as never, workspaces as never);
    const message = fakeMessage();

    await controller.enqueue(message, "first");
    await flushMicrotasks();
    await controller.cancel(message);
    expect(codex.cancels[0]).toHaveBeenCalledTimes(1);

    await controller.reset(message);
    expect(codex.cancels[0]).toHaveBeenCalledTimes(2);
    expect(state.sessions.get("channel")?.threadId).toBeNull();
    expect(controller.getChannelStatus("channel")).toEqual({ running: false, queued: 0 });
  });

  it("deletes channel workspace through workspace manager", async () => {
    const state = new FakeState();
    const codex = new FakeCodex();
    const workspaces = new FakeWorkspaces();
    const controller = new BotController(config, state as never, codex as never, workspaces as never);

    await controller.deleteWorkspace(fakeMessage());

    expect(workspaces.deleteCalls).toBe(1);
  });
});

function fakeMessage(history: Message[] = []) {
  return {
    id: "message",
    channelId: "channel",
    guildId: "guild",
    url: "https://discord.com/channels/guild/channel/message",
    author: {
      id: "user",
      username: "alice",
      globalName: "Alice",
    },
    channel: {
      sendTyping: vi.fn(async () => undefined),
      messages: {
        fetch: vi.fn(async () => new Map(history.map((message) => [message.id, message]))),
      },
    },
    reply: vi.fn(async () => undefined),
  } as unknown as Message & {
    channel: {
      sendTyping: ReturnType<typeof vi.fn>;
      messages: { fetch: ReturnType<typeof vi.fn> };
    };
    reply: ReturnType<typeof vi.fn>;
  };
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

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}
