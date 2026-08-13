import { beforeEach, describe, expect, it } from 'vitest'
import { readMentorChat, usableChatResponse, writeMentorChat } from './chatStorage'
import type { MentorChatMessage } from './MentorChat'

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    },
  })
})

const KEY = 'ai-music-mentor:mentor-chat:report-1'

const FULL_RESPONSE = {
  provider: 'openai', model: 'gpt', answer: '把第 3 小节放慢到 60 BPM。',
  intent: 'practice_plan', evidenceIds: ['ev_1'],
  professionalGuidance: ['先单手'], actions: [], uncertainty: '',
}

describe('mentor chat persistence', () => {
  it('round-trips a complete thread', () => {
    const messages = [
      { id: 'a', role: 'user', text: '为什么总是慢？', status: 'sent' },
      { id: 'b', role: 'assistant', text: FULL_RESPONSE.answer, status: 'sent', response: FULL_RESPONSE },
    ] as unknown as MentorChatMessage[]
    writeMentorChat('report-1', messages)
    const read = readMentorChat('report-1')
    expect(read).toHaveLength(2)
    expect(read[1].response?.answer).toBe(FULL_RESPONSE.answer)
  })

  it('keeps the text of a turn written by an older build and drops only the extras', () => {
    // What the previous build stored: a MentorResponse, not a MentorChatResponse.
    store.set(KEY, JSON.stringify([
      { id: 'a', role: 'user', text: '这里怎么练？', status: 'sent' },
      {
        id: 'b', role: 'assistant', text: '先放慢。', status: 'sent',
        response: { provider: 'rules', summary: '先放慢。', plan: [], evidence: [] },
      },
    ]))
    const read = readMentorChat('report-1')
    expect(read).toHaveLength(2)
    expect(read[1].text).toBe('先放慢。')
    expect(read[1].response).toBeUndefined()
  })

  it('marks a request that was still in flight when the page closed', () => {
    store.set(KEY, JSON.stringify([
      { id: 'a', role: 'user', text: '在想什么？', status: 'sending' },
    ]))
    const read = readMentorChat('report-1')
    expect(read[0].status).toBe('error')
    expect(read[0].error).toBeTruthy()
  })

  it('survives corrupt storage rather than taking the report down', () => {
    store.set(KEY, 'not json at all')
    expect(readMentorChat('report-1')).toEqual([])
    store.set(KEY, JSON.stringify({ not: 'an array' }))
    expect(readMentorChat('report-1')).toEqual([])
    store.set(KEY, JSON.stringify([{ id: 'a' }, null, 42]))
    expect(readMentorChat('report-1')).toEqual([])
  })

  it('recognises only a response the thread can render', () => {
    expect(usableChatResponse(FULL_RESPONSE)).toBe(true)
    expect(usableChatResponse({ ...FULL_RESPONSE, actions: undefined })).toBe(false)
    expect(usableChatResponse({ ...FULL_RESPONSE, professionalGuidance: undefined })).toBe(false)
    expect(usableChatResponse(null)).toBe(false)
  })
})
