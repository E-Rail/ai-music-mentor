/**
 * Give Magenta's CommonJS dependencies the `global` they were compiled against.
 *
 * `@magenta/music` bundles protobufjs, which is CommonJS. Converting it to an
 * ES module leaves bare `global` references behind, and `global` does not exist
 * in a browser or a worker — so importing the transcription model throws
 * `ReferenceError: global is not defined` before any of our code runs. Defining
 * it as a property of the global object is what makes the bare identifier
 * resolve at all.
 *
 * This module must be imported *above* every Magenta import. ES modules are
 * evaluated in import order, so being first in the list is what makes it a fix
 * rather than a race. It exists as its own module for exactly that reason: an
 * assignment at the top of the worker body would run too late.
 *
 * Magenta's own `window` assumptions are handled at the source instead, by the
 * patch in `apps/web/patches` — see `vite.config.ts`'s neighbours there for why
 * a patch rather than more shimming: upstream also builds an
 * `OfflineAudioContext` at module scope, which no amount of faking survives.
 */
const scope = globalThis as unknown as Record<string, unknown>

// Magenta reads `global.process` to decide whether it is running under Node.
// A browser has no `process`, so this stays the browser path — which is what we
// want, since the Node path would try to require `node-fetch`.
scope.global ??= globalThis

export {}
