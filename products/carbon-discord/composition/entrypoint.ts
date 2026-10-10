// The composition root: reads config from env, builds the discord.js
// Client, attaches every registered event and the command router, logs in.
// Nothing here decides what a command or event does. That lives in
// presentation/, once one exists.

import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { CommandRouter } from "../presentation/framework/command-router.ts";
import { ComponentRouter } from "../presentation/framework/component-router.ts";
import { ModalRouter } from "../presentation/framework/modal-router.ts";
import { AutocompleteRouter } from "../presentation/framework/autocomplete-router.ts";
import { ContextMenuRouter } from "../presentation/framework/context-menu-router.ts";
import { buildCommandRegistry } from "./commands.ts";
import { buildEventRegistry } from "./events.ts";
import { buildComponentRegistry } from "./components.ts";
import { buildModalRegistry } from "./modals.ts";
import { buildAutocompleteRegistry } from "./autocompletes.ts";
import { buildContextMenuRegistry } from "./context-menus.ts";
import { readSingleGuildEnvironment, validateOptionalConfiguration } from "../infrastructure/config/environment.ts";
import { database } from "../infrastructure/state/database.ts";
import { pruneAuditEvents } from "../infrastructure/state/audit-log.ts";

export interface CarbonDiscordConfig {
  readonly botToken: string;
  readonly guildId: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonDiscordConfig {
  validateOptionalConfiguration(env);
  const parsed = readSingleGuildEnvironment(env);
  return { botToken: parsed.botToken, guildId: parsed.guildId };
}

function eventGuildId(args: unknown[]): string | undefined {
  for (const value of args) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as { guildId?: unknown; guild?: { id?: unknown }; message?: { guildId?: unknown } };
    if (typeof candidate.guildId === "string") return candidate.guildId;
    if (typeof candidate.guild?.id === "string") return candidate.guild.id;
    if (typeof candidate.message?.guildId === "string") return candidate.message.guildId;
  }
  return undefined;
}

export async function startBot(config: CarbonDiscordConfig): Promise<Client> {
  database().query("SELECT 1").get();
  pruneAuditEvents(Number(process.env.AUDIT_RETENTION_DAYS ?? 365));
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });

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
        const guildId = eventGuildId(args);
        if (guildId && guildId !== config.guildId) {
          console.warn(`ignored ${descriptor.meta.name} event from unauthorized guild ${guildId}`);
          return;
        }
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

  const commandRouter = new CommandRouter(buildCommandRegistry());
  const componentRouter = new ComponentRouter(buildComponentRegistry());
  const modalRouter = new ModalRouter(buildModalRegistry());
  const autocompleteRouter = new AutocompleteRouter(buildAutocompleteRegistry());
  const contextMenuRouter = new ContextMenuRouter(buildContextMenuRegistry());

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.guildId !== config.guildId) {
      console.warn(`ignored interaction from unauthorized guild ${interaction.guildId ?? "direct-message"}`);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await commandRouter.route(interaction);
    } else if (interaction.isAutocomplete()) {
      await autocompleteRouter.route(interaction);
    } else if (interaction.isMessageComponent()) {
      await componentRouter.route(interaction);
    } else if (interaction.isModalSubmit()) {
      await modalRouter.route(interaction);
    } else if (interaction.isContextMenuCommand()) {
      await contextMenuRouter.route(interaction);
    }
  });

  client.on(Events.Error, (error) => console.error("Discord client error:", error));
  client.on(Events.Warn, (warning) => console.warn("Discord client warning:", warning));

  await client.login(config.botToken);
  try {
    await client.guilds.fetch(config.guildId);
  } catch (error) {
    client.destroy();
    throw new Error(`the bot cannot access configured guild ${config.guildId}`, { cause: error });
  }
  return client;
}
