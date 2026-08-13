import { useEffect, useState } from 'react'
import { t } from '../../i18n/messages'
import { applyScale, readScale, type UiScale } from './uiScale'

const CHOICES: { id: UiScale; label: () => string; hint: () => string }[] = [
  { id: 'starter', label: () => t('scaleStarter'), hint: () => t('scaleStarterHint') },
  { id: 'pro', label: () => t('scalePro'), hint: () => t('scaleProHint') },
]

/** Reads the stored scale on mount, so a reload keeps the size you chose. */
export function useUiScale(): [UiScale, (next: UiScale) => void] {
  const [scale, setScale] = useState<UiScale>(readScale)
  useEffect(() => { applyScale(scale) }, [scale])
  return [scale, setScale]
}

export function ScaleSwitch({ scale, onChange }: {
  scale: UiScale
  onChange: (next: UiScale) => void
}) {
  return (
    <div className="scale-switch" role="group" aria-label={t('scaleLabel')}>
      {CHOICES.map((choice) => (
        <button
          key={choice.id}
          type="button"
          aria-pressed={scale === choice.id}
          title={choice.hint()}
          onClick={() => onChange(choice.id)}
        >
          {choice.label()}
        </button>
      ))}
    </div>
  )
}
