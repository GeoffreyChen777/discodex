import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AppConfig } from "../src/config.js";
import { WorkspaceManager, assertInside, safeChannelId } from "../src/workspace.js";

const execFileAsync = promisify(execFile);

describe("workspace helpers", () => {
  it("sanitizes channel ids for paths and branch names", () => {
    expect(safeChannelId("123")).toBe("123");
    expect(safeChannelId("../abc")).toBe("---abc");
  });

  it("rejects paths outside the workspace root", () => {
    expect(() => assertInside("/workspaces/channel-1", "/workspaces")).not.toThrow();
    expect(() => assertInside("/tmp/channel-1", "/workspaces")).toThrow(/outside/);
  });

  it("creates a git worktree for a channel", async () => {
    const root = mkdtempSync(join(tmpdir(), "discodex-workspace-test-"));
    const base = join(root, "base");
    const workspaces = join(root, "workspaces");

    await execFileAsync("git", ["init", base]);
    writeFileSync(join(base, "README.md"), "test\n");
    await execFileAsync("git", ["-C", base, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      base,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "init",
    ]);

    const state = new FakeState();
    const manager = new WorkspaceManager(
      {
        ...baseConfig,
        codexBaseWorkdir: base,
        codexWorkspacesDir: workspaces,
      },
      state as never,
    );

    const workspace = await manager.ensureChannelWorkspace("123");

    expect(workspace.workspacePath).toBe(join(workspaces, "channel-123"));
    expect(workspace.branchName).toBe("discodex/channel-123");
    expect(state.getChannelSession("123")?.workspacePath).toBe(workspace.workspacePath);
  });

  it("initializes an empty base directory as a git repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "discodex-empty-base-test-"));
    const base = join(root, "base");
    const workspaces = join(root, "workspaces");
    mkdirSync(base);

    const state = new FakeState();
    const manager = new WorkspaceManager(
      {
        ...baseConfig,
        codexBaseWorkdir: base,
        codexWorkspacesDir: workspaces,
      },
      state as never,
    );

    const workspace = await manager.ensureChannelWorkspace("456");
    const { stdout } = await execFileAsync("git", ["-C", base, "rev-parse", "--is-inside-work-tree"]);

    expect(stdout.trim()).toBe("true");
    expect(workspace.workspacePath).toBe(join(workspaces, "channel-456"));
  });

  it("rejects non-empty non-git base directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "discodex-nongit-base-test-"));
    const base = join(root, "base");
    const workspaces = join(root, "workspaces");
    mkdirSync(base);
    writeFileSync(join(base, "notes.txt"), "not git\n");

    const manager = new WorkspaceManager(
      {
        ...baseConfig,
        codexBaseWorkdir: base,
        codexWorkspacesDir: workspaces,
      },
      new FakeState() as never,
    );

    await expect(manager.ensureChannelWorkspace("789")).rejects.toThrow(/contains files but is not a git repository/);
  });
});

const baseConfig: AppConfig = {
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
  queueLimit: 10,
  turnTimeoutMs: 1000,
};

class FakeState {
  private readonly rows = new Map<string, { workspacePath: string | null; branchName: string | null }>();

  getChannelSession(channelId: string) {
    const row = this.rows.get(channelId);
    return row
      ? {
          channelId,
          threadId: null,
          workspacePath: row.workspacePath,
          branchName: row.branchName,
          updatedAt: new Date().toISOString(),
        }
      : null;
  }

  saveChannelWorkspace(channelId: string, workspacePath: string, branchName: string) {
    this.rows.set(channelId, { workspacePath, branchName });
  }
}
