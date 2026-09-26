/**
 * Read the app's own source as syntax, for the tests that keep copy honest.
 *
 * Regexes over lines were how Chinese punctuation got past the first guard: a
 * quoted-string pattern cannot see JSX text, and a comment stripper cannot tell
 * a `//` inside a URL from a comment. The compiler can. Test-only — nothing in
 * the app imports this.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

export const SRC = join(__dirname, '..')

/** Every component, adapter and worker, relative to src/ — not tests, not the catalogues. */
export function productSources(dir = SRC, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && full !== join(SRC, 'i18n')) productSources(full, found)
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) &&
               !entry.endsWith('.d.ts')) {
      found.push(full)
    }
  }
  return found
}

export function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest,
    true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

export function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${source.fileName.slice(SRC.length + 1)}:${line + 1}`
}

/** Every piece of literal text the user could be shown: strings, template text, JSX text. */
export function literalText(source: ts.SourceFile): { node: ts.Node; text: string }[] {
  const out: { node: ts.Node; text: string }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push({ node, text: node.text })
    } else if (ts.isJsxText(node)) {
      out.push({ node, text: node.getText(source) })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Calls to `t` / `tf` that run when the module loads rather than when it renders. */
export function moduleScopeTranslations(source: ts.SourceFile): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const visit = (node: ts.Node, deferred: boolean) => {
    const inside = deferred || ts.isFunctionLike(node) || ts.isClassLike(node)
    if (!inside && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        (node.expression.text === 't' || node.expression.text === 'tf')) {
      out.push(node)
    }
    ts.forEachChild(node, (child) => visit(child, inside))
  }
  visit(source, false)
  return out
}
