/**
 * Rust Extractor
 *
 * Uses regex-based parsing (not a full AST) to extract semantically meaningful
 * information from Rust source files:
 *   - Public functions, structs, enums, traits, impls
 *   - if/match/unwrap/expect patterns (conditional logic and error handling)
 *   - Result/Option patterns (? operator, unwrap, expect, map_err, ok_or)
 *   - Panic conditions
 *   - Feature flag gates (#[cfg(feature = ...)])
 *   - Environment variable accesses
 *   - FFI boundaries (extern "C", #[no_mangle])
 *   - Async functions
 */

import { readFileSync } from "fs";
import type {
  RawFileExtraction,
  RawApiItem,
  RawCondition,
  RawErrorPattern,
  RawValidation,
  RawConfigAccess,
  SourceEvidence,
} from "../stages/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ev(file: string, lineStart: number, lineEnd?: number, snippet?: string): SourceEvidence {
  return { file, lineStart, lineEnd: lineEnd ?? lineStart, snippet, extractedBy: "rust-extractor" };
}

// ─── Main Extractor ───────────────────────────────────────────────────────────

export function extractRust(filePath: string, relPath: string): RawFileExtraction {
  const result: RawFileExtraction = {
    file: relPath,
    language: "rust",
    symbols: [],
    conditions: [],
    dependencies: [],
    errors: [],
    validations: [],
    configAccesses: [],
    externalCalls: [],
    comments: [],
    extractionErrors: [],
  };

  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (e: any) {
    result.extractionErrors.push(`Cannot read file: ${e.message}`);
    return result;
  }

  const lines = source.split("\n");

  // ── Public items ────────────────────────────────────────────────────────────

  const pubFnRe   = /^(?:\s*#\[(?:no_mangle|export_name)[^\]]*\]\s*)?(\s*pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^{;]+))?/;
  const pubStructRe = /^\s*(pub(?:\s*\([^)]*\))?\s+)?(?:derive)?struct\s+(\w+)/;
  const pubEnumRe   = /^\s*(pub(?:\s*\([^)]*\))?\s+)?enum\s+(\w+)/;
  const pubTraitRe  = /^\s*(pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)/;
  const implRe      = /^\s*impl(?:<[^>]*>)?\s+(\w+)/;
  const useRe       = /^\s*(?:pub\s+)?use\s+([\w::{}, *]+);/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    // Functions
    const fnMatch = line.match(/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/);
    if (fnMatch) {
      const isPublic = line.includes("pub ") || line.includes("pub(");
      const isAsync  = line.includes("async ");
      const isExtern = line.includes("extern ");
      const name     = fnMatch[1]!;
      result.symbols.push({
        name,
        kind: "function",
        exported: isPublic,
        async: isAsync,
        evidence: ev(relPath, lineNum),
      });
    }

    // Structs
    const structMatch = line.match(/(?:pub\s+)?struct\s+(\w+)/);
    if (structMatch) {
      result.symbols.push({
        name: structMatch[1]!,
        kind: "struct",
        exported: line.includes("pub "),
        evidence: ev(relPath, lineNum),
      });
    }

    // Enums
    const enumMatch = line.match(/(?:pub\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      result.symbols.push({
        name: enumMatch[1]!,
        kind: "enum",
        exported: line.includes("pub "),
        evidence: ev(relPath, lineNum),
      });
    }

    // Traits
    const traitMatch = line.match(/(?:pub\s+)?trait\s+(\w+)/);
    if (traitMatch) {
      result.symbols.push({
        name: traitMatch[1]!,
        kind: "trait",
        exported: line.includes("pub "),
        evidence: ev(relPath, lineNum),
      });
    }

    // Use statements
    const useMatch = line.match(/^\s*(?:pub\s+)?use\s+(.+);/);
    if (useMatch) {
      result.dependencies.push({
        from: relPath,
        to: useMatch[1]!.trim(),
        kind: "use",
        evidence: ev(relPath, lineNum),
      });
    }
  }

  // ── Conditional logic ───────────────────────────────────────────────────────

  // if let, if, match arms with meaningful actions
  const ifRe    = /^\s*if\s+(!?[\w.?:()]+(?:\s*==\s*[\w."]+)?(?:\s*&&\s*[\w.?:()]+)?)\s*\{?\s*$/;
  const ifLetRe = /^\s*if\s+let\s+([\w::<>]+)\s*=\s*([\w.?:()]+)/;
  const matchRe = /^\s*match\s+([\w.?:()]+)\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    // if statement
    const ifM = line.match(/^\s*if\s+(.+?)\s*\{?\s*$/);
    if (ifM && !line.trim().startsWith("//")) {
      const condition = ifM[1]!.trim().replace(/\{$/, "").trim();
      // Look ahead for the action
      const nextLine = lines[i + 1] ?? "";
      const trueAction = nextLine.trim().replace(/;$/, "");
      const context = inferContext(lines, i);

      if (condition.length < 120) {
        result.conditions.push({
          condition: humanizeRustCondition(condition),
          trueAction: humanizeRustAction(trueAction),
          context,
          evidence: ev(relPath, lineNum, lineNum + 3, line),
        });

        // Is it a guard/validation?
        if (isGuardAction(trueAction)) {
          result.validations.push({
            subject: condition,
            condition: humanizeRustCondition(condition),
            outcome: humanizeRustAction(trueAction),
            evidence: ev(relPath, lineNum),
          });
        }
      }
    }

    // if let
    const ifLetM = line.match(/^\s*if\s+let\s+(\w+(?:::\w+)?)\s*(?:\(([^)]*)\))?\s*=\s*(.+?)\s*\{/);
    if (ifLetM) {
      const pattern = ifLetM[1]!;
      const value   = ifLetM[3]!.trim();
      const context = inferContext(lines, i);
      result.conditions.push({
        condition: `${value} matches ${pattern}`,
        trueAction: "continue with matched value",
        falseAction: "skip / else branch",
        context,
        evidence: ev(relPath, lineNum),
      });
    }

    // unwrap / expect — these are panic points
    const unwrapM = line.match(/\.unwrap(?:_or(?:_else)?)?\(\)/g);
    const expectM = line.match(/\.expect\("([^"]+)"\)/g);

    if (unwrapM) {
      for (const m of unwrapM) {
        result.errors.push({
          kind: "unwrap",
          handlingCode: line.trim(),
          evidence: ev(relPath, lineNum),
        });
      }
    }

    if (expectM) {
      for (const m of expectM) {
        const msg = m.match(/\.expect\("([^"]+)"\)/)?.[1] ?? "";
        result.errors.push({
          kind: "expect",
          errorType: msg,
          handlingCode: line.trim(),
          evidence: ev(relPath, lineNum),
        });
      }
    }

    // ? operator (question mark propagation)
    if (line.includes("?") && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
      const questionMatches = line.match(/(\w+(?:\.\w+)*)\?/g);
      if (questionMatches && questionMatches.length > 0) {
        result.errors.push({
          kind: "question-mark",
          handlingCode: line.trim(),
          evidence: ev(relPath, lineNum),
        });
      }
    }

    // panic!
    if (line.includes("panic!(")) {
      const msg = line.match(/panic!\("([^"]*)"/)?.[1] ?? "";
      result.errors.push({
        kind: "panic",
        errorType: msg || "explicit panic",
        handlingCode: line.trim(),
        evidence: ev(relPath, lineNum),
      });
    }

    // env::var / std::env
    const envM = line.match(/env::var\("([^"]+)"\)/);
    if (envM) {
      result.configAccesses.push({
        key: envM[1]!,
        kind: "env-var",
        evidence: ev(relPath, lineNum),
      });
    }

    // Feature flags
    const cfgFeatureM = line.match(/#\[cfg\(feature\s*=\s*"([^"]+)"\)\]/);
    if (cfgFeatureM) {
      result.conditions.push({
        condition: `feature "${cfgFeatureM[1]}" is enabled`,
        trueAction: "include following code",
        falseAction: "exclude following code",
        context: "feature-gate",
        evidence: ev(relPath, lineNum),
      });
    }

    // extern "C" / FFI
    if (line.match(/extern\s+"C"/)) {
      result.externalCalls.push({
        target: "C-ABI / FFI boundary",
        kind: "ffi",
        evidence: ev(relPath, lineNum),
      });
    }

    // Doc comments
    if (line.trim().startsWith("///") || line.trim().startsWith("//!")) {
      const text = line.trim().replace(/^\/\/[/!]\s*/, "");
      if (text.length > 5) result.comments.push(text);
    }
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function humanizeRustCondition(cond: string): string {
  return cond
    .replace(/\s*==\s*None/, " is None")
    .replace(/\s*==\s*null/, " is null")
    .replace(/^!/, "not ")
    .replace(/\.is_none\(\)/, " is absent")
    .replace(/\.is_some\(\)/, " is present")
    .replace(/\.is_empty\(\)/, " is empty")
    .replace(/\.is_err\(\)/, " failed")
    .replace(/\.is_ok\(\)/, " succeeded")
    .replace(/\s*==\s*true/, " is true")
    .replace(/\s*==\s*false/, " is false")
    .trim();
}

function humanizeRustAction(action: string): string {
  if (!action) return "continue";
  return action
    .replace(/return\s+Err\(([^)]+)\)/, "return error: $1")
    .replace(/return\s+Ok\(([^)]+)\)/, "return success: $1")
    .replace(/return\s+None/, "return nothing")
    .replace(/panic!\(/, "panic: ")
    .trim();
}

function isGuardAction(action: string): boolean {
  const guardWords = ["return Err", "return None", "panic!", "bail!", "return Err", "reject", "logout", "deny", "fail"];
  return guardWords.some(w => action.includes(w));
}

function inferContext(lines: string[], lineIndex: number): string {
  // Walk backwards to find enclosing function
  for (let i = lineIndex; i >= 0 && i > lineIndex - 30; i--) {
    const line = lines[i] ?? "";
    const fnM = line.match(/fn\s+(\w+)/);
    if (fnM) return fnM[1]!;
    const implM = line.match(/impl\s+(?:<[^>]+>\s+)?(\w+)/);
    if (implM) return implM[1]!;
  }
  return "module-level";
}
