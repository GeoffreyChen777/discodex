import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { AppConfig } from "./config.js";
import type { StateStore } from "./state.js";

const execFileAsync = promisify(execFile);

export type ChannelWorkspace = {
  channelId: string;
  workspacePath: string;
  branchName: string;
};

export class WorkspaceManager {
  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
  ) {}

  async ensureChannelWorkspace(channelId: string): Promise<ChannelWorkspace> {
    const existing = this.state.getChannelSession(channelId);
    if (existing?.workspacePath && existing.branchName && isDirectory(existing.workspacePath)) {
      return {
        channelId,
        workspacePath: existing.workspacePath,
        branchName: existing.branchName,
      };
    }

    await this.ensureBaseGitRepo();
    mkdirSync(this.config.codexWorkspacesDir, { recursive: true });

    const safeId = safeChannelId(channelId);
    const branchName = `discodex/channel-${safeId}`;
    const workspacePath = resolve(this.config.codexWorkspacesDir, `channel-${safeId}`);
    assertInside(workspacePath, this.config.codexWorkspacesDir);

    if (existsSync(workspacePath)) {
      if (!isDirectory(workspacePath)) {
        throw new Error(`Workspace path exists but is not a directory: ${workspacePath}`);
      }
      await this.assertGitWorktree(workspacePath);
      this.state.saveChannelWorkspace(channelId, workspacePath, branchName);
      return { channelId, workspacePath, branchName };
    }

    const branchExists = await this.branchExists(branchName);
    const args = branchExists
      ? ["-C", this.config.codexBaseWorkdir, "worktree", "add", workspacePath, branchName]
      : ["-C", this.config.codexBaseWorkdir, "worktree", "add", "-b", branchName, workspacePath];
    await runGit(args);

    this.state.saveChannelWorkspace(channelId, workspacePath, branchName);
    return { channelId, workspacePath, branchName };
  }

  getChannelWorkspace(channelId: string): ChannelWorkspace | null {
    const existing = this.state.getChannelSession(channelId);
    if (!existing?.workspacePath || !existing.branchName) {
      return null;
    }
    return {
      channelId,
      workspacePath: existing.workspacePath,
      branchName: existing.branchName,
    };
  }

  async deleteChannelWorkspace(channelId: string): Promise<void> {
    const workspace = this.getChannelWorkspace(channelId);
    if (!workspace) {
      return;
    }
    assertInside(workspace.workspacePath, this.config.codexWorkspacesDir);

    if (existsSync(workspace.workspacePath)) {
      try {
        await runGit(["-C", this.config.codexBaseWorkdir, "worktree", "remove", "--force", workspace.workspacePath]);
      } catch {
        rmSync(workspace.workspacePath, { recursive: true, force: true });
      }
    }
    this.state.deleteChannelSession(channelId);
  }

  private async ensureBaseGitRepo(): Promise<void> {
    mkdirSync(this.config.codexBaseWorkdir, { recursive: true });
    if (await this.isGitRepo(this.config.codexBaseWorkdir)) {
      return;
    }
    if (readdirSync(this.config.codexBaseWorkdir).length > 0) {
      throw new Error(`${this.config.codexBaseWorkdir} contains files but is not a git repository`);
    }

    await runGit(["init", this.config.codexBaseWorkdir]);
    writeFileSync(resolve(this.config.codexBaseWorkdir, "README.md"), "# discodex workspace\n");
    await runGit(["-C", this.config.codexBaseWorkdir, "add", "README.md"]);
    await runGit([
      "-C",
      this.config.codexBaseWorkdir,
      "-c",
      "user.name=discodex",
      "-c",
      "user.email=discodex@example.invalid",
      "commit",
      "-m",
      "Initialize discodex workspace",
    ]);
  }

  private async isGitRepo(path: string): Promise<boolean> {
    try {
      const { stdout } = await runGit(["-C", path, "rev-parse", "--is-inside-work-tree"]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async assertGitWorktree(path: string): Promise<void> {
    await runGit(["-C", path, "rev-parse", "--show-toplevel"]);
  }

  private async branchExists(branchName: string): Promise<boolean> {
    try {
      await runGit(["-C", this.config.codexBaseWorkdir, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
      return true;
    } catch {
      return false;
    }
  }
}

export function safeChannelId(channelId: string): string {
  const safe = channelId.replace(/[^A-Za-z0-9_-]/g, "-");
  if (!safe) {
    throw new Error("Invalid Discord channel id");
  }
  return safe;
}

export function assertInside(path: string, root: string): void {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Refusing to use path outside workspace root: ${resolvedPath}`);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`git ${args.join(" ")} failed: ${error.message}`);
    }
    throw error;
  }
}
