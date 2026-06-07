import type { Message } from "discord.js";

import { buildCodexPrompt, replySafely } from "./discord.js";
import type { AppConfig } from "./config.js";
import type { CodexDisplayEvent, CodexRunner } from "./codex.js";
import type { StateStore } from "./state.js";
import type { WorkspaceManager } from "./workspace.js";

type Job = {
  message: Message;
  prompt: string;
};

type ChannelWork = {
  active: ReturnType<CodexRunner["start"]> | null;
  activeMessageId: string | null;
  starting: boolean;
  queue: Job[];
};

export class BotController {
  private readonly channels = new Map<string, ChannelWork>();

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly codex: CodexRunner,
    private readonly workspaces: WorkspaceManager,
  ) {}

  async enqueue(message: Message, prompt: string): Promise<void> {
    const work = this.workFor(message.channelId);
    if (work.queue.length >= this.config.queueLimit) {
      await replySafely(message, `Queue is full for this channel (${this.config.queueLimit} pending). Try again later.`);
      return;
    }
    work.queue.push({ message, prompt });
    this.processNext(message.channelId);
  }

  async reset(message: Message): Promise<void> {
    const work = this.workFor(message.channelId);
    if (work.active) {
      work.active.cancel();
    }
    work.active = null;
    work.activeMessageId = null;
    work.starting = false;
    work.queue = [];
    this.state.clearChannelThread(message.channelId);
    await replySafely(message, "Channel Codex session reset.");
  }

  async cancel(message: Message): Promise<void> {
    const work = this.workFor(message.channelId);
    if (!work.active) {
      await replySafely(message, "No active Codex turn in this channel.");
      return;
    }
    work.active.cancel();
    await replySafely(message, "Cancel requested for the active Codex turn.");
  }

  async status(message: Message): Promise<void> {
    const work = this.workFor(message.channelId);
    const session = this.state.getChannelSession(message.channelId);
    const workspace = this.workspaces.getChannelWorkspace(message.channelId);
    await replySafely(
      message,
      [
        `Status: ${work.active || work.starting ? "running" : "idle"}`,
        `Queued: ${work.queue.length}`,
        `Session: ${session?.threadId ?? "none"}`,
        `Workspace: ${workspace?.workspacePath ?? "not created"}`,
        `Branch: ${workspace?.branchName ?? "not created"}`,
      ].join("\n"),
    );
  }

  async workspace(message: Message): Promise<void> {
    const workspace = await this.workspaces.ensureChannelWorkspace(message.channelId);
    await replySafely(
      message,
      [`Workspace: ${workspace.workspacePath}`, `Branch: ${workspace.branchName}`].join("\n"),
    );
  }

  async resetWorkspace(message: Message): Promise<void> {
    const work = this.workFor(message.channelId);
    this.stopAndClearWork(work);
    await this.workspaces.deleteChannelWorkspace(message.channelId);
    const workspace = await this.workspaces.ensureChannelWorkspace(message.channelId);
    await replySafely(
      message,
      [`Workspace recreated: ${workspace.workspacePath}`, `Branch: ${workspace.branchName}`].join("\n"),
    );
  }

  async deleteWorkspace(message: Message): Promise<void> {
    const work = this.workFor(message.channelId);
    this.stopAndClearWork(work);
    await this.workspaces.deleteChannelWorkspace(message.channelId);
    await replySafely(message, "Channel workspace deleted.");
  }

  getChannelStatus(channelId: string): { running: boolean; queued: number } {
    const work = this.workFor(channelId);
    return { running: Boolean(work.active || work.starting), queued: work.queue.length };
  }

  private processNext(channelId: string): void {
    const work = this.workFor(channelId);
    if (work.active || work.starting || work.queue.length === 0) {
      return;
    }

    const job = work.queue.shift();
    if (!job) {
      return;
    }

    work.starting = true;
    void this.startJob(channelId, job);
  }

  private async startJob(channelId: string, job: Job): Promise<void> {
    const work = this.workFor(channelId);
    try {
      const workspace = await this.workspaces.ensureChannelWorkspace(channelId);
      const session = this.state.getChannelSession(channelId);
      const run = this.codex.start({
        prompt: buildCodexPrompt(job.message, job.prompt),
        threadId: session?.threadId ?? null,
        workspacePath: workspace.workspacePath,
        onEvent: async (event) => this.handleCodexEvent(job.message, event),
      });
      work.active = run;
      work.activeMessageId = job.message.id;
      work.starting = false;

      run.done
        .then((result) => {
          if (result.threadId) {
            this.state.saveChannelSession(channelId, result.threadId);
          }
        })
        .catch((error: unknown) => {
          void replySafely(job.message, `Codex failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          const current = this.workFor(channelId);
          if (current.active === run) {
            current.active = null;
            current.activeMessageId = null;
          }
          this.processNext(channelId);
        });
    } catch (error) {
      work.starting = false;
      await replySafely(job.message, `Workspace setup failed: ${error instanceof Error ? error.message : String(error)}`);
      this.processNext(channelId);
    }
  }

  private async handleCodexEvent(message: Message, event: CodexDisplayEvent): Promise<void> {
    if (event.type === "thread") {
      this.state.saveChannelSession(message.channelId, event.threadId);
      return;
    }
    if (event.type === "completed") {
      return;
    }
    if (event.type === "progress") {
      return;
    }
    if (event.type === "error") {
      await replySafely(message, `Codex error: ${event.text}`);
      return;
    }
    await replySafely(message, event.text);
  }

  private workFor(channelId: string): ChannelWork {
    let work = this.channels.get(channelId);
    if (!work) {
      work = { active: null, activeMessageId: null, starting: false, queue: [] };
      this.channels.set(channelId, work);
    }
    return work;
  }

  private stopAndClearWork(work: ChannelWork): void {
    if (work.active) {
      work.active.cancel();
    }
    work.active = null;
    work.activeMessageId = null;
    work.starting = false;
    work.queue = [];
  }
}
