<p align="center">
  <img src="assets/icon.svg" width="96" height="96" alt="discodex icon">
</p>

<h1 align="center">discodex</h1>

<p align="center">
  <a href="https://nodejs.org/"><img alt="Node.js 24+" src="https://img.shields.io/badge/node-%3E%3D24.0.0-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/typescript-6.x-3178C6?logo=typescript&logoColor=white"></a>
  <a href="https://discord.js.org/"><img alt="discord.js v14" src="https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white"></a>
  <a href="https://developers.openai.com/codex/"><img alt="Codex CLI" src="https://img.shields.io/badge/codex-cli-10A37F?logo=openai&logoColor=white"></a>
  <a href="https://www.docker.com/"><img alt="Docker" src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

Minimal Discord-to-Codex bridge. Mention the bot in an allowed Discord channel and the bot runs the prompt through Codex, then posts progress and output back to the channel.

## Requirements

- Docker with Compose
- A Discord application and bot token
- A private, trusted Discord server
- Optional: a host git repository mounted into the container at `/workspace-base`

## Discord setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Invite it to your server with permissions: View Channel, Send Messages, Read Message History.
3. If `DISCORD_HISTORY_LIMIT` is greater than `0`, enable Message Content Intent in the Bot settings page. Direct mention handling can run without it, but readable channel history needs it.

## Configure

```bash
cp .env.example .env
```

Set:

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `ALLOWED_CHANNEL_IDS` if you want to restrict channels
- `DISCORD_HISTORY_LIMIT` to include recent channel messages before each Codex prompt, or `0` to disable
- `DISCORD_HISTORY_MAX_CHARS` to cap how much history text is sent to Codex
- Optional `CODEX_WORKSPACE_HOST_PATH` to a host git repo path mounted at `/workspace-base`
- If `CODEX_WORKSPACE_HOST_PATH` is unset, Compose uses an internal Docker volume and the bot initializes it as an empty git repo on first use

## Build and login

```bash
docker compose build
docker compose run --rm discodex codex login --device-auth
```

The login is stored in the `codex-home` Docker volume.

## Run

```bash
docker compose up -d
```

Use Discord:

- `@bot fix the failing test`
- `@bot status`
- `@bot workspace`
- `@bot cancel`
- `@bot reset`
- `@bot reset-workspace`
- `@bot delete-workspace`

## Discord history context

Set `DISCORD_HISTORY_LIMIT` to a small number such as `20` to include recent messages from the same Discord channel before the current mention. The bot fetches messages before the triggering message, sorts them oldest to newest, redacts common token shapes, and adds them to the Codex prompt. `DISCORD_HISTORY_MAX_CHARS` caps the total history text so a busy channel does not produce oversized prompts.

When history is enabled, the bot requests Discord's Message Content gateway intent. You must also enable Message Content Intent in the Discord Developer Portal for the application.

## Codex execution policy

The bot runs Codex with:

```bash
codex exec --json -c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"' --sandbox workspace-write --cd <channel-workspace>
```

At runtime `<channel-workspace>` is the channel-specific worktree path, for example `/workspaces/channel-123`.

Auto-review is the "approve for me" behavior. It reviews boundary-crossing requests without granting full access. The Docker container and Codex `workspace-write` sandbox remain the security boundary. `danger-full-access` and `--yolo` are intentionally not supported by the config parser.

## Per-channel workspaces

Before creating a channel workspace, the bot ensures `/workspace-base` is a git repo. If it is empty, the bot runs `git init` and creates an initial README commit. If it contains files but is not a git repo, setup fails so existing content is not silently rewritten.

The first prompt in a Discord channel creates a git worktree:

```bash
git -C /workspace-base worktree add -b discodex/channel-<channel-id> /workspaces/channel-<channel-id>
```

Each channel keeps its own Codex session, branch, and workspace path in SQLite. `@bot reset` clears only the Codex session. `@bot reset-workspace` removes and recreates the channel worktree. `@bot delete-workspace` removes the channel worktree and clears its saved state.

The mounted base repo must be writable by the container user because `git worktree` updates metadata under the base repo's `.git` directory.
