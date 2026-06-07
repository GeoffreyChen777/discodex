export type AppConfig = {
  discordToken: string;
  discordGuildId: string;
  allowedChannelIds: Set<string> | null;
  codexBaseWorkdir: string;
  codexWorkspacesDir: string;
  codexHome?: string;
  codexSandbox: "read-only" | "workspace-write";
  codexApprovalsReviewer: "auto_review" | "guardian_subagent";
  codexModel?: string;
  stateDbPath: string;
  queueLimit: number;
  turnTimeoutMs: number;
};

const DEFAULT_QUEUE_LIMIT = 10;
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const discordToken = requireEnv(env, "DISCORD_TOKEN");
  const discordGuildId = requireEnv(env, "DISCORD_GUILD_ID");
  const codexBaseWorkdir = env.CODEX_BASE_WORKDIR?.trim() || env.CODEX_WORKDIR?.trim() || "/workspace-base";
  const codexWorkspacesDir = env.CODEX_WORKSPACES_DIR?.trim() || "/workspaces";
  const stateDbPath = env.STATE_DB_PATH?.trim() || "./data/discodex.sqlite";
  const codexSandbox = parseSandbox(env.CODEX_SANDBOX);
  const codexApprovalsReviewer = parseApprovalsReviewer(env.CODEX_APPROVALS_REVIEWER);
  const queueLimit = parsePositiveInt(env.QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT, "QUEUE_LIMIT");
  const turnTimeoutMs = parsePositiveInt(
    env.TURN_TIMEOUT_MS,
    DEFAULT_TURN_TIMEOUT_MS,
    "TURN_TIMEOUT_MS",
  );

  return {
    discordToken,
    discordGuildId,
    allowedChannelIds: parseCsvSet(env.ALLOWED_CHANNEL_IDS),
    codexBaseWorkdir,
    codexWorkspacesDir,
    codexHome: optional(env.CODEX_HOME),
    codexSandbox,
    codexApprovalsReviewer,
    codexModel: optional(env.CODEX_MODEL),
    stateDbPath,
    queueLimit,
    turnTimeoutMs,
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseCsvSet(value: string | undefined): Set<string> | null {
  const ids = value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return ids?.length ? new Set(ids) : null;
}

function parseSandbox(value: string | undefined): "read-only" | "workspace-write" {
  const sandbox = value?.trim() || "workspace-write";
  if (sandbox === "read-only" || sandbox === "workspace-write") {
    return sandbox;
  }
  throw new Error("CODEX_SANDBOX must be read-only or workspace-write");
}

function parseApprovalsReviewer(value: string | undefined): "auto_review" | "guardian_subagent" {
  const reviewer = value?.trim() || "auto_review";
  if (reviewer === "auto_review" || reviewer === "guardian_subagent") {
    return reviewer;
  }
  throw new Error("CODEX_APPROVALS_REVIEWER must be auto_review or guardian_subagent");
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
