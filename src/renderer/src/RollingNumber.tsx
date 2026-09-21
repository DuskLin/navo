import { memo, useLayoutEffect, useRef } from 'react'
import './rolling-number.css'

function Digit({ value }: { value: string }) {
  const track = useRef<HTMLSpanElement>(null)
  const previous = useRef(value)
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = value
    if (from === value || !track.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    track.current.firstElementChild!.textContent = from
    const animation = track.current.animate(
      [{ transform: 'translateY(0)' }, { transform: 'translateY(-50%)' }],
      { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    )
    return () => animation.cancel()
  }, [value])
  return (
    <span className="rolling-number-digit">
      <span className="rolling-number-track" ref={track}>
        <span>{value}</span>
        <span>{value}</span>
      </span>
    </span>
  )
}

// Animate the formatted value, preserving currency, precision and compact units.
// Right-aligned keys keep existing digit columns mounted when a number grows.
export const RollingNumber = memo(function RollingNumber({ value }: { value: string | number }) {
  const text = String(value)
  return (
    <span className="rolling-number" role="img" aria-label={text}>
      <span aria-hidden="true">
        {Array.from(text).map((char, index) =>
          /[0-9]/.test(char) ? (
            <Digit key={text.length - index} value={char} />
          ) : (
            <span key={text.length - index}>{char}</span>
          )
        )}
      </span>
    </span>
  )
})
