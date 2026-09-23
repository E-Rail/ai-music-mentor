import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../i18n/messages'

/**
 * Messages the studio tells the player — "device selected", "upload failed".
 *
 * Two things are true of every one of them, so they live here once:
 *
 * - **They hold a way to say it, not what was said.** The text is a thunk,
 *   evaluated at render, so a message on screen when the language changes is
 *   re-read in the new language instead of staying in the old one.
 * - **They float.** A banner above the stage pushed the whole page down by its
 *   own height, which is how an error message used to shove the transport off
 *   the bottom of a laptop screen. A stack in the corner costs no layout.
 *
 * Good news fades on its own; a warning or an error stays until it is read and
 * closed, because the player may have been looking at the keyboard.
 */
export type NoticeTone = 'info' | 'success' | 'warn' | 'error'

export interface Notice {
  id: number
  tone: NoticeTone
  text: () => string
  action?: { label: () => string; run: () => void }
}

const FADE_MS = 6_000
const MAX_VISIBLE = 3

export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) window.clearTimeout(timer)
    timers.current.delete(id)
    setNotices((current) => current.filter((notice) => notice.id !== id))
  }, [])

  const notify = useCallback((tone: NoticeTone, text: () => string,
    action?: Notice['action']): number => {
    const id = nextId.current++
    setNotices((current) => {
      // The same sentence twice is one message, not two: the newer copy
      // replaces the older rather than stacking an echo.
      const said = text()
      const kept = current.filter((notice) => notice.text() !== said)
      return [...kept, { id, tone, text, action }].slice(-MAX_VISIBLE)
    })
    if (tone === 'info' || tone === 'success') {
      timers.current.set(id, window.setTimeout(() => dismiss(id), FADE_MS))
    }
    return id
  }, [dismiss])

  const clear = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer))
    timers.current.clear()
    setNotices([])
  }, [])

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer))
  }, [])

  return { notices, notify, dismiss, clear }
}

export function NoticeStack({ notices, onDismiss }: {
  notices: Notice[]
  onDismiss: (id: number) => void
}) {
  if (!notices.length) return null
  return (
    <div className="notice-stack">
      {notices.map((notice) => (
        <div key={notice.id}
             role={notice.tone === 'error' || notice.tone === 'warn' ? 'alert' : 'status'}
             className={`notice alert alert-${notice.tone}`}>
          <span className="notice-text">{notice.text()}</span>
          {notice.action && (
            <button type="button" className="btn btn-sm" onClick={() => {
              notice.action?.run()
              onDismiss(notice.id)
            }}>{notice.action.label()}</button>
          )}
          <button type="button" className="notice-close" aria-label={t('noticeDismiss')}
                  title={t('noticeDismiss')} onClick={() => onDismiss(notice.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
