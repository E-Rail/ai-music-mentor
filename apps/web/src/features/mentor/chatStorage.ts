/**
 * Local persistence for the mentor chat thread.
 *
 * localStorage is untrusted input: it holds whatever an older build of this app
 * wrote, and it survives upgrades. Everything read back is validated here, once,
 * so no component has to defend itself against a payload from a previous
 * version. A turn whose rich `response` no longer matches keeps its text and
 * loses only the extras — the conversation is never destroyed to protect the
 * renderer.
 */
import { t } from '../../i18n/messages'
import type { MentorChatResponse } from '../../types'
import type { MentorChatMessage } from './MentorChat'

const KEY_PREFIX = 'ai-music-mentor:mentor-chat:'
/** Turns kept per report. Older ones fall off the front. */
export const CHAT_HISTORY_LIMIT = 40

export function chatMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `chat_${Date.now()}_${Math.random()}`
}

/** True when a stored response still has every field the thread renders. */
export function usableChatResponse(value: unknown): value is MentorChatResponse {
  const response = value as Partial<MentorChatResponse> | null
  return !!response &&
    typeof response.provider === 'string' &&
    typeof response.answer === 'string' &&
    Array.isArray(response.professionalGuidance) &&
    Array.isArray(response.actions) &&
    Array.isArray(response.evidenceIds)
}

export function readMentorChat(reportId: string): MentorChatMessage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${KEY_PREFIX}${reportId}`) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((message) => message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.text === 'string' && typeof message.id === 'string')
      // A request that was in flight when the page closed did not complete.
      .map((message) => message.status === 'sending'
        ? { ...message, status: 'error', error: t('mentorChatInterrupted') }
        : message)
      .map((message) => usableChatResponse(message.response)
        ? message : { ...message, response: undefined })
      .slice(-CHAT_HISTORY_LIMIT) as MentorChatMessage[]
  } catch { return [] }
}

export function writeMentorChat(reportId: string, messages: MentorChatMessage[]): void {
  try {
    localStorage.setItem(
      `${KEY_PREFIX}${reportId}`,
      JSON.stringify(messages.slice(-CHAT_HISTORY_LIMIT)),
    )
  } catch { /* the thread stays available in memory for this session */ }
}
