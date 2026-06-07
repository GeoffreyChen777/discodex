import { Client, GatewayIntentBits, Events } from "discord.js";

import { BotController } from "./bot.js";
import { CodexRunner } from "./codex.js";
import { loadConfig } from "./config.js";
import { extractBotText, parseBotMessage, replySafely } from "./discord.js";
import { StateStore } from "./state.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
const state = new StateStore(config.stateDbPath);
const codex = new CodexRunner(config);
const workspaces = new WorkspaceManager(config, state);
const controller = new BotController(config, state, codex, workspaces);
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];

if (config.discordHistoryLimit > 0) {
  intents.push(GatewayIntentBits.MessageContent);
}

const client = new Client({
  intents,
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || !message.guildId || !client.user) {
      return;
    }
    if (message.guildId !== config.discordGuildId) {
      return;
    }
    if (config.allowedChannelIds && !config.allowedChannelIds.has(message.channelId)) {
      return;
    }

    const text = extractBotText(message.content, client.user.id);
    if (text === null) {
      return;
    }

    const parsed = parseBotMessage(text);
    if (parsed.kind === "empty") {
      await replySafely(message, "Send a prompt after mentioning me.");
      return;
    }
    if (parsed.kind === "command") {
      if (parsed.command === "reset") {
        await controller.reset(message);
      } else if (parsed.command === "cancel") {
        await controller.cancel(message);
      } else if (parsed.command === "status") {
        await controller.status(message);
      } else if (parsed.command === "workspace") {
        await controller.workspace(message);
      } else if (parsed.command === "reset-workspace") {
        await controller.resetWorkspace(message);
      } else {
        await controller.deleteWorkspace(message);
      }
      return;
    }

    await controller.enqueue(message, parsed.prompt);
  } catch (error) {
    console.error("Failed to handle message", error);
    await replySafely(message, `Bot error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await client.login(config.discordToken);

function shutdown(): void {
  void client.destroy();
  state.close();
  process.exit(0);
}
