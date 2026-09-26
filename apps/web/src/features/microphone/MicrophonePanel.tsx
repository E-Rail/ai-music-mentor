import type { InstrumentProfile } from '../../types'
import { instrumentLabel, t, tf, type MessageKey } from '../../i18n/messages'
import type {
  MicrophonePreview, MicrophoneState,
} from './microphoneCapture'
import type { InputDeviceDescriptor } from '../input/PerformanceInputAdapter'

const INSTRUMENTS: InstrumentProfile[] = ['piano', 'guitar', 'violin']

// Keys, not strings: this table is read at render, so it follows the language.
const STATE_KEYS: Record<MicrophoneState, MessageKey> = {
  idle: 'microphoneIdle',
  requesting: 'microphoneRequesting',
  'noise-check': 'microphoneNoiseCheck',
  ready: 'microphoneReady',
  recording: 'microphoneRecording',
  transcribing: 'microphoneTranscribing',
  'permission-denied': 'microphonePermissionDenied',
  'device-lost': 'microphoneDeviceLost',
  error: 'microphoneError',
}

function pitchLabel(frequency: number | null): string {
  if (!frequency) return '—'
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440))
  const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
  return `${names[(midi % 12 + 12) % 12]}${Math.floor(midi / 12) - 1} · ${Math.round(frequency)} Hz`
}

export function MicrophonePanel({
  state, devices, selectedDeviceId, instrument, preview, progress, busy,
  errorDetail, previewMode, onConnect, onCancelConnect, onSelectDevice,
  onInstrumentChange, onCancelTranscription,
  sensitivity, sensitivityPinned, onSensitivityChange,
}: {
  state: MicrophoneState
  devices: InputDeviceDescriptor[]
  selectedDeviceId: string
  instrument: InstrumentProfile
  preview: MicrophonePreview
  progress: number
  busy: boolean
  errorDetail?: string | null
  previewMode: 'worklet' | 'analyser' | 'unavailable'
  onConnect: () => void
  onCancelConnect: () => void
  onSelectDevice: (deviceId: string) => void
  onInstrumentChange: (instrument: InstrumentProfile) => void
  onCancelTranscription: () => void
  sensitivity: number
  sensitivityPinned: boolean
  onSensitivityChange: (value: number) => void
}) {
  const points = preview.waveform.length
    ? preview.waveform.map((value, index) =>
        `${(index / Math.max(1, preview.waveform.length - 1)) * 300},${40 - value * 34}`).join(' ')
    : '0,40 300,40'
  const requesting = state === 'requesting'
  const permissionProblem = state === 'permission-denied'
  const connectionProblem = state === 'error' || state === 'device-lost'
  const connectionNote = requesting
    ? t('microphoneRequestGuide')
    : permissionProblem
      ? t('microphonePermissionGuide')
      : connectionProblem
        ? (errorDetail || t(STATE_KEYS[state]))
        : null
  return (
    <section className="microphone-panel" aria-labelledby="microphone-title">
      {/* Flat on purpose: the grid places these beside or under each other by
          the width of the box, so a 380px rail stacks them instead of
          squeezing the sentence into a column beside the icon. */}
      <div className="mic-panel-heading">
        <span className="mic-symbol" aria-hidden="true">MIC</span>
        <h3 id="microphone-title">{t('microphoneTitle')}</h3>
        <span className={`mic-state ${state}`}>{t(STATE_KEYS[state])}</span>
        <p>{t('microphoneHint')}</p>
      </div>
      <div className="mic-panel-grid">
        <div className="mic-setup-column">
          <section className="mic-setup-step">
            <div className="mic-step-title"><span>1</span><strong>{t('microphoneSetupInstrument')}</strong></div>
            <div className="instrument-choice" role="group" aria-label={t('instrument')}>
              {INSTRUMENTS.map((value) => (
                <button type="button" key={value} aria-pressed={instrument === value}
                        disabled={busy || state === 'recording' || state === 'transcribing'}
                        onClick={() => onInstrumentChange(value)}>{instrumentLabel(value)}</button>
              ))}
            </div>
          </section>
          <section className="mic-setup-step">
            <div className="mic-step-title"><span>2</span><strong>{t('microphoneSetupDevice')}</strong></div>
            <label className="mic-device-select">{t('microphoneDevice')}
              <select value={selectedDeviceId}
                      disabled={busy || !devices.length || state === 'recording' || state === 'transcribing'}
                      onChange={(event) => onSelectDevice(event.target.value)}>
                {!devices.length && <option value="">{state === 'ready' ? t('microphoneReady') : '—'}</option>}
                {devices.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
              </select>
            </label>
            <button type="button" className={`btn mic-connect-button ${requesting ? '' : 'btn-primary'}`}
                    onClick={requesting ? onCancelConnect : onConnect}
                    disabled={(busy && !requesting) || state === 'recording' || state === 'transcribing' || state === 'noise-check'}>
              {requesting
                ? t('cancelRequest')
                : state === 'idle' || state === 'permission-denied' || state === 'error'
                  ? t('microphoneConnect') : t('microphoneReconnect')}
            </button>
            {connectionNote && (
              <div className={`mic-connection-note ${permissionProblem || connectionProblem ? 'problem' : ''}`} role="status">
                {connectionNote}
              </div>
            )}
          </section>
        </div>
        <div className="mic-monitor-column">
          <label className="mic-sensitivity">
            <span className="mic-sensitivity-heading">
              <strong>{t('microphoneSensitivity')}</strong>
              <small>{sensitivityPinned
                ? tf('microphoneSensitivityManual', { value: Math.round(sensitivity * 100) })
                : t('microphoneSensitivityAuto')}</small>
            </span>
            <input type="range" min={0} max={100} step={5}
                   value={Math.round(sensitivity * 100)}
                   onChange={(event) => onSensitivityChange(Number(event.target.value) / 100)} />
            <small className="mic-sensitivity-hint">{t('microphoneSensitivityHint')}</small>
          </label>
          <div className="mic-monitor-heading">
            <strong>{t('microphoneMonitor')}</strong>
            <span>{previewMode === 'worklet' ? 'AudioWorklet' : previewMode === 'analyser' ? t('micCompatibilityMode') : '—'}</span>
          </div>
          <div className="mic-preview" aria-label={t('microphonePreviewOnly')}>
            <svg viewBox="0 0 300 80" preserveAspectRatio="none" role="img">
              <line x1="0" y1="40" x2="300" y2="40" />
              <polyline points={points} />
            </svg>
            <div className="mic-meter"><span style={{ width: `${Math.max(0, Math.min(100, (preview.levelDb + 60) / 60 * 100))}%` }} /></div>
            <div className="mic-preview-facts">
              <span>{t('microphoneLevel')} <strong>{Math.round(preview.levelDb)} dB</strong></span>
              <span>{tf('microphonePitch', { value: pitchLabel(preview.pitchHz) })}</span>
              <span>{preview.noiseFloorDb !== null
                ? tf('microphoneNoiseFloor', { value: Math.round(preview.noiseFloorDb) })
                : state === 'noise-check'
                  ? t('microphoneNoiseCheck')
                  : t('microphoneNoiseWaiting')}</span>
              <span>{tf('microphoneAnalysisGain', {
                value: Math.round(preview.analysisGainDb),
              })}</span>
              {preview.signalToNoiseDb !== null && (
                <span>{tf('microphoneSnr', { value: Math.round(preview.signalToNoiseDb) })}</span>
              )}
            </div>
          </div>
          <p className="preview-disclaimer">{state === 'idle'
            ? t('microphoneMonitorWaiting')
            : previewMode === 'analyser'
              ? t('microphoneCompatiblePreview')
              : previewMode === 'unavailable' && state === 'ready'
                ? t('microphonePreviewUnavailable') : t('microphoneEnhancedPreviewOnly')}</p>
        </div>
      </div>
      {state === 'transcribing' && (
        <div className="transcription-progress" role="status">
          <div><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <strong>{tf('transcriptionProgress', { value: Math.round(progress * 100) })}</strong>
          <button type="button" className="btn btn-sm" onClick={onCancelTranscription}>
            {t('transcriptionCancel')}
          </button>
        </div>
      )}
    </section>
  )
}
