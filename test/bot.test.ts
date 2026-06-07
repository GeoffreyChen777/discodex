import { describe, expect, it, vi } from "vitest";
import type { Message } from "discord.js";

import { BotController } from "../src/bot.js";
import type { AppConfig } from "../src/config.js";
import type { CodexRunInput, CodexRunResult } from "../src/codex.js";

const config: AppConfig = {
  discordToken: "token",
  discordGuildId: "guild",
  allowedChannelIds: null,
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

    expect(codex.starts).toHaveLength(1);
    expect(controller.getChannelStatus("channel")).toEqual({ running: true, queued: 1 });
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.channel.sendTyping).toHaveBeenCalled();

    codex.finish(0, { threadId: "thread-a" });
    await flushPromises();

    expect(state.sessions.get("channel")?.threadId).toBe("thread-a");
    expect(codex.starts).toHaveLength(2);
    expect(codex.starts[1]?.threadId).toBe("thread-a");
    expect(codex.starts[1]?.workspacePath).toBe("/workspaces/channel-channel");
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
    await codex.starts[0]?.onEvent({ type: "progress", text: "Running command" });
    await codex.starts[0]?.onEvent({ type: "agent_message", text: "hello" });

    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "hello" }));
  });

  it("stops typing when a turn finishes", async () => {
    vi.useFakeTimers();
    const state = new FakeState();
    const codex = new FakeCodex();
    const workspaces = new FakeWorkspaces();
    const controller = new BotController(config, state as never, codex as never, workspaces as never);
    const message = fakeMessage();

    await controller.enqueue(message, "first");
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

function fakeMessage() {
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
    },
    reply: vi.fn(async () => undefined),
  } as unknown as Message & {
    channel: { sendTyping: ReturnType<typeof vi.fn> };
    reply: ReturnType<typeof vi.fn>;
  };
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
