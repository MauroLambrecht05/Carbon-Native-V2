// The composition root: reads config from env, builds the discord.js
// Client, attaches every registered event and the command router, logs in.
// Nothing here decides what a command or event does. That lives in
// presentation/, once one exists.

import { Client, Events, GatewayIntentBits } from "discord.js";
import { CommandRouter } from "../presentation/framework/command-router.ts";
import { buildCommandRegistry } from "./commands.ts";
import { buildEventRegistry } from "./events.ts";

export interface CarbonDiscordConfig {
  readonly botToken: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonDiscordConfig {
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!botToken) throw new Error("missing required env var DISCORD_BOT_TOKEN");
  return { botToken };
}

export function startBot(config: CarbonDiscordConfig): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  for (const descriptor of buildEventRegistry().all()) {
    const attach = descriptor.meta.once ? client.once.bind(client) : client.on.bind(client);
    // The registry's descriptor.meta.name is `keyof ClientEvents`, a union,
    // so the per-name overload Client.on/once normally picks can't be
    // selected statically here. This is the one place that impedance
    // mismatch is paid, deliberately: everywhere else (each concrete event
    // file) keeps its own args typed. See presentation/framework/event.ts.
    (attach as (name: string, listener: (...args: unknown[]) => void) => Client)(
      descriptor.meta.name,
      async (...args: unknown[]) => {
        // Isolated per handler: EventRegistry allows more than one
        // descriptor per event name (unlike CommandRegistry, see
        // event-registry.ts), so a future second listener on the same event
        // must not be taken down by this one throwing, and this one must
        // not surface as a bare unhandled rejection.
        try {
          const event = await descriptor.load();
          await event.handle(...args);
        } catch (error) {
          console.error(`event handler for "${descriptor.meta.name}" failed:`, error);
        }
      },
    );
  }

  const router = new CommandRouter(buildCommandRegistry());
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await router.route(interaction);
  });

  client.login(config.botToken);
  return client;
}
