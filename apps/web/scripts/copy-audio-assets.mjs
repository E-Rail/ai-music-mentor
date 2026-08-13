/**
 * Put every model the microphone path needs under `public/models`.
 *
 * Nothing here may be fetched while the app is running. A lesson happens
 * wherever the student's piano is, which is not always somewhere with working
 * wifi, and a 60 MB download in front of an audience is not a risk worth taking.
 *
 * Basic Pitch and the TensorFlow WASM binaries ship inside node_modules, so they
 * are copied. Magenta publishes the Onsets and Frames checkpoint separately, so
 * it is downloaded once and then left alone — the files are gitignored, and a
 * second run costs nothing.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const publicRoot = new URL('../public/models/', import.meta.url)

// --- copied out of node_modules ---------------------------------------------

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

// --- fetched once -----------------------------------------------------------

/**
 * Magenta's `onsets_frames_uni` checkpoint: the unidirectional Onsets and
 * Frames model, the one `@magenta/music` is built to load.
 */
const OAF_SOURCE =
  'https://storage.googleapis.com/magentadata/js/checkpoints/transcription/onsets_frames_uni'
const oafTarget = new URL('onsets-frames/', publicRoot)

/** A truncated shard is worse than a missing one — it fails at inference. */
function alreadyHave(url) {
  return existsSync(url) && statSync(url).size > 0
}

async function download(name) {
  const target = new URL(name, oafTarget)
  if (alreadyHave(target)) return false
  const response = await fetch(`${OAF_SOURCE}/${name}`)
  if (!response.ok) {
    throw new Error(`${name}: ${response.status} ${response.statusText}`)
  }
  // Written aside and moved into place, so an interrupted run cannot leave a
  // half-written shard that looks complete to the next one.
  const staging = new URL(`${name}.partial`, oafTarget)
  await writeFile(staging, Buffer.from(await response.arrayBuffer()))
  renameSync(staging, target)
  return true
}

mkdirSync(oafTarget, { recursive: true })
const manifestName = 'weights_manifest.json'

// A build does not need the weights — they are static files the browser fetches
// at run time, not something Vite bundles. CI therefore skips 60 MB it would
// only throw away, and a machine with no connection can still build.
if (process.env.SKIP_MODEL_DOWNLOAD) {
  console.log('onsets-frames: skipped (SKIP_MODEL_DOWNLOAD)')
  process.exit(0)
}
try {
  await download(manifestName)
  const manifest = require(new URL(manifestName, oafTarget).pathname)
  const shards = manifest.flatMap((group) => group.paths)
  let fetched = 0
  for (const [index, shard] of shards.entries()) {
    // A silent 60 MB download looks like a hung launcher, so it counts itself
    // out loud. Nothing is written on a cached run, which is every run but one.
    if (!alreadyHave(new URL(shard, oafTarget))) {
      process.stdout.write(
        `\r  fetching the piano listening model… ${index + 1}/${shards.length}`)
    }
    if (await download(shard)) fetched += 1
  }
  if (fetched) process.stdout.write('\r'.padEnd(60) + '\r')
  console.log(fetched
    ? `onsets-frames: fetched ${fetched}/${shards.length} shards`
    : `onsets-frames: ${shards.length} shards already present`)
} catch (error) {
  // The other engine still works, and a build should not fail because a model
  // host was unreachable. Say so loudly rather than failing silently at record
  // time, when the student is the one who finds out.
  console.warn(
    `\n  onsets-frames checkpoint unavailable: ${error.message}\n` +
    '  Piano takes will fall back to Basic Pitch, which is markedly worse on ' +
    'piano.\n  Re-run `pnpm copy:audio-assets` once you have a connection.\n')
}
