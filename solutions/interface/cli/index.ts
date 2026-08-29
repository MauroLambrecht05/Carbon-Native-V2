// The CLI's command framework — presentation.
//
// This lives in the product, not in solutions/, and the distinction is worth
// stating because it is the one the layering hinges on.
//
// Infrastructure in a solution holds *driven* adapters: things the use cases
// call outward to — a filesystem, a process, a key format, an object store.
// Those are interchangeable, and the solution owns the interface.
//
// A command line is a *driving* adapter: it is how a human reaches in. It is
// also the product's entire reason to exist — carbon-cli IS this surface.
// Putting it in solutions/ would mean the toolchain shipped a user interface,
// and every other product would inherit a CLI it never asked for.
//
// So: what the toolchain does is a solution; how a developer asks for it is
// the product.

export {
  Command, CommandGroup, EXIT_OK, EXIT_FAILURE, EXIT_USAGE,
  type CommandMeta, type ExitCode,
} from "./kernel/command.ts";
export { CommandContext, type CommandContextInit } from "./kernel/command-context.ts";
export { Flags, parseArgv, type FlagSpec, type ParsedArgv } from "./dispatch/flags.ts";
export {
  CommandRegistry, defineCommand,
  type CommandDescriptor, type CommandLoader,
} from "./dispatch/command-registry.ts";
export type { Io, Wizard, SelectOption } from "./ports/io-port.ts";
export type { HelpPresenter } from "./ports/help-presenter.ts";
export { Dispatcher, type DispatcherOptions } from "./dispatch/dispatcher.ts";
export { HelpRenderer, isCommandGroup } from "./adapters/help.ts";
export { consoleIo, BufferedIo } from "./adapters/console-io.ts";
