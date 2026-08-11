import { t } from '../../i18n/messages'
import type { LiveTraceNote } from './livePerformance'

/** Beats of history kept on screen. */
const WINDOW_BEATS = 8
const VIEW_WIDTH = 320
const VIEW_HEIGHT = 72
const PAD_Y = 10

/**
 * The take, drawn as you play it.
 *
 * Horizontal position is the beat the note actually landed on, so a note played
 * behind the beat sits to the right of that beat's line and a rushed one sits
 * left. Vertical position is its pitch. The shape of the student's own timing
 * therefore accumulates against the printed grid without anyone having to
 * explain it, and nothing here is inferred — every dot is a note that sounded.
 */
export function LiveTrace({ notes }: { notes: LiveTraceNote[] }) {
  if (!notes.length) {
    return (
      <div className="live-trace empty">
        <span className="eyebrow">{t('liveTraceTitle')}</span>
        <p>{t('liveTraceEmpty')}</p>
      </div>
    )
  }

  const latestBeat = Math.max(...notes.map((note) => note.beatsFromStart))
  const from = Math.max(0, latestBeat - WINDOW_BEATS)
  const visible = notes.filter((note) => note.beatsFromStart >= from - 0.5)
  const pitches = visible.map((note) => note.pitch)
  const lowest = Math.min(...pitches)
  const highest = Math.max(...pitches)
  const span = Math.max(7, highest - lowest)
  const centre = (highest + lowest) / 2

  const xOf = (beat: number) =>
    ((beat - from) / WINDOW_BEATS) * (VIEW_WIDTH - 12) + 6
  const yOf = (pitch: number) =>
    VIEW_HEIGHT / 2 - ((pitch - centre) / span) * (VIEW_HEIGHT - PAD_Y * 2)

  const beatLines: number[] = []
  for (let beat = Math.ceil(from); beat <= from + WINDOW_BEATS; beat += 1) {
    beatLines.push(beat)
  }

  return (
    <div className="live-trace">
      <div className="live-trace-heading">
        <span className="eyebrow">{t('liveTraceTitle')}</span>
        <small>{t('liveTraceLegend')}</small>
      </div>
      <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img"
           aria-label={t('liveTraceAria')} preserveAspectRatio="none">
        {beatLines.map((beat) => (
          <line key={beat} className={beat % 4 === 0 ? 'barline' : 'beatline'}
                x1={xOf(beat)} x2={xOf(beat)} y1={4} y2={VIEW_HEIGHT - 4} />
        ))}
        {visible.map((note) => (
          <circle key={note.id} className={`trace-note ${note.status} ${note.timing}`}
                  cx={xOf(note.beatsFromStart)} cy={yOf(note.pitch)} r={4} />
        ))}
      </svg>
    </div>
  )
}
