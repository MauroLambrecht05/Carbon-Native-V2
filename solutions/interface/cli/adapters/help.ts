// Help rendering, generated from command metadata.
//
// V1 kept a hand-written HELP template string in main.ts listing every
// command, plus a separate hand-written help block inside each command that
// had subcommands. Six places to forget. This renders from the same metadata
// the dispatcher routes on, so a command cannot exist without appearing in
// help, and cannot rename itself without help following.

import type { Command, CommandGroup, CommandMeta } from "../kernel/command.ts";
import type { CommandRegistry } from "../dispatch/command-registry.ts";
import type { Io } from "../ports/io-port.ts";

export class HelpRenderer {
  constructor(
    private readonly registry: CommandRegistry,
    private readonly io: Io,
    private readonly binary: string,
    private readonly version: string,
  ) {}

  /** Top-level `carbon --help`. */
  renderRoot(): string {
    const c = this.io.c;
    const commands = this.registry.visible();
    const width = Math.max(...commands.map((d) => d.meta.name.length));

    const lines = [
      "",
      `${c.bold(this.binary)} — desktop-app framework CLI`,
      "",
      c.bold("Usage:"),
      `  ${this.binary} <command> [options]`,
      "",
      c.bold("Commands:"),
      ...commands.map(
        (d) => `  ${c.cyan(d.meta.name.padEnd(width))}  ${d.meta.summary}`,
      ),
      "",
      c.bold("Options:"),
      `  ${c.dim("-h, --help".padEnd(width + 4))}  Show help; ${this.binary} help <command> for detail`,
      `  ${c.dim("-v, --version".padEnd(width + 4))}  Print the version (${this.version})`,
      "",
    ];

    return lines.join("\n");
  }

  /** `carbon help <command>`. */
  renderCommand(meta: CommandMeta): string {
    const c = this.io.c;
    const lines = [
      "",
      `${c.bold(`${this.binary} ${meta.name}`)} — ${meta.summary}`,
      "",
      c.bold("Usage:"),
      `  ${this.binary} ${meta.usage ?? `${meta.name} [options]`}`,
    ];

    if (meta.aliases?.length) {
      lines.push("", c.bold("Aliases:"), `  ${meta.aliases.join(", ")}`);
    }

    if (meta.flags?.length) {
      const width = Math.max(
        ...meta.flags.map((f) => flagLabel(f.name, f.short, f.placeholder).length),
      );
      lines.push("", c.bold("Options:"));
      for (const flag of meta.flags) {
        const label = flagLabel(flag.name, flag.short, flag.placeholder);
        lines.push(`  ${c.dim(label.padEnd(width))}  ${flag.description}`);
      }
    }

    if (meta.examples?.length) {
      lines.push("", c.bold("Examples:"));
      for (const example of meta.examples) {
        lines.push(`  ${c.dim("$")} ${example}`);
      }
    }

    if (meta.deprecated) {
      lines.push("", c.yellow(`Deprecated: ${meta.deprecated}`));
    }

    lines.push("");
    return lines.join("\n");
  }

  /** Help for a command that has subcommands. */
  renderGroup(group: CommandGroup): string {
    const c = this.io.c;
    const subs = group.subcommands.filter((s) => !s.meta.hidden);
    const width = Math.max(...subs.map((s) => s.meta.name.length));

    const lines = [
      "",
      `${c.bold(`${this.binary} ${group.meta.name}`)} — ${group.meta.summary}`,
      "",
      c.bold("Usage:"),
      `  ${this.binary} ${group.meta.name} <subcommand> [options]`,
      "",
      c.bold("Subcommands:"),
    ];

    for (const sub of subs) {
      lines.push(`  ${c.cyan(sub.meta.name.padEnd(width))}  ${sub.meta.summary}`);
      for (const flag of sub.meta.flags ?? []) {
        const label = flagLabel(flag.name, flag.short, flag.placeholder);
        lines.push(`  ${" ".repeat(width)}  ${c.dim(label)}  ${flag.description}`);
      }
    }

    const examples = subs.flatMap((s) => s.meta.examples ?? []);
    if (examples.length) {
      lines.push("", c.bold("Examples:"));
      for (const example of examples) lines.push(`  ${c.dim("$")} ${example}`);
    }

    lines.push("");
    return lines.join("\n");
  }
}

function flagLabel(name: string, short?: string, placeholder?: string): string {
  const head = short ? `-${short}, --${name}` : `    --${name}`;
  return placeholder ? `${head} ${placeholder}` : head;
}

/** Subcommands of a group, addressed as `<group> <sub>` for help lookup. */
export function isCommandGroup(command: Command): command is CommandGroup {
  return Array.isArray((command as CommandGroup).subcommands);
}
