import { useEffect, useRef } from 'react'
import {
  advance,
  clampDelta,
  matrixColumns,
  pixelRatio,
  randomGlyph,
  starCount,
  type ShaderKind
} from '../themes/themeEngine'

/**
 * Live background canvas.
 *
 * Three lightweight renderers — starfield, code rain, thermal plasma — driven by
 * one `requestAnimationFrame` loop. The important properties here are the boring
 * ones:
 *
 *  - **One loop, always cancelled.** A leaked rAF keeps a whole window at full
 *    CPU while idle, which on a laptop is exactly the battery cost this feature
 *    is meant to look expensive but not be.
 *  - **DPR clamped to 2** and the canvas is resized only when the size actually
 *    changes, so dragging a window edge does not reallocate every frame.
 *  - **Eco-Saver stops the loop entirely** and clears the canvas to a static
 *    wash. Pausing by drawing less would still wake the compositor 60 times a
 *    second; stopping is the only version that saves the inverter.
 *  - **Hidden documents do not animate.** An occluded or minimised window
 *    resumes exactly where it stopped.
 */

const STAR_DENSITY = 260
const MATRIX_FONT_SIZE = 15
const MAX_MATRIX_COLUMNS = 160

interface Star {
  x: number
  y: number
  radius: number
  speed: number
  phase: number
  dust: boolean
}

interface RainColumn {
  x: number
  y: number
  speed: number
  glyphs: string[]
}

interface PlasmaBlob {
  x: number
  y: number
  radius: number
  driftX: number
  driftY: number
  hueShift: number
}

export default function LiveBackgroundCanvas({
  shader,
  /** The palette's accent, so the canvas belongs to the theme. */
  accent,
  secondary,
  /**
   * Paint one static wash and never start the loop: Eco-Saver or reduced motion.
   * The caller still passes a real shader so the frame is themed — passing
   * `shader="none"` means "no backdrop at all", which is a different decision.
   */
  paused = false
}: {
  shader: ShaderKind
  accent: string
  secondary: string
  paused?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || shader === 'none') return
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return

    let width = 0
    let height = 0
    let frame = 0
    let last = 0
    let running = true

    let stars: Star[] = []
    let columns: RainColumn[] = []
    let blobs: PlasmaBlob[] = []

    const resize = (): boolean => {
      const ratio = pixelRatio(window.devicePixelRatio)
      const nextWidth = Math.max(Math.floor(window.innerWidth), 1)
      const nextHeight = Math.max(Math.floor(window.innerHeight), 1)
      if (nextWidth === width && nextHeight === height && canvas.width === Math.floor(nextWidth * ratio)) {
        return false
      }
      width = nextWidth
      height = nextHeight
      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      seed()
      return true
    }

    const seed = (): void => {
      if (shader === 'galaxy') {
        const count = starCount(width, height, STAR_DENSITY)
        stars = Array.from({ length: count }, () => ({
          x: Math.random() * width,
          y: Math.random() * height,
          radius: Math.random() * 1.4 + 0.3,
          speed: Math.random() * 0.18 + 0.02,
          phase: Math.random() * Math.PI * 2,
          dust: Math.random() > 0.78
        }))
      } else if (shader === 'matrix') {
        const count = Math.min(matrixColumns(width, MATRIX_FONT_SIZE), MAX_MATRIX_COLUMNS)
        columns = Array.from({ length: count }, (_, index) => ({
          x: index * MATRIX_FONT_SIZE,
          y: Math.random() * height,
          speed: Math.random() * 1.6 + 0.6,
          glyphs: Array.from({ length: Math.ceil(height / MATRIX_FONT_SIZE) }, () => randomGlyph())
        }))
      } else {
        blobs = [
          {
            x: width * 0.28,
            y: height * 0.32,
            radius: Math.max(width, height) * 0.42,
            driftX: 0.12,
            driftY: 0.09,
            hueShift: 0
          },
          {
            x: width * 0.72,
            y: height * 0.68,
            radius: Math.max(width, height) * 0.38,
            driftX: -0.09,
            driftY: 0.11,
            hueShift: 0.5
          },
          {
            x: width * 0.5,
            y: height * 0.5,
            radius: Math.max(width, height) * 0.5,
            driftX: 0.05,
            driftY: -0.07,
            hueShift: 0.82
          }
        ]
      }
    }

    const clear = (): void => {
      context.clearRect(0, 0, width, height)
    }

    const drawGalaxy = (time: number, delta: number): void => {
      clear()
      for (const star of stars) {
        star.y = advance(star.y, star.speed, delta)
        if (star.y > height + 2) {
          star.y = -2
          star.x = Math.random() * width
        }
        const twinkle = 0.45 + 0.55 * Math.abs(Math.sin(time * 0.0009 + star.phase))
        context.globalAlpha = star.dust ? twinkle * 0.35 : twinkle * 0.85
        context.fillStyle = star.dust ? secondary : accent
        context.beginPath()
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1
    }

    const drawMatrix = (time: number, delta: number): void => {
      // Trail instead of a full clear: the fading tail is what makes code rain
      // read as rain rather than as scattered glyphs.
      context.globalAlpha = 1
      context.fillStyle = 'rgba(3, 8, 6, 0.16)'
      context.fillRect(0, 0, width, height)
      context.font = `${MATRIX_FONT_SIZE}px ui-monospace, monospace`
      context.textBaseline = 'top'
      for (const column of columns) {
        column.y = advance(column.y, column.speed, delta)
        const row = Math.floor(column.y / MATRIX_FONT_SIZE)
        if (row >= column.glyphs.length) {
          column.y = -MATRIX_FONT_SIZE
          column.glyphs = column.glyphs.map(() => randomGlyph())
          column.speed = Math.random() * 1.6 + 0.6
          continue
        }
        if (Math.random() > 0.94) column.glyphs[row] = randomGlyph()
        // Head glyph is brightest, then a short comet tail.
        for (let trail = 0; trail < 12; trail++) {
          const glyphRow = row - trail
          if (glyphRow < 0 || glyphRow >= column.glyphs.length) break
          context.globalAlpha = trail === 0 ? 0.95 : Math.max(0.06, 0.55 - trail * 0.05)
          context.fillStyle = trail === 0 ? secondary : accent
          context.fillText(column.glyphs[glyphRow], column.x, glyphRow * MATRIX_FONT_SIZE)
        }
      }
      context.globalAlpha = 1
      void time
    }

    const drawSolar = (time: number, delta: number): void => {
      clear()
      for (const blob of blobs) {
        blob.x += blob.driftX * (delta / 16.6667)
        blob.y += blob.driftY * (delta / 16.6667)
        // Bounce inside the viewport so the plasma never drifts off-screen.
        if (blob.x < -blob.radius * 0.3 || blob.x > width + blob.radius * 0.3) blob.driftX *= -1
        if (blob.y < -blob.radius * 0.3 || blob.y > height + blob.radius * 0.3) blob.driftY *= -1
        const pulse = 1 + Math.sin(time * 0.0006 + blob.hueShift * Math.PI) * 0.06
        const gradient = context.createRadialGradient(
          blob.x,
          blob.y,
          0,
          blob.x,
          blob.y,
          blob.radius * pulse
        )
        gradient.addColorStop(0, withAlpha(blob.hueShift > 0.4 ? secondary : accent, 0.16))
        gradient.addColorStop(0.55, withAlpha(accent, 0.05))
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
        context.fillStyle = gradient
        context.beginPath()
        context.arc(blob.x, blob.y, blob.radius * pulse, 0, Math.PI * 2)
        context.fill()
      }
    }

    const render = (kind: ShaderKind, time: number, delta: number): void => {
      if (kind === 'galaxy') drawGalaxy(time, delta)
      else if (kind === 'matrix') drawMatrix(time, delta)
      else drawSolar(time, delta)
    }

    /** Static frame used under Eco-Saver: one wash, then nothing. */
    const staticFrame = (): void => {
      clear()
      const gradient = context.createRadialGradient(
        width * 0.3,
        height * 0.2,
        0,
        width * 0.3,
        height * 0.2,
        Math.max(width, height) * 0.7
      )
      gradient.addColorStop(0, withAlpha(accent, 0.1))
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
      context.fillStyle = gradient
      context.fillRect(0, 0, width, height)
    }

    const tick = (now: number): void => {
      if (!running) return
      const delta = clampDelta(last ? now - last : 16.6667)
      last = now
      render(shader, now, delta)
      frame = requestAnimationFrame(tick)
    }

    const start = (): void => {
      if (running && frame) return
      running = true
      last = 0
      if (paused) {
        staticFrame()
        return
      }
      frame = requestAnimationFrame(tick)
    }

    const stop = (): void => {
      running = false
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    }

    const onResize = (): void => {
      // A resize reseeds, so the static wash must be redrawn too.
      if (resize() && paused) staticFrame()
    }

    const onVisibility = (): void => {
      if (document.hidden) stop()
      else start()
    }

    resize()
    start()
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stop()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [shader, accent, secondary, paused])

  if (shader === 'none') return null

  return (
    <canvas
      ref={canvasRef}
      className="live-background"
      data-shader={shader}
      data-paused={paused ? 'true' : 'false'}
      aria-hidden="true"
    />
  )
}

/**
 * Apply an alpha to a CSS colour.
 *
 * Accepts `#rgb`, `#rrggbb` and `rgb()/rgba()`; anything else (a gradient or a
 * `color-mix()` expression) falls back to a low-opacity accent rather than
 * producing an invalid gradient stop, which would make the canvas silently blank.
 */
export function withAlpha(color: string, alpha: number): string {
  const value = color.trim()
  const clamp = Math.min(Math.max(alpha, 0), 1)
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value)
  if (hex) {
    const raw = hex[1]
    const expanded =
      raw.length === 3
        ? raw
            .split('')
            .map((char) => char + char)
            .join('')
        : raw
    const red = parseInt(expanded.slice(0, 2), 16)
    const green = parseInt(expanded.slice(2, 4), 16)
    const blue = parseInt(expanded.slice(4, 6), 16)
    return `rgba(${red}, ${green}, ${blue}, ${clamp})`
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)
  if (rgb) {
    const parts = rgb[1].split(',').map((part) => part.trim())
    if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${clamp})`
  }
  return `rgba(120, 160, 255, ${clamp * 0.6})`
}
