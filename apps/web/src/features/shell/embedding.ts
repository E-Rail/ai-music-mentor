/**
 * Whether the studio is running inside another site's page.
 *
 * This changes what to say when a permission is refused. The microphone and the
 * MIDI keyboard are both permission-gated, and a browser only hands those to a
 * cross-origin frame when the surrounding page explicitly passes them down —
 * which the page hosting a shared link generally does not. Telling that student
 * to check their browser settings sends them looking for a switch that is not
 * there and cannot help. The same build works in its own tab, so what they need
 * is an address, not a setting.
 */
import { tf } from '../../i18n/messages'

export function isEmbedded(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.self !== window.top
  } catch {
    // Reading window.top across origins throws, and only a framed page can be
    // cross-origin with its own top. A throw is therefore a yes.
    return true
  }
}

/**
 * A permission failure, with the way out appended when the frame is the reason
 * it failed. Returns the message unchanged on a page that is already top-level,
 * where the refusal is real and the browser's own guidance is the right advice.
 */
export function withEmbeddedNote(message: string): string {
  if (!isEmbedded()) return message
  return `${message} ${tf('embeddedPermissionNote', { address: window.location.origin })}`
}
