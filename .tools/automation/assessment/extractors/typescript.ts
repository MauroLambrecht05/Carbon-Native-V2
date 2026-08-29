/**
 * TypeScript / TSX Extractor
 *
 * Uses @babel/parser to build an AST, then walks it extracting:
 *   - All exports (functions, classes, interfaces, types, consts)
 *   - All imports and their symbols
 *   - All meaningful conditional logic (if/switch/ternary)
 *   - Error handling patterns (try/catch, throw)
 *   - Validation patterns (early returns, guard clauses)
 *   - External calls (fetch, http clients, DB calls, webhooks)
 *   - Configuration/env accesses
 *   - JSDoc comments on exported items
 */

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
// @ts-ignore — babel traverse has a weird default export
const traverse = (_traverse as any).default ?? _traverse;
import * as t from "@babel/types";
import { readFileSync } from "fs";
import type {
  RawFileExtraction,
  RawApiItem,
  RawCondition,
  RawDependency,
  RawErrorPattern,
  RawValidation,
  RawConfigAccess,
  RawExternalCall,
  SourceEvidence,
  Language,
} from "../stages/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loc(node: t.Node, file: string): SourceEvidence {
  return {
    file,
    lineStart: node.loc?.start.line,
    lineEnd:   node.loc?.end.line,
    extractedBy: "typescript-extractor",
  };
}

function nodeToText(node: t.Node | null | undefined): string {
  if (!node) return "";
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node)) return `"${node.value}"`;
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isBooleanLiteral(node)) return String(node.value);
  if (t.isNullLiteral(node)) return "null";
  if (t.isTemplateLiteral(node)) return "`...`";
  if (t.isMemberExpression(node)) {
    return `${nodeToText(node.object)}.${nodeToText(node.property)}`;
  }
  if (t.isBinaryExpression(node)) {
    return `${nodeToText(node.left)} ${node.operator} ${nodeToText(node.right)}`;
  }
  if (t.isUnaryExpression(node)) {
    return `${node.operator}${nodeToText(node.argument)}`;
  }
  if (t.isLogicalExpression(node)) {
    return `${nodeToText(node.left)} ${node.operator} ${nodeToText(node.right)}`;
  }
  if (t.isCallExpression(node)) {
    return `${nodeToText(node.callee)}(...)`;
  }
  if (t.isOptionalMemberExpression(node)) {
    return `${nodeToText(node.object)}?.${nodeToText(node.property)}`;
  }
  if (t.isOptionalCallExpression(node)) {
    return `${nodeToText(node.callee)}?.(...)`;
  }
  if (t.isAwaitExpression(node)) return `await ${nodeToText(node.argument)}`;
  if (t.isTypeofTypeAnnotation && t.isTSTypeQuery) return "";
  return node.type;
}

function extractConditionText(test: t.Expression | t.PrivateName | null | undefined): string {
  if (!test) return "unknown";
  return nodeToText(test);
}

function extractStatementSummary(stmt: t.Statement | null | undefined): string {
  if (!stmt) return "nothing";
  if (t.isReturnStatement(stmt)) {
    if (!stmt.argument) return "return";
    return `return ${nodeToText(stmt.argument)}`;
  }
  if (t.isThrowStatement(stmt)) {
    return `throw ${nodeToText(stmt.argument)}`;
  }
  if (t.isExpressionStatement(stmt)) {
    return nodeToText(stmt.expression);
  }
  if (t.isBlockStatement(stmt)) {
    if (stmt.body.length === 0) return "{}";
    if (stmt.body.length === 1) return extractStatementSummary(stmt.body[0]);
    return `{ ${stmt.body.length} statements }`;
  }
  if (t.isIfStatement(stmt)) return "if(...)";
  return stmt.type;
}

function isValidationOrGuard(condition: string, trueAction: string): boolean {
  const validationKeywords = ["throw", "return", "reject", "error", "Error", "logout", "deny", "invalid", "fail"];
  return validationKeywords.some(kw => trueAction.toLowerCase().includes(kw.toLowerCase()));
}

function detectExternalCallTarget(node: t.CallExpression): { target: string; kind: RawExternalCall["kind"] } | null {
  const callee = nodeToText(node.callee);

  // fetch calls
  if (callee === "fetch" || callee.endsWith(".fetch")) {
    const firstArg = node.arguments[0];
    const url = firstArg ? nodeToText(firstArg) : "unknown";
    return { target: url, kind: "http" };
  }
  // axios/got/ky
  if (callee.includes("axios") || callee.includes(".get(") || callee.includes(".post(")) {
    return { target: callee, kind: "http" };
  }
  // Discord webhook
  if (callee.includes("discord") || callee.includes("webhook") || callee.includes("Discord")) {
    return { target: callee, kind: "discord" };
  }
  // S3 / AWS
  if (callee.includes("s3") || callee.includes("S3") || callee.includes("AWS") || callee.includes("aws")) {
    return { target: callee, kind: "s3" };
  }
  // IPC
  if (callee.includes("ipc") || callee.includes("IPC") || callee.includes("invoke")) {
    return { target: callee, kind: "ipc" };
  }
  // File system
  if (callee.includes("readFile") || callee.includes("writeFile") || callee.includes("fs.") || callee.includes("Bun.file")) {
    return { target: callee, kind: "file" };
  }
  // Database
  if (callee.includes("query") || callee.includes("execute") || callee.includes("db.") || callee.includes("pool.")) {
    return { target: callee, kind: "db" };
  }
  return null;
}

function detectConfigAccess(node: t.MemberExpression | t.CallExpression, file: string): RawConfigAccess | null {
  const text = nodeToText(node);

  // process.env.SOMETHING
  if (text.startsWith("process.env.")) {
    const key = text.slice("process.env.".length).replace(/['"]/g, "");
    return { key, kind: "env-var", evidence: loc(node, file) };
  }
  // Bun.env.SOMETHING
  if (text.startsWith("Bun.env.")) {
    const key = text.slice("Bun.env.".length).replace(/['"]/g, "");
    return { key, kind: "env-var", evidence: loc(node, file) };
  }
  // import.meta.env
  if (text.startsWith("import.meta.env")) {
    return { key: text, kind: "env-var", evidence: loc(node, file) };
  }
  return null;
}

// ─── Main Extractor ───────────────────────────────────────────────────────────

export function extractTypeScript(filePath: string, relPath: string): RawFileExtraction {
  const result: RawFileExtraction = {
    file: relPath,
    language: "typescript",
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

  let ast: t.File;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: [
        "typescript",
        "jsx",
        "decorators",
        ["decorators", { decoratorsBeforeExport: true }],
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "exportDefaultFrom",
        "exportNamespaceFrom",
        "dynamicImport",
        "nullishCoalescingOperator",
        "optionalChaining",
        "logicalAssignment",
        "numericSeparator",
        "topLevelAwait",
      ],
      strictMode: false,
      errorRecovery: true,
    });
  } catch (e: any) {
    result.extractionErrors.push(`Parse error: ${e.message}`);
    return result;
  }

  const lines = source.split("\n");

  function getSnippet(startLine: number, endLine: number): string {
    return lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n");
  }

  // ── Walk AST ──────────────────────────────────────────────────────────────

  traverse(ast, {
    // ── Imports ────────────────────────────────────────────────────────────
    ImportDeclaration(path: any) {
      const node: t.ImportDeclaration = path.node;
      const symbols = node.specifiers.map((s: any) => {
        if (t.isImportDefaultSpecifier(s)) return `default as ${s.local.name}`;
        if (t.isImportNamespaceSpecifier(s)) return `* as ${s.local.name}`;
        if (t.isImportSpecifier(s)) {
          const imported = t.isIdentifier(s.imported) ? s.imported.name : (s.imported as any).value;
          return imported !== s.local.name ? `${imported} as ${s.local.name}` : imported;
        }
        return s.local?.name ?? "?";
      });
      result.dependencies.push({
        from: relPath,
        to:   node.source.value,
        kind: "import",
        symbols: symbols.filter(Boolean),
        evidence: loc(node, relPath),
      });
    },

    // Dynamic imports
    CallExpression(path: any) {
      const node: t.CallExpression = path.node;

      if (t.isImport(node.callee)) {
        const arg = node.arguments[0];
        if (arg && t.isStringLiteral(arg)) {
          result.dependencies.push({
            from: relPath,
            to:   arg.value,
            kind: "dynamic-import",
            evidence: loc(node, relPath),
          });
        }
        return;
      }

      // External calls
      const extCall = detectExternalCallTarget(node);
      if (extCall) {
        result.externalCalls.push({
          ...extCall,
          async: path.findParent((p: any) => p.isAwaitExpression()) !== null,
          evidence: loc(node, relPath),
        });
      }

      // Config access via function call
      const cfgAccess = detectConfigAccess(node, relPath);
      if (cfgAccess) result.configAccesses.push(cfgAccess);
    },

    MemberExpression(path: any) {
      const node: t.MemberExpression = path.node;
      const cfgAccess = detectConfigAccess(node, relPath);
      if (cfgAccess) result.configAccesses.push(cfgAccess);
    },

    // ── Exported symbols ────────────────────────────────────────────────────
    ExportNamedDeclaration(path: any) {
      const node: t.ExportNamedDeclaration = path.node;
      if (!node.declaration) return;

      const decl = node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) {
        result.symbols.push({
          name: decl.id.name,
          kind: "function",
          exported: true,
          async: decl.async,
          params: decl.params.map(p => t.isIdentifier(p) ? p.name : "..."),
          evidence: loc(decl, relPath),
        });
      } else if (t.isClassDeclaration(decl) && decl.id) {
        result.symbols.push({
          name: decl.id.name,
          kind: "class",
          exported: true,
          evidence: loc(decl, relPath),
        });
      } else if (t.isTSTypeAliasDeclaration(decl)) {
        result.symbols.push({
          name: decl.id.name,
          kind: "type",
          exported: true,
          evidence: loc(decl, relPath),
        });
      } else if (t.isTSInterfaceDeclaration(decl)) {
        result.symbols.push({
          name: decl.id.name,
          kind: "interface",
          exported: true,
          evidence: loc(decl, relPath),
        });
      } else if (t.isTSEnumDeclaration(decl)) {
        result.symbols.push({
          name: decl.id.name,
          kind: "enum",
          exported: true,
          evidence: loc(decl, relPath),
        });
      } else if (t.isVariableDeclaration(decl)) {
        for (const declarator of decl.declarations) {
          if (t.isIdentifier(declarator.id)) {
            const isFunc = t.isArrowFunctionExpression(declarator.init) || t.isFunctionExpression(declarator.init);
            result.symbols.push({
              name: declarator.id.name,
              kind: isFunc ? "function" : "const",
              exported: true,
              async: isFunc && (declarator.init as any)?.async,
              evidence: loc(declarator, relPath),
            });
          }
        }
      }
    },

    ExportDefaultDeclaration(path: any) {
      const node: t.ExportDefaultDeclaration = path.node;
      const decl = node.declaration;
      if (t.isFunctionDeclaration(decl)) {
        result.symbols.push({
          name: decl.id?.name ?? "default",
          kind: "function",
          exported: true,
          async: decl.async,
          evidence: loc(decl, relPath),
        });
      } else if (t.isClassDeclaration(decl) && decl.id) {
        result.symbols.push({
          name: decl.id.name,
          kind: "class",
          exported: true,
          evidence: loc(decl, relPath),
        });
      }
    },

    // ── Conditional logic ──────────────────────────────────────────────────
    IfStatement(path: any) {
      const node: t.IfStatement = path.node;
      // Only extract top-level ifs inside functions/methods (skip nested ones that will be captured as nested)
      const parent = path.parent;
      const isNestedIf = t.isIfStatement(parent) || t.isElseStatement?.(parent);

      const condition = extractConditionText(node.test);
      const trueAction = extractStatementSummary(node.consequent);
      const falseAction = node.alternate ? extractStatementSummary(node.alternate) : undefined;

      const evidence: SourceEvidence = {
        file: relPath,
        lineStart: node.loc?.start.line,
        lineEnd:   node.loc?.end.line,
        snippet:   getSnippet(node.loc?.start.line ?? 1, Math.min((node.loc?.end.line ?? 1), (node.loc?.start.line ?? 1) + 8)),
        extractedBy: "typescript-extractor",
      };

      // Determine context: enclosing function name
      let context = relPath;
      const funcPath = path.getFunctionParent();
      if (funcPath) {
        const funcNode = funcPath.node;
        if (t.isFunctionDeclaration(funcNode) && funcNode.id) context = funcNode.id.name;
        else if (t.isObjectMethod(funcNode) && t.isIdentifier(funcNode.key)) context = funcNode.key.name;
        else if (t.isClassMethod(funcNode) && t.isIdentifier(funcNode.key)) context = funcNode.key.name;
        else if (t.isArrowFunctionExpression(funcNode)) {
          const varParent = funcPath.parent;
          if (t.isVariableDeclarator(varParent) && t.isIdentifier(varParent.id)) {
            context = varParent.id.name;
          }
        }
      }

      const rawCondition: RawCondition = {
        condition,
        trueAction,
        falseAction,
        context,
        evidence,
      };

      result.conditions.push(rawCondition);

      // Extract as validation if the action is an early return/throw
      if (isValidationOrGuard(condition, trueAction)) {
        result.validations.push({
          subject: condition,
          condition,
          outcome: trueAction,
          evidence,
        });
      }
    },

    // ── Error handling ─────────────────────────────────────────────────────
    TryStatement(path: any) {
      const node: t.TryStatement = path.node;
      const catchClause = node.handler;
      const errorType = catchClause?.param
        ? (t.isIdentifier(catchClause.param) ? catchClause.param.name : "error")
        : undefined;

      const catchBody = catchClause?.body?.body ?? [];
      const hasRetry = catchBody.some(s => extractStatementSummary(s).includes("retry") || extractStatementSummary(s).includes("attempt"));
      const hasFallback = catchBody.some(s => extractStatementSummary(s).includes("fallback") || extractStatementSummary(s).includes("default"));

      result.errors.push({
        kind: "try-catch",
        errorType,
        handlingCode: catchBody.map(s => extractStatementSummary(s)).join("; "),
        hasRetry,
        hasFallback,
        evidence: loc(node, relPath),
      });
    },

    ThrowStatement(path: any) {
      const node: t.ThrowStatement = path.node;
      let errorType = "Error";
      if (t.isNewExpression(node.argument) && t.isIdentifier(node.argument.callee)) {
        errorType = node.argument.callee.name;
      }
      result.errors.push({
        kind: "throw",
        errorType,
        evidence: loc(node, relPath),
      });
    },

    // ── Comments ────────────────────────────────────────────────────────────
    enter(path: any) {
      const node = path.node;
      const comments = (node.leadingComments ?? []) as Array<{ value: string }>;
      for (const c of comments) {
        const text = c.value.trim();
        if (text.startsWith("*") || text.startsWith("/")) {
          const cleaned = text.replace(/^\*+\s*/gm, "").replace(/^\/+\s*/gm, "").trim();
          if (cleaned.length > 10) result.comments.push(cleaned);
        }
      }
    },
  });

  return result;
}
