import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')
const CJK = /[一-鿿]/

/**
 * Strings that are Chinese on purpose and must stay that way.
 *
 * A language names itself in its own language, and the score parser matches the
 * words a Chinese-engraved MusicXML part is actually called — neither is
 * interface copy, and translating either would break something.
 */
const DELIBERATE = new Set([
  'features/shell/SettingsDialog.tsx',
  'features/score/hands.ts',
])

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') sourceFiles(full, found)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(full)
    }
  }
  return found
}

/** Strip comments so prose about the product is not mistaken for product copy. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('all product copy lives in the catalogue', () => {
  it('has no Chinese left in components, adapters or workers', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const relative = file.slice(SRC.length + 1)
      if (relative.startsWith('i18n/') || DELIBERATE.has(relative)) continue
      for (const [index, line] of code(readFileSync(file, 'utf8')).split('\n').entries()) {
        // Only quoted text counts; a CJK character elsewhere is not user copy.
        const quoted = line.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? []
        if (quoted.some((literal) => CJK.test(literal))) {
          offenders.push(`${relative}:${index + 1}  ${line.trim()}`)
        }
      }
    }
    expect(offenders, `move these into i18n/zh-Hans.ts and en-US.ts:\n${
      offenders.join('\n')}`).toEqual([])
  })
})
