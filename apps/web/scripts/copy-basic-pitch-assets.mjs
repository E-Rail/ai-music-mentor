import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const publicRoot = new URL('../public/models/', import.meta.url)
const basicPitchRoot = dirname(dirname(require.resolve('@spotify/basic-pitch')))
const wasmRoot = dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json'))
const basicPitchTarget = new URL('basic-pitch/', publicRoot)
const wasmTarget = new URL('tfjs-wasm/', publicRoot)

mkdirSync(basicPitchTarget, { recursive: true })
mkdirSync(wasmTarget, { recursive: true })

for (const name of ['model.json', 'group1-shard1of1.bin']) {
  copyFileSync(join(basicPitchRoot, 'model', name), new URL(name, basicPitchTarget))
}
for (const name of [
  'tfjs-backend-wasm.wasm',
  'tfjs-backend-wasm-simd.wasm',
  'tfjs-backend-wasm-threaded-simd.wasm',
]) {
  copyFileSync(join(wasmRoot, 'dist', name), new URL(name, wasmTarget))
}
