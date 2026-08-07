// carbon signer — Ed25519 signing and key management.
//
// Modelled as a CommandGroup with one class per subcommand, rather than the
// switch-plus-hand-written-help-string the ported V1 version used. The payoff
// is not tidiness: each subcommand now declares its own flags, so
// `carbon help signer` lists them and the flag parser knows which take values,
// instead of every subcommand re-implementing argument scanning.
//
// V1 shelled out to `${VENDOR_DIR}/carbon-signer`, a binary the repository
// never built (tools/signer declared only a `[lib]` target), so every
// subcommand failed with ENOENT on a clean checkout. This calls @carbon/signer
// in-process.

import { homedir } from "node:os";
import { join } from "node:path";
import { generate, signFile, verifyFile, rotate, type Purpose } from "@carbon/signing";
import {
  Command,
  CommandGroup,
  EXIT_OK,
  EXIT_USAGE,
  type CommandMeta,
  type ExitCode,
} from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";

/** Where `generate` puts keys when --out is not given. */
const DEFAULT_KEY_DIR = join(homedir(), ".carbon", "keys");

const PASSWORD_FLAG = {
  name: "password",
  placeholder: "<pw>",
  description: "Key password; else $CARBON_SIGNER_PASSWORD, else prompt",
} as const;

/**
 * Resolves the key password.
 *
 * Order matters: an explicit --password wins, then the environment (how CI
 * supplies it), then an interactive prompt. The prompt is last because a
 * non-interactive run must fail loudly rather than block forever on a stdin
 * that will never produce anything.
 */
async function resolvePassword(ctx: CommandContext, purpose: string): Promise<string> {
  const explicit = ctx.flags.get("password");
  if (explicit !== undefined) return explicit;

  const fromEnv = process.env.CARBON_SIGNER_PASSWORD;
  if (fromEnv !== undefined) return fromEnv;

  if (!process.stdin.isTTY) {
    throw new Error(
      "no password available: pass --password, or set CARBON_SIGNER_PASSWORD, or run interactively",
    );
  }

  process.stdout.write(`${purpose}: `);
  for await (const line of console) return line;
  return "";
}

class GenerateKeyCommand extends Command {
  readonly meta: CommandMeta = {
    name: "generate",
    summary: "Generate a new keypair",
    usage: "signer generate --name <name> [--out <dir>]",
    flags: [
      { name: "name", placeholder: "<name>", description: "Name for the keypair" },
      { name: "out", placeholder: "<dir>", description: `Output directory (default: ${DEFAULT_KEY_DIR})` },
      PASSWORD_FLAG,
    ],
    examples: ["carbon signer generate --name myapp"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.flags.get("name") ? null : "--name is required";
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const name = ctx.flags.get("name")!;
    const outDir = ctx.flags.get("out") ?? DEFAULT_KEY_DIR;
    const password = await resolvePassword(ctx, "new key password");

    const { verifyingKey, pubkeyPath, seckeyPath } = generate(name, password, outDir);

    ctx.io.success(`generated keypair ${ctx.io.c.bold(name)}`);
    ctx.io.step(`public key:  ${pubkeyPath}`);
    ctx.io.step(`secret key:  ${seckeyPath}`);
    ctx.io.raw("");
    ctx.io.raw("Add this to your carbon.toml so the updater trusts releases you sign:");
    ctx.io.raw("");
    ctx.io.raw(`  ${ctx.io.c.dim("[updater]")}`);
    ctx.io.raw(`  ${ctx.io.c.dim(`pubkey = "${verifyingKey.toBase64()}"`)}`);
    ctx.io.raw("");
    return EXIT_OK;
  }
}

class SignFileCommand extends Command {
  readonly meta: CommandMeta = {
    name: "sign",
    summary: "Sign a file with your private key",
    usage: "signer sign <file> --key <path> [--purpose app|plugin]",
    flags: [
      { name: "key", placeholder: "<path>", description: "Private key file" },
      { name: "purpose", placeholder: "app|plugin", description: "Purpose of the signature", default: "app" },
      PASSWORD_FLAG,
    ],
    examples: ["carbon signer sign bundle.bin --key myapp.key"],
  };

  validate(ctx: CommandContext): string | null {
    if (!ctx.first) return "a file to sign is required";
    if (!ctx.flags.get("key")) return "--key is required";
    const purpose = ctx.flags.get("purpose", "app");
    if (purpose !== "app" && purpose !== "plugin") {
      return `--purpose must be "app" or "plugin", got ${purpose}`;
    }
    return null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const file = ctx.first!;
    const password = await resolvePassword(ctx, "key password");
    const sigPath = signFile(
      file,
      ctx.flags.get("key")!,
      password,
      ctx.flags.get("purpose", "app") as Purpose,
    );

    ctx.io.success(`signed ${file}`);
    ctx.io.step(`signature: ${sigPath}`);
    return EXIT_OK;
  }
}

class VerifyFileCommand extends Command {
  readonly meta: CommandMeta = {
    name: "verify",
    summary: "Verify a file signature",
    usage: "signer verify <file> --pubkey <path> [--sig <path>]",
    flags: [
      { name: "pubkey", placeholder: "<path>", description: "Public key file" },
      { name: "sig", placeholder: "<path>", description: "Signature file (default: <file>.sig)" },
    ],
    examples: ["carbon signer verify bundle.bin --pubkey myapp.pub"],
  };

  validate(ctx: CommandContext): string | null {
    if (!ctx.first) return "a file to verify is required";
    if (!ctx.flags.get("pubkey")) return "--pubkey is required";
    return null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const file = ctx.first!;
    // Signatures land beside the file they cover, so --sig only needs giving
    // when the .sig has been moved.
    const sigPath = ctx.flags.get("sig") ?? `${file}.sig`;

    verifyFile(file, sigPath, ctx.flags.get("pubkey")!);
    ctx.io.success(`signature valid: ${file}`);
    return EXIT_OK;
  }
}

class RotateKeyCommand extends Command {
  readonly meta: CommandMeta = {
    name: "rotate",
    summary: "Rotate your keypair, cross-signing the new key with the old",
    usage: "signer rotate --key <path> [--out <dir>] [--new-password <pw>]",
    flags: [
      { name: "key", placeholder: "<path>", description: "Current private key file" },
      { name: "out", placeholder: "<dir>", description: `Output directory (default: ${DEFAULT_KEY_DIR})` },
      { name: "new-password", placeholder: "<pw>", description: "Password for the new key (default: reuse)" },
      PASSWORD_FLAG,
    ],
    examples: ["carbon signer rotate --key myapp.key"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.flags.get("key") ? null : "--key is required";
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const outDir = ctx.flags.get("out") ?? DEFAULT_KEY_DIR;
    const oldPassword = await resolvePassword(ctx, "current key password");
    const newPassword = ctx.flags.get("new-password") ?? oldPassword;

    // NOTE: rotate writes the new keypair under the OLD key's basename, so
    // when --out is the key's own directory it overwrites the outgoing secret
    // key — which you still need for the validity window. Inherited from V1.
    const keyring = rotate(ctx.flags.get("key")!, oldPassword, outDir, newPassword);

    ctx.io.success("rotated keypair");
    ctx.io.raw("");
    ctx.io.raw("New keyring entry — publish this with your next release:");
    ctx.io.raw("");
    ctx.io.raw(JSON.stringify(keyring, null, 2));
    ctx.io.raw("");
    return EXIT_OK;
  }
}

export class SignerCommand extends CommandGroup {
  readonly meta: CommandMeta = {
    name: "signer",
    summary: "Ed25519 signing and key management",
    usage: "signer <subcommand> [options]",
  };

  readonly subcommands = [
    new GenerateKeyCommand(),
    new SignFileCommand(),
    new VerifyFileCommand(),
    new RotateKeyCommand(),
  ];
}

export default SignerCommand;
export { EXIT_USAGE };
