import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ChannelSession = {
  channelId: string;
  threadId: string | null;
  workspacePath: string | null;
  branchName: string | null;
  updatedAt: string;
};

type ChannelSessionRow = {
  channel_id: string;
  thread_id: string | null;
  workspace_path: string | null;
  branch_name: string | null;
  updated_at: string;
};

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_sessions (
        channel_id TEXT PRIMARY KEY,
        thread_id TEXT,
        workspace_path TEXT,
        branch_name TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    this.migrate();
  }

  getChannelSession(channelId: string): ChannelSession | null {
    const row = this.db
      .prepare("SELECT channel_id, thread_id, workspace_path, branch_name, updated_at FROM channel_sessions WHERE channel_id = ?")
      .get(channelId) as ChannelSessionRow | undefined;
    return row
      ? {
          channelId: row.channel_id,
          threadId: row.thread_id || null,
          workspacePath: row.workspace_path,
          branchName: row.branch_name,
          updatedAt: row.updated_at,
        }
      : null;
  }

  saveChannelSession(channelId: string, threadId: string): void {
    this.db
      .prepare(
        `
        INSERT INTO channel_sessions (channel_id, thread_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          updated_at = excluded.updated_at
      `,
      )
      .run(channelId, threadId, new Date().toISOString());
  }

  clearChannelThread(channelId: string): void {
    this.db
      .prepare(
        `
        INSERT INTO channel_sessions (channel_id, thread_id, updated_at)
        VALUES (?, '', ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          thread_id = '',
          updated_at = excluded.updated_at
      `,
      )
      .run(channelId, new Date().toISOString());
  }

  saveChannelWorkspace(channelId: string, workspacePath: string, branchName: string): void {
    this.db
      .prepare(
        `
        INSERT INTO channel_sessions (channel_id, thread_id, workspace_path, branch_name, updated_at)
        VALUES (?, '', ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          branch_name = excluded.branch_name,
          updated_at = excluded.updated_at
      `,
      )
      .run(channelId, workspacePath, branchName, new Date().toISOString());
  }

  deleteChannelSession(channelId: string): void {
    this.db.prepare("DELETE FROM channel_sessions WHERE channel_id = ?").run(channelId);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(channel_sessions)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("workspace_path")) {
      this.db.exec("ALTER TABLE channel_sessions ADD COLUMN workspace_path TEXT");
    }
    if (!names.has("branch_name")) {
      this.db.exec("ALTER TABLE channel_sessions ADD COLUMN branch_name TEXT");
    }
  }
}
