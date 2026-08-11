/**
 * One palette for every place an error type is drawn.
 *
 * The same fault appears on the printed page, in the error list and on a badge,
 * against two different backgrounds. Keeping the mapping here means a student
 * learns one visual language instead of three, and colour never has to carry a
 * distinction on its own — stroke does that too, for anyone who cannot separate
 * the hues.
 *
 * Hue groups follow the app's materials: felt for a wrong note, brass for wrong
 * timing, lacquer for a whole-passage tempo or dynamics judgement, and plain
 * grey for something that never sounded at all.
 */
export type ErrorStroke = 'solid' | 'dashed' | 'dotted'
export type Surface = 'paper' | 'case'

export interface ErrorInk {
  /** Legible on the white score page. */
  paper: string
  /** Legible on the dark app surfaces. */
  case: string
  stroke: ErrorStroke
  /** Drawn as an outline because nothing sounded there. */
  hollow: boolean
}

export const ERROR_INK: Record<string, ErrorInk> = {
  wrong_pitch: { paper: '#a52840', case: '#e8798f', stroke: 'solid', hollow: false },
  extra_note: { paper: '#a52840', case: '#e8798f', stroke: 'dotted', hollow: false },
  missed_note: { paper: '#7b7385', case: '#9a91a5', stroke: 'solid', hollow: true },
  early_late: { paper: '#96690f', case: '#d6a756', stroke: 'dashed', hollow: false },
  duration_anomaly: { paper: '#96690f', case: '#d6a756', stroke: 'dotted', hollow: false },
  tempo_instability: { paper: '#5f519b', case: '#b3a6e2', stroke: 'dashed', hollow: false },
  dynamics_anomaly: { paper: '#5f519b', case: '#b3a6e2', stroke: 'dotted', hollow: false },
}

const FALLBACK = ERROR_INK.wrong_pitch

export function errorInk(type: string): ErrorInk {
  return ERROR_INK[type] ?? FALLBACK
}

export function errorColor(type: string, surface: Surface = 'case'): string {
  return errorInk(type)[surface]
}

/** Colour reserved for a fault the next take fixed. */
export const RESOLVED_INK = { paper: '#4a7a3d', case: '#9cc78d' } as const

/** Colour of the live follower cursor on the page. */
export const CURSOR_INK = '#96690f'
