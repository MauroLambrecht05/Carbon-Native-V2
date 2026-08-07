// carbon-app-decorator — pre-processor for `.csx` (Carbon Solid eXtended)
// entry files. It recognizes a top-level `@CarbonApp` directive on a
// function declaration and rewrites the source into a normal TSX
// module that the rest of the build pipeline can swallow.
//
// `.csx` is intentionally NOT a TypeScript file so editors don't
// reject the directive as invalid syntax. The init template configures
// VS Code to treat `.csx` as plain text (no type-checker, no parser
// errors). Inside a `.csx` file the user writes whatever directive
// syntax we want — currently just `@CarbonApp` — and we take care of
// turning it into something Bun + Babel + Solid can consume.

export interface CarbonAppDecoratorResult {
  code: string;
  /** Name of the decorated entry component, or null if no @CarbonApp
   *  was found. The build pipeline uses null as a signal that the file
   *  doesn't need rewriting. */
  entry: string | null;
}

export function transformCarbonAppDecorator(src: string): CarbonAppDecoratorResult {
  // @CarbonApp ↦ function MyApp(...) { ... }
  // @CarbonApp ↦ const  MyApp = () => { ... }
  const fnRe =
    /^[ \t]*@CarbonApp[ \t]*\r?\n[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?function[ \t]+([A-Za-z_$][\w$]*)/m;
  const constRe =
    /^[ \t]*@CarbonApp[ \t]*\r?\n[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)\b/m;

  const m = fnRe.exec(src) ?? constRe.exec(src);
  if (!m) {
    return { code: src, entry: null };
  }

  const entryName = m[1];
  const stripped = src.replace(/^[ \t]*@CarbonApp[ \t]*\r?\n/m, "");

  // Append a mount call. We use JSX so the Solid preset (phase 2)
  // emits a createComponent call.
  const epilogue = `

// auto-injected by @CarbonApp decorator
import { mount as __carbon_mount__ } from "@carbon/mini-solid";
__carbon_mount__(() => <${entryName} />);
`;

  return { code: stripped + epilogue, entry: entryName };
}
