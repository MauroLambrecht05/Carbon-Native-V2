// @carbon/ts-plugin — TypeScript Language Service plugin (plain JS so
// the TS server can `require()` it without a build step).
//
// Editors using the project TypeScript server (VS Code, WebStorm, Cursor,
// etc.) load this plugin via tsconfig.json's `compilerOptions.plugins`.
// We intercept the TS server's source-snapshot read for each file and
// strip carbon-mini's `@CarbonApp` directive before TS parses, so the
// editor never sees the invalid syntax.
//
// The same transform runs at build time in cli/src/carbon-app-decorator.ts
// — editor and build see identical post-transform source.

"use strict";

/**
 * @param {string} src
 * @returns {string}
 */
function transform(src) {
  // Match a top-level @CarbonApp directive followed by either
  //   function MyApp(...) { ... }
  // or
  //   const MyApp = () => { ... }
  var fnRe =
    /^[ \t]*@CarbonApp[ \t]*\r?\n[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?function[ \t]+([A-Za-z_$][\w$]*)/m;
  var constRe =
    /^[ \t]*@CarbonApp[ \t]*\r?\n[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)\b/m;

  var m = fnRe.exec(src) || constRe.exec(src);
  if (!m) return src;

  var entryName = m[1];
  var stripped = src.replace(/^[ \t]*@CarbonApp[ \t]*\r?\n/m, "");
  return (
    stripped +
    "\n// auto-injected by @CarbonApp decorator\n" +
    'import { mount as __carbon_mount__ } from "@carbon/mini-solid";\n' +
    "__carbon_mount__(() => <" +
    entryName +
    " />);\n"
  );
}

/**
 * Plugin factory. TypeScript calls this with `{ typescript }` and we
 * return `{ create(info) -> LanguageService }`. We wrap the host's
 * getScriptSnapshot so the version of source TS sees is always the
 * post-transform code.
 */
// Init — invoked once by TS server when our plugin is loaded. We
// log to BOTH the projectService.logger AND stderr so the user can
// confirm via "TypeScript: Open TS Server log" that the plugin
// actually got picked up.
function logEverywhere(info, msg) {
  try {
    if (info && info.project && info.project.projectService) {
      info.project.projectService.logger.info("[@carbon/ts-plugin] " + msg);
    }
  } catch (_e) {
    /* logger may not be available */
  }
  try {
    // stderr as a fallback: visible in TS server log even when the
    // logger above isn't wired up (some VS Code TS server modes).
    process.stderr.write("[@carbon/ts-plugin] " + msg + "\n");
  } catch (_e) {
    /* process may be sandboxed */
  }
}

function init(modules) {
  var ts = modules.typescript;
  // Loud load-time signal so the user can grep for it.
  try {
    process.stderr.write(
      "[@carbon/ts-plugin] init() called — plugin module loaded by TS server\n",
    );
  } catch (_e) {}

  function create(info) {
    logEverywhere(
      info,
      "create() called — wiring getScriptSnapshot for @CarbonApp stripping",
    );

    var host = info.languageServiceHost;
    var origGetScriptSnapshot = host.getScriptSnapshot.bind(host);
    var origGetScriptVersion = host.getScriptVersion.bind(host);

    // Cache so we don't re-transform on every TS request — the server
    // calls getScriptSnapshot many times per keystroke. Keyed by
    // (filename, source-version) so an edit invalidates the entry.
    var cache = new Map();

    host.getScriptSnapshot = function (fileName) {
      var original = origGetScriptSnapshot(fileName);
      if (!original) return original;

      // Only consider user .ts/.tsx/.js/.jsx; never .d.ts or anything
      // inside node_modules.
      if (!/\.(tsx|ts|jsx|js)$/.test(fileName)) return original;
      if (fileName.indexOf("node_modules") !== -1) return original;
      if (/\.d\.ts$/.test(fileName)) return original;

      var ver = origGetScriptVersion(fileName);
      var cached = cache.get(fileName);
      if (cached && cached.ver === ver) return cached.snap;

      var text = original.getText(0, original.getLength());
      var transformed = transform(text);

      // No directive — pass the original through (avoids burning
      // memory on every file in the workspace).
      if (transformed === text) {
        cache.set(fileName, { ver: ver, snap: original });
        return original;
      }

      var snap = ts.ScriptSnapshot.fromString(transformed);
      cache.set(fileName, { ver: ver, snap: snap });
      return snap;
    };

    return info.languageService;
  }

  return { create: create };
}

module.exports = init;
