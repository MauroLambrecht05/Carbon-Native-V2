// `carbon ext <subcommand>` — the extension surface a plugin plugs into.
//
// A CommandGroup with one class per subcommand, the same shape as `plugin` and
// `signer`. These four briefly lived in a product of their own, which was the
// wrong call twice over: they are commands, and commands are carbon-cli. Being
// about plugins is not a reason to leave.
//
// `carbon plugin *` is for authoring ONE plugin — scaffold it, build it, check
// it, install it. This is for the surface every plugin is written against:
// what exists to plug into, and whether the four renderings of that declaration
// still agree.
//
// All the work is @carbon/registry. What is left here is argv in,
// output out.

import {
  Command,
  CommandGroup,
  EXIT_FAILURE,
  EXIT_OK,
  type CommandContext,
  type CommandMeta,
  type ExitCode,
} from "@carbon/cli";
import {
  ExtensionPointError,
  extensionPointUseCases,
  type ExtensionPoint,
} from "@carbon/registry";
import { CARBON_ROOT } from "@carbon/workspace";

/**
 * Runs `body`, turning the capability's own refusals into a message.
 *
 * An ExtensionPointError is something the user can act on; anything else is a
 * bug and should surface with its stack. Same split `plugin` uses.
 */
async function reporting(
  ctx: CommandContext,
  body: () => Promise<ExitCode> | ExitCode,
): Promise<ExitCode> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof ExtensionPointError) {
      ctx.io.error(e.message);
      return EXIT_FAILURE;
    }
    throw e;
  }
}

/** Shared by `check` and `generate --check`, which must behave identically. */
function runCheck(ctx: CommandContext): ExitCode {
  const result = extensionPointUseCases(CARBON_ROOT).check.execute();

  for (const artifact of result.artifacts) {
    if (artifact.status === "current") {
      ctx.io.raw(`  ${ctx.io.c.dim("ok")}       ${artifact.path}`);
      continue;
    }
    const where =
      artifact.firstDifferingLine === undefined
        ? ""
        : ctx.io.c.dim(` (first differs at line ${artifact.firstDifferingLine})`);
    ctx.io.raw(`  ${ctx.io.c.bold(artifact.status.toUpperCase())}  ${artifact.path}${where}`);
  }

  if (result.ok) {
    ctx.io.success(
      `${result.pointCount} extension points — every rendering matches the registry`,
    );
    return EXIT_OK;
  }

  ctx.io.error(
    `${result.outOfDate.length} of ${result.artifacts.length} generated artifacts are out of date.`,
  );
  ctx.io.info("The Zig registry is the source of truth. Regenerate rather than editing them:");
  ctx.io.raw("  carbon ext generate");
  return EXIT_FAILURE;
}

class GenerateCommand extends Command {
  readonly meta: CommandMeta = {
    name: "generate",
    summary: "Render the Zig registry into the C header, the Rust table and the TS types",
    usage: "ext generate [--check]",
    flags: [
      {
        name: "check",
        boolean: true,
        description: "Do not write; fail if anything is out of date (same as `ext check`)",
      },
    ],
    examples: ["carbon ext generate", "carbon ext generate --check"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      // `--check` exists because the incantation people reach for in CI is
      // `<generator> --check`, and having it mean something different from
      // `ext check` would be a trap.
      if (ctx.flags.bool("check")) return runCheck(ctx);

      const result = extensionPointUseCases(CARBON_ROOT).generate.execute();

      ctx.io.info(
        `${ctx.io.c.bold(String(result.pointCount))} extension points, ABI minor ${result.abiMinor}`,
      );
      for (const artifact of result.artifacts) {
        const mark = artifact.changed ? ctx.io.c.bold("updated") : ctx.io.c.dim("unchanged");
        ctx.io.raw(`  ${mark}  ${artifact.path}`);
        ctx.io.raw(`            ${ctx.io.c.dim(artifact.purpose)}`);
      }

      const changed = result.artifacts.filter((a) => a.changed);
      if (changed.length === 0) {
        ctx.io.success("everything was already up to date");
        return EXIT_OK;
      }

      ctx.io.success(`regenerated ${changed.length} artifact(s)`);
      // The Rust and TS renderings are compiled by other jobs; saying so is
      // cheaper than someone discovering it from a red build.
      ctx.io.info(
        `${ctx.io.c.dim("next:")} rebuild the runtime and re-run the TypeScript check — ` +
          "both consume what just changed",
      );
      return EXIT_OK;
    });
  }
}

class CheckExtensionsCommand extends Command {
  readonly meta: CommandMeta = {
    name: "check",
    summary: "Fail if the generated artifacts have drifted from the registry",
    usage: "ext check",
    examples: ["carbon ext check"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => runCheck(ctx));
  }
}

class ListExtensionsCommand extends Command {
  readonly meta: CommandMeta = {
    name: "list",
    summary: "List the extension points a plugin may implement",
    usage: "ext list [--area <area>] [--json]",
    flags: [
      { name: "area", placeholder: "area", description: "Only points in this area" },
      { name: "json", boolean: true, description: "Machine-readable output" },
    ],
    examples: ["carbon ext list", "carbon ext list --area paint"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      // Reads the Zig registry, not the generated TypeScript. The generated
      // copy would be easier to import and would report the world as it was
      // the last time someone ran `generate` — the drift this exists to find.
      const { registry } = extensionPointUseCases(CARBON_ROOT).render.execute();
      const area = ctx.flags.get("area", "");
      const points = area ? registry.points.filter((p) => p.area === area) : registry.points;

      if (ctx.flags.bool("json")) {
        ctx.io.raw(
          JSON.stringify(
            points.map((p) => ({
              id: p.id,
              symbol: p.symbol,
              sinceMinor: p.sinceMinor,
              stability: p.stability,
              arity: p.arity,
              capability: p.capability,
            })),
            null,
            2,
          ),
        );
        return EXIT_OK;
      }

      if (points.length === 0) {
        ctx.io.info(
          `no extension points in area "${area}". Areas: ${[...registry.byArea().keys()].join(", ")}`,
        );
        return EXIT_OK;
      }

      for (const [areaName, areaPoints] of groupByArea(points)) {
        ctx.io.raw("");
        ctx.io.raw(ctx.io.c.bold(areaName));
        for (const point of areaPoints) {
          const tags: string[] = [`1.${point.sinceMinor}`];
          if (point.isExclusive) tags.push("exclusive");
          if (point.isExperimental) tags.push("experimental");
          if (point.capability) tags.push(`needs ${point.capability}`);

          ctx.io.raw(`  ${point.id.padEnd(30)} ${ctx.io.c.dim(tags.join(" · "))}`);
          ctx.io.raw(`  ${" ".repeat(30)} ${ctx.io.c.dim(firstSentence(point.doc))}`);
        }
      }

      ctx.io.raw("");
      ctx.io.info(
        `${points.length} point(s). ${ctx.io.c.dim("carbon ext show <id>")} for the full signature.`,
      );
      return EXIT_OK;
    });
  }
}

class ShowExtensionCommand extends Command {
  readonly meta: CommandMeta = {
    name: "show",
    summary: "Everything about one extension point",
    usage: "ext show <point-id>",
    examples: ["carbon ext show paint.before"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.first ? null : "show requires a point id. Try: carbon ext list";
  }

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const { registry } = extensionPointUseCases(CARBON_ROOT).render.execute();
      // `require` throws UnknownExtensionPointError, which already lists every
      // known id — the thing someone who mistyped needs to see.
      const point = registry.require(ctx.first!);

      ctx.io.raw(ctx.io.c.bold(point.id));
      ctx.io.raw("");
      for (const line of point.doc.split("\n")) ctx.io.raw(`  ${line}`);
      ctx.io.raw("");
      ctx.io.raw(`  ${ctx.io.c.dim("symbol")}      ${point.symbol}`);
      ctx.io.raw(`  ${ctx.io.c.dim("since")}       ABI 1.${point.sinceMinor}`);
      ctx.io.raw(`  ${ctx.io.c.dim("stability")}   ${point.stability}`);
      ctx.io.raw(
        `  ${ctx.io.c.dim("arity")}       ${point.arity}${
          point.isExclusive ? " — the loader refuses a second implementor" : ""
        }`,
      );
      ctx.io.raw(
        `  ${ctx.io.c.dim("capability")}  ${point.capability ?? "none — this point only observes"}`,
      );
      ctx.io.raw(`  ${ctx.io.c.dim("dispatch")}    ${point.dispatch}`);

      if (point.params.length > 0) {
        ctx.io.raw("");
        ctx.io.raw(`  ${ctx.io.c.dim("parameters")}`);
        for (const param of point.params) {
          ctx.io.raw(`    ${param.name}: ${param.type.c}`);
          ctx.io.raw(`      ${ctx.io.c.dim(param.doc)}`);
        }
      }

      ctx.io.raw("");
      ctx.io.raw(`  ${ctx.io.c.dim("implement it in Zig")}`);
      for (const line of zigStub(point).split("\n")) ctx.io.raw(`    ${line}`);
      return EXIT_OK;
    });
  }
}

export class ExtCommand extends CommandGroup {
  readonly meta: CommandMeta = {
    name: "ext",
    summary: "The extension surface plugins plug into (generate / check / list / show)",
    usage: "ext <subcommand> [options]",
    examples: ["carbon ext list", "carbon ext show paint.before"],
  };

  readonly subcommands = [
    new GenerateCommand(),
    new CheckExtensionsCommand(),
    new ListExtensionsCommand(),
    new ShowExtensionCommand(),
  ];
}

export default ExtCommand;

// ── Rendering helpers ───────────────────────────────────────────────────────

function groupByArea<T extends { area: string }>(points: readonly T[]): Map<string, T[]> {
  const areas = new Map<string, T[]>();
  for (const point of points) {
    const list = areas.get(point.area) ?? [];
    list.push(point);
    areas.set(point.area, list);
  }
  return areas;
}

/** Enough of a doc to pick a point out of a list, on one line. */
function firstSentence(doc: string): string {
  const flat = doc.replace(/\s+/g, " ").trim();
  const stop = flat.indexOf(". ");
  const sentence = stop < 0 ? flat : flat.slice(0, stop + 1);
  return sentence.length > 72 ? `${sentence.slice(0, 69)}...` : sentence;
}

/**
 * The Zig an author writes to implement this point.
 *
 * Rendered from the same model the C header is, so it cannot disagree with the
 * prototype the compiler will check it against.
 */
function zigStub(point: ExtensionPoint): string {
  const params = [
    "app_raw: *sdk.RawApp",
    ...point.params.map((p) => `${p.name}: ${zigType(p.type.id)}`),
  ];
  const returns = point.returns.id === "void" ? "void" : zigType(point.returns.id);
  const body =
    point.returns.id === "void"
      ? "    const app = sdk.CarbonApp.fromRaw(app_raw);\n    _ = app;"
      : "    const app = sdk.CarbonApp.fromRaw(app_raw);\n    _ = app;\n    return sdk.CARBON_OK;";

  return `export fn ${point.symbol}(${params.join(", ")}) callconv(.C) ${returns} {\n${body}\n}`;
}

function zigType(id: string): string {
  switch (id) {
    case "u32":
      return "u32";
    case "i32":
    case "boolean":
      return "i32";
    case "str":
      return "[*:0]const u8";
    case "bytes_mut":
      return "[*]u8";
    default:
      return "void";
  }
}
