import { useId } from 'react'

export function SettingsToggle({
  label,
  badge,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string
  badge?: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const hintId = useId()
  return (
    <label className="settings-toggle-row">
      <span>
        <strong>
          {label}
          {badge && (
            <>
              {' '}
              <span className="lab-badge">{badge}</span>
            </>
          )}
        </strong>
        <small id={hintId}>{hint}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        aria-describedby={hintId}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}
