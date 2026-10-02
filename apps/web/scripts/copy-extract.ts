// Extracts user-visible copy from the web app's sources for the copy rules (Overview §10): JSX text,
// string literals and template text, minus non-prose positions (module specifiers, literal types,
// property names, technical JSX attributes such as className / href / role, class-name helpers).
// The shared checkCopy() then runs over the extracted prose only.
import { type CopyViolation, checkCopy } from "@bookrunner/shared/copy";
import ts from "typescript";

export interface CopySnippet {
  file: string;
  line: number;
  text: string;
}

export interface FileViolation extends CopyViolation {
  file: string;
}

/** JSX attributes whose values are never shown to a reader. */
const TECHNICAL_ATTRS = new Set([
  "className",
  "class",
  "id",
  "key",
  "htmlFor",
  "type",
  "href",
  "src",
  "rel",
  "target",
  "role",
  "inputMode",
  "autoComplete",
  "name",
  "value",
  "method",
  "action",
  "d",
  "viewBox",
  "fill",
  "stroke",
  "strokeWidth",
  "strokeDasharray",
  "strokeLinejoin",
  "strokeLinecap",
  "vectorEffect",
  "preserveAspectRatio",
  "dataKey",
  "stackId",
  "scale",
  "tone",
  "kind",
  "size",
  "mode",
  "to",
  "aria-current",
  "aria-haspopup",
  "aria-hidden",
]);

/** Calls whose string arguments are class names or keys, not prose. */
const TECHNICAL_CALLS = new Set(["cx", "clsx", "querySelector", "getElementById", "getItem", "setItem", "removeItem", "addEventListener", "removeEventListener", "includes", "startsWith", "endsWith", "get", "has"]);

function isNonProse(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === node) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isJsxAttribute(p)) {
    const n = p.name.getText();
    return TECHNICAL_ATTRS.has(n) || n.startsWith("data-");
  }
  if (ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) {
    const n = p.parent.name.getText();
    return TECHNICAL_ATTRS.has(n) || n.startsWith("data-");
  }
  if (ts.isCallExpression(p) && p.arguments.includes(node as ts.Expression)) {
    const callee = p.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (TECHNICAL_CALLS.has(name)) return true;
  }
  // comparisons against string keys (`x === "target"`) are not prose
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
  if (ts.isCaseClause(p) && p.expression === node) return true;
  return false;
}

/** Visible copy of one TS / TSX source. */
export function extractCopy(source: string, file = "inline.tsx"): CopySnippet[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: CopySnippet[] = [];
  const push = (node: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return;
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: t });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) push(node, node.text);
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isNonProse(node)) push(node, node.text);
    else if (ts.isTemplateExpression(node) && !isNonProse(node)) {
      push(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" … "));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Visible copy of an HTML file: <title>, meta content, text nodes (scripts and styles removed). */
export function extractHtmlCopy(html: string, file = "index.html"): CopySnippet[] {
  const out: CopySnippet[] = [];
  // blank out script / style bodies (and comments) but keep newlines so line numbers stay right
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  const cleaned = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank);
  cleaned.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    const metas = [...line.matchAll(/\b(?:content|title|alt|aria-label)="([^"]*)"/gi)].map((m) => m[1] ?? "");
    line = line.replace(/<[^>]*>/g, " ");
    for (const t of [...metas, line]) {
      const s = t.replace(/\s+/g, " ").trim();
      if (s) out.push({ file, line: i + 1, text: s });
    }
  });
  return out;
}

export function checkSnippets(snippets: CopySnippet[]): FileViolation[] {
  const out: FileViolation[] = [];
  for (const s of snippets) {
    for (const v of checkCopy(s.text)) out.push({ ...v, file: s.file, line: s.line });
  }
  return out;
}
