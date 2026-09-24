import { useEffect, useRef, type CSSProperties, type PointerEvent } from 'react'
import { clamp, ReceiptPaperMesh, type PaperFrame, type PaperPose } from './receipt-paper-mesh'

type Phase = 'printing' | 'ready' | 'tearing'
interface Props {
  image: { url: string; width: number; height: number }
  phase: Phase
  reducedMotion: boolean
  onTear: () => void
  onComplete: () => void
}
type SpringKey = 'angle' | 'pull' | 'lift'
const keys: SpringKey[] = ['angle', 'pull', 'lift']
const zero = () => ({ angle: 0, pull: 0, lift: 0 })
const ease = (t: number) => {
  const n = clamp(t, 0, 1)
  return n * n * (3 - 2 * n)
}

/** Pointer input drives a spring-loaded surface; React only handles phase changes. */
export function ReceiptPaper(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const fallback = useRef<HTMLImageElement>(null)
  const latest = useRef(props)
  latest.current = props
  const controls = useRef<{
    down: (event: PointerEvent<HTMLDivElement>) => void
    move: (event: PointerEvent<HTMLDivElement>) => void
    up: (event: PointerEvent<HTMLDivElement>, cancel?: boolean) => void
    phase: () => void
  } | null>(null)

  useEffect(() => {
    const element = host.current!,
      surface = canvas.current!,
      flat = fallback.current!
    const image = new Image()
    let mesh: ReceiptPaperMesh | undefined
    let disposed = false,
      frame = 0,
      lastTime = 0
    let width = element.getBoundingClientRect().width,
      height = (width * props.image.height) / props.image.width
    let padding = Math.max(width * 1.1, height * 0.68)
    let meshFrame: PaperFrame = {
      width,
      height,
      originX: padding,
      originY: padding,
      canvasWidth: width + padding * 2,
      canvasHeight: height + padding * 2
    }
    let side = 1,
      releaseAt = 0,
      releaseAngle = 0,
      releaseVelocity = 0
    let fracture = 0,
      strain = 0,
      crackImpulse = 0
    let tearRequested = false,
      complete = false
    let pointer:
      | {
          id: number
          x: number
          y: number
          grabY: number
          baseFracture: number
          baseAngle: number
          lastX: number
          lastTime: number
          speed: number
        }
      | undefined
    const position = zero(),
      velocity = zero(),
      target = zero()
    const bounds = () => {
      width = element.getBoundingClientRect().width
      height = (width * props.image.height) / props.image.width
      padding = Math.max(width * 1.1, height * 0.68)
      const rect = element.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      // Keep the canvas itself on physical pixel boundaries; fractional compositing blurs every glyph twice.
      const left = Math.floor((rect.left - padding) * dpr) / dpr - rect.left
      const top = Math.floor((rect.top - padding) * dpr) / dpr - rect.top
      meshFrame = {
        width,
        height,
        originX: -left,
        originY: -top,
        canvasWidth: Math.ceil((width + padding * 2) * dpr) / dpr,
        canvasHeight: Math.ceil((height + padding * 2) * dpr) / dpr
      }
      surface.style.left = `${left}px`
      surface.style.top = `${top}px`
      surface.style.width = `${meshFrame.canvasWidth}px`
      surface.style.height = `${meshFrame.canvasHeight}px`
    }
    const kick = () => {
      if (!frame && !disposed && !complete) frame = requestAnimationFrame(tick)
    }
    const release = () => {
      if (tearRequested || latest.current.phase !== 'ready') return
      tearRequested = true
      releaseVelocity = pointer?.speed ?? 0
      pointer = undefined
      delete element.dataset.dragging
      latest.current.onTear()
    }
    const hang = () => {
      target.angle = side * 0.52 * ease(fracture / 0.78)
      target.pull = width * 0.018 * fracture
      target.lift = fracture > 0 ? 0.28 + fracture * 0.46 : 0
      strain = fracture * 0.22
    }
    const startTear = (now: number) => {
      releaseAt = now
      fracture = 1
      releaseAngle = position.angle
      // Release the stored torsion in one decisive snap, followed by a single opposite swing.
      velocity.angle = -side * (3.8 + Math.abs(releaseAngle) * 2.2)
      target.angle = -side * 0.2
      target.pull = position.pull
      target.lift = 0.36
      crackImpulse = 0.8
      strain = 0
    }
    function tick(now: number) {
      frame = 0
      if (disposed || complete) return
      const phase = latest.current.phase
      if (phase === 'tearing' && !releaseAt) startTear(now)
      const elapsed = releaseAt ? (now - releaseAt) / 1000 : 0
      const dt = Math.min(0.032, Math.max(0.001, (now - (lastTime || now - 16)) / 1000))
      lastTime = now
      // Two integration steps stay stable after resize, slow frames and display refresh changes.
      for (let step = 0; step < 2; step++)
        for (const key of keys) {
          const stiffness = phase === 'tearing' && key === 'angle' ? 88 : pointer ? 280 : 180
          const damping = phase === 'tearing' && key === 'angle' ? 8 : pointer ? 27 : 20
          velocity[key] +=
            (((target[key] - position[key]) * stiffness - velocity[key] * damping) * dt) / 2
          position[key] += (velocity[key] * dt) / 2
        }
      crackImpulse *= Math.exp(-dt * 11)
      const pose: PaperPose = {
        ...position,
        peel: fracture,
        strain: strain + crackImpulse * 0.45,
        side,
        flutter: releaseAt
          ? Math.sin(elapsed * 21) * Math.exp(-elapsed * 6) * 0.7
          : clamp(velocity.angle * 0.06 + crackImpulse * 0.12, -0.22, 0.22),
        release: releaseAt ? ease(elapsed / 0.085) : 0,
        x: releaseAt
          ? side * width * 0.63 * ease((elapsed - 0.1) / 0.48) +
            clamp(releaseVelocity, -700, 700) * elapsed * 0.025
          : 0,
        y: releaseAt ? -height * 0.055 * ease(elapsed / 0.45) : 0
      }
      const opacity = releaseAt ? 1 - ease((elapsed - 0.18) / 0.42) : 1
      const settled =
        !releaseAt &&
        crackImpulse < 0.001 &&
        keys.every(
          (key) => Math.abs(position[key] - target[key]) < 0.001 && Math.abs(velocity[key]) < 0.005
        )
      if (settled)
        for (const key of keys) {
          position[key] = target[key]
          velocity[key] = 0
          pose[key] = target[key]
        }
      if (mesh?.draw(meshFrame, pose, opacity)) {
        element.dataset.renderer = 'mesh'
        // Native SVG remains sharp at rest; the mesh takes over only for deformation.
        flat.style.transform = 'none'
        flat.style.opacity = '1'
        surface.style.filter = `drop-shadow(${pose.angle * -6}px ${4 + pose.lift * 13}px ${3 + pose.lift * 5}px rgba(30,25,18,${0.2 + pose.lift * 0.06}))`
      } else {
        element.dataset.renderer = 'fallback'
        flat.style.transformOrigin = `${side > 0 ? 12 : 88}% 0`
        flat.style.transform = `perspective(900px) translate(${pose.x}px, ${pose.pull + pose.y}px) rotate(${pose.angle}rad) rotateX(${pose.lift * -9}deg)`
        flat.style.opacity = String(opacity)
      }
      element.dataset.paperState = releaseAt
        ? 'detached'
        : pointer
          ? 'pulling'
          : settled
            ? fracture > 0
              ? 'hanging'
              : 'rest'
            : 'settling'
      element.dataset.peel = pose.peel.toFixed(3)
      if (releaseAt && (elapsed >= 0.64 || latest.current.reducedMotion)) {
        complete = true
        latest.current.onComplete()
        return
      }
      if (releaseAt || !settled) kick()
      else lastTime = 0 // Static paper consumes no animation frames.
    }
    controls.current = {
      down(event) {
        if (latest.current.phase !== 'ready' || event.button !== 0 || pointer || tearRequested)
          return
        const rect = element.getBoundingClientRect()
        const x = event.clientX - rect.left,
          y = event.clientY - rect.top
        const hinge = width * (side > 0 ? 0.12 : 0.88)
        const localX =
          (x - hinge) * Math.cos(position.angle) +
          (y - position.pull) * Math.sin(position.angle) +
          hinge
        const localY =
          -(x - hinge) * Math.sin(position.angle) + (y - position.pull) * Math.cos(position.angle)
        const hit = mesh
          ? mesh.pick(x + meshFrame.originX, y + meshFrame.originY)
          : localX >= 0 && localX <= width && localY >= 0 && localY <= height
            ? { u: localX / width, v: localY / height }
            : undefined
        if (!hit) return
        // Grab the right edge to tear from the right, leaving the left corner attached (and vice versa).
        if (fracture === 0) side = hit.u >= 0.5 ? 1 : -1
        pointer = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          grabY: clamp(hit.v * height, height * 0.12, height * 0.9),
          baseFracture: fracture,
          baseAngle: position.angle,
          lastX: event.clientX,
          lastTime: performance.now(),
          speed: 0
        }
        element.setPointerCapture(event.pointerId)
        element.dataset.dragging = 'true'
        kick()
      },
      move(event) {
        if (!pointer || pointer.id !== event.pointerId) return
        const now = performance.now()
        const dx = event.clientX - pointer.x,
          dy = Math.max(0, event.clientY - pointer.y)
        pointer.speed =
          pointer.speed * 0.65 +
          ((event.clientX - pointer.lastX) / Math.max(8, now - pointer.lastTime)) * 1000 * 0.35
        pointer.lastX = event.clientX
        pointer.lastTime = now
        if (fracture === 0 && Math.abs(dx) > dy * 1.2 && Math.abs(dx) > 16) side = dx < 0 ? 1 : -1
        const force = Math.hypot(dx * 0.85, dy)
        const deadZone = width * (pointer.baseFracture > 0 ? 0.055 : 0.14)
        const extension = Math.max(0, force - deadZone)
        let candidate: number
        if (pointer.baseFracture > 0) {
          candidate = pointer.baseFracture + extension / (width * 0.6)
        } else {
          // The last corner is tougher: the first pull can stop with a narrow, load-bearing neck.
          candidate =
            Math.min(0.775, extension / (width * 0.42)) + Math.max(0, force / width - 0.95) * 0.46
        }
        const next = clamp(Math.floor(candidate * 40) / 40, fracture, 1)
        if (next > fracture) {
          const broken = next - fracture
          fracture = next
          crackImpulse = Math.min(1, crackImpulse + broken * 5)
          velocity.angle += side * Math.min(0.5, broken * 2.5)
          velocity.pull += Math.min(7, broken * width * 0.1)
        }
        strain = clamp(force / (width * 0.65), 0, 1)
        const torque = (side * dy * 0.85 - dx * 0.95) / (pointer.grabY * 0.55 + width * 0.4)
        const resistance = fracture === 0 ? 0.28 : 0.72 + fracture * 0.28
        const angleLimit = pointer.baseFracture > 0 ? 0.64 : 0.53
        target.angle = clamp(
          pointer.baseAngle + Math.atan(torque) * resistance,
          -angleLimit,
          angleLimit
        )
        target.pull = Math.min(dy * 0.065, width * 0.06)
        target.lift = clamp(strain * 0.65 + fracture * 0.25, 0, 1)
        kick()
        if (fracture >= 1) release()
      },
      up(event) {
        if (pointer?.id !== event.pointerId) return
        // Releasing the mouse does not magically finish the cut or heal broken fibres.
        pointer = undefined
        delete element.dataset.dragging
        hang()
        kick()
        if (element.hasPointerCapture(event.pointerId))
          element.releasePointerCapture(event.pointerId)
      },
      phase() {
        if (latest.current.phase === 'tearing') kick()
      }
    }
    const cancelPull = () => {
      if (!pointer) return
      const id = pointer.id
      pointer = undefined
      delete element.dataset.dragging
      hang()
      if (element.hasPointerCapture(id)) element.releasePointerCapture(id)
      kick()
    }
    window.addEventListener('blur', cancelPull)
    const resized = () => {
      bounds()
      kick()
    }
    window.addEventListener('resize', resized)
    bounds()
    const resize = new ResizeObserver(() => {
      bounds()
      kick()
    })
    resize.observe(element)
    const contextLost = (event: Event) => {
      event.preventDefault()
      mesh = undefined
      element.dataset.renderer = 'fallback'
      kick()
    }
    surface.addEventListener('webglcontextlost', contextLost)
    image.onload = () => {
      if (disposed) return
      try {
        mesh = new ReceiptPaperMesh(surface, image, kick)
      } catch {
        element.dataset.renderer = 'fallback'
      }
      kick()
    }
    image.src = props.image.url
    kick()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      window.removeEventListener('blur', cancelPull)
      window.removeEventListener('resize', resized)
      surface.removeEventListener('webglcontextlost', contextLost)
      mesh?.dispose()
      image.onload = null
      controls.current = null
    }
  }, [props.image.url, props.image.width, props.image.height])

  useEffect(() => {
    controls.current?.phase()
  }, [props.phase, props.reducedMotion])
  return (
    <div
      ref={host}
      className="receipt-moving-paper"
      style={{ aspectRatio: `${props.image.width} / ${props.image.height}` } as CSSProperties}
      role="img"
      aria-label="用量小票，拖拽可弯曲并撕下纸张"
      onPointerDown={(event) => controls.current?.down(event)}
      onPointerMove={(event) => controls.current?.move(event)}
      onPointerUp={(event) => controls.current?.up(event)}
      onPointerCancel={(event) => controls.current?.up(event, true)}
      onLostPointerCapture={(event) => controls.current?.up(event, true)}
    >
      <img
        ref={fallback}
        src={props.image.url}
        className="receipt-paper-fallback"
        alt=""
        draggable={false}
      />
      <canvas ref={canvas} className="receipt-paper-surface" aria-hidden="true" />
    </div>
  )
}
