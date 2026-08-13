import type { MentorChatResponse, MentorMemoryStatus } from '../../types'
import { t, tf } from '../../i18n/messages'

export type MentorChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'sending' | 'sent' | 'error'
  response?: MentorChatResponse
  error?: string
}

type MentorChatProps = {
  messages: MentorChatMessage[]
  loading: boolean
  question: string
  onQuestionChange: (value: string) => void
  onAsk: (prompt?: string, retryMessageId?: string) => void | Promise<void>
  onCancel: () => void
  onApplyAction: (response: MentorChatResponse, actionIndex: number) => void
  memory: MentorMemoryStatus | null
  onForgetMemory: () => void | Promise<void>
}

const QUICK_QUESTIONS = [
  t('mentorQuickWhy'), t('mentorQuickPractice'), t('mentorQuickPlan'),
]

export function MentorChat({
  messages, loading, question, onQuestionChange, onAsk, onCancel, onApplyAction,
  memory, onForgetMemory,
}: MentorChatProps) {
  return (
    <section className="mentor-chat">
      <div className="mentor-chat-heading">
        <div>
          <span className="mentor-chat-kicker">{t('mentorChatKicker')}</span>
          <h3>{t('mentorChatTitle')}</h3>
        </div>
        <div className="mentor-memory-status">
          <span>{t('mentorChatSaved')}</span>
          <small>{memory?.rememberedTurnCount
            ? tf('mentorMemoryCount', { count: memory.rememberedTurnCount })
            : t('mentorMemoryEmpty')}</small>
          {!!memory?.rememberedTurnCount && (
            <button type="button" disabled={loading} onClick={() => void onForgetMemory()}>
              {t('mentorForgetMemory')}
            </button>
          )}
        </div>
      </div>
      <div className="mentor-chat-thread" aria-live="polite">
        {messages.length === 0 && (
          <div className="mentor-chat-empty">{t('mentorChatEmpty')}</div>
        )}
        {messages.map((message) => (
          <div className={`chat-row ${message.role}`} key={message.id}>
            <div className={`chat-bubble ${message.status}`}>
              <div className="chat-role">
                {message.role === 'user' ? t('mentorChatYou') : t('mentorChatAi')}
              </div>
              <div>{message.text}</div>
              {message.role === 'assistant' && message.response && (
                <>
                  {message.response.provider.startsWith('rules') && (
                    <div className="chat-provider fallback">
                      {message.response.provider === 'rules'
                        ? t('mentorLocalRules') : t('mentorLocalFallback')}
                    </div>
                  )}
                  {!!message.response.professionalGuidance.length && (
                    <ul className="chat-guidance">
                      {message.response.professionalGuidance.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                  {!!message.response.uncertainty && (
                    <div className="chat-uncertainty">{message.response.uncertainty}</div>
                  )}
                  {!!message.response.followUpQuestion && (
                    <button className="chat-follow-up" type="button"
                            onClick={() => onQuestionChange(message.response!.followUpQuestion || '')}>
                      {message.response.followUpQuestion}
                    </button>
                  )}
                  {message.response.actions.map((action, index) => action.type !== 'none' && (
                    <button className="btn btn-sm chat-plan-action"
                            key={`${action.type}:${index}`}
                            onClick={() => onApplyAction(message.response!, index)}>
                      {action.label}
                    </button>
                  ))}
                </>
              )}
              {message.status === 'sending' && (
                <span className="chat-status">{t('mentorChatSending')}</span>
              )}
              {message.status === 'error' && (
                <div className="chat-error">
                  <span>{tf('mentorChatFailed', { detail: message.error })}</span>
                  <button className="btn btn-sm" disabled={loading}
                          onClick={() => void onAsk(message.text, message.id)}>
                    {t('mentorChatRetry')}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mentor-quick">
        <span className="dim">{t('mentorQuickQuestions')}</span>
        {QUICK_QUESTIONS.map((prompt) => (
          <button type="button" className="strategy-btn" key={prompt}
                  disabled={loading} onClick={() => void onAsk(prompt)}>{prompt}</button>
        ))}
      </div>
      <div className="mentor-composer">
        <textarea value={question} onChange={(event) => onQuestionChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && question.trim() && !loading) {
                      event.preventDefault()
                      void onAsk()
                    }
                  }}
                  rows={3} maxLength={2000}
                  placeholder={t('mentorQuestionPlaceholder')} />
        {loading && (
          <button className="btn" type="button" onClick={onCancel}>
            {t('cancelRequest')}
          </button>
        )}
        <button className="btn btn-primary" onClick={() => void onAsk()}
                disabled={loading || !question.trim()}>
          {loading ? t('mentorChatSending') : t('askMentor')}
        </button>
      </div>
      <div className="dim mentor-chat-hint">{t('mentorChatHint')}</div>
    </section>
  )
}
