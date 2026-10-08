// Envelope display: renders the DAHDSR shape from the current parameters, and (SP-EXT) edits it directly -- the six
// stage handles plus the three segment curves can be dragged. The knob row below still works; this is the same
// parameters, written through the same engine.setParam path, so the DSP, the worklet and the parameter registry are
// untouched.

import { paramIndex, normToValue, valueToNorm, PARAMS } from '../shared/params'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'

function shape(t: number, c: number): number {
  return Math.pow(t, Math.pow(2, c * 3))
}

export class EnvDisplay {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly cx: CanvasRenderingContext2D
  private w = 0
  private h = 0

  constructor(private readonly engine: SynthEngine, private env: number) {
    this.root = el('div', 'env-display')
    this.canvas = el('canvas')
    this.root.appendChild(this.canvas)
    this.cx = this.canvas.getContext('2d')!
    this.canvas.style.touchAction = 'none'
    this.canvas.style.cursor = 'crosshair'
    this.canvas.addEventListener('pointerdown', this.onDown)
    this.canvas.addEventListener('pointermove', this.onMove)
    this.canvas.addEventListener('pointerup', this.onUp)
    this.canvas.addEventListener('pointercancel', this.onUp)
    new ResizeObserver(() => this.resize()).observe(this.root)
    // redraw when any env param of any envelope changes (cheap enough)
    for (let e = 1; e <= 6; e++) {
      for (const f of ['delay', 'attack', 'hold', 'decay', 'sustain', 'release', 'atk_curve', 'dec_curve', 'rel_curve']) {
        engine.onParam(paramIndex(`env${e}.${f}`), () => this.draw())
      }
    }
  }

  // ── SP-EXT: direct editing ─────────────────────────────────────────────────────────────────────────────
  private handles: { field: string; kind: 'time' | 'level' | 'curve'; x: number; y: number }[] = []
  private drag: { field: string; kind: string; grabX: number } | null = null

  private setValue(field: string, value: number): void {
    const i = paramIndex(`env${this.env}.${field}`)
    const v = Math.min(1, Math.max(0, valueToNorm(PARAMS[i], value)))
    this.engine.setParam(i, v)
    this.draw()
  }

  private onDown = (e: PointerEvent): void => {
    const r = this.canvas.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    let best: (typeof this.handles)[number] | null = null
    let bestD = 14
    for (const h of this.handles) {
      const d = Math.hypot(h.x - px, h.y - py)
      if (d < bestD) { bestD = d; best = h }
    }
    if (!best) return
    this.drag = { field: best.field, kind: best.kind, grabX: px }
    this.canvas.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return
    const r = this.canvas.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    if (this.drag.kind === 'level') {                       // sustain: the height of the held part
      this.setValue('sustain', Math.min(1, Math.max(0, 1 - (py - 5) / ((this.h - 10) || 1))))
    } else if (this.drag.kind === 'curve') {                // drag a segment up/down to bend it
      const c = Math.min(1, Math.max(-1, 1 - 2 * ((py - 5) / ((this.h - 10) || 1))))
      const field = this.drag.field
      if (field === 'attack') this.setValue('atk_curve', c)
      else if (field === 'decay') this.setValue('dec_curve', c)
      else this.setValue('rel_curve', c)
    } else {                                                 // times: move the handle sideways
      const cur = this.v(this.drag.field)
      const perPx = (this.v('delay') + this.v('attack') + this.v('hold') + this.v('decay') + this.v('release')) / ((this.w - 8) || 1)
      this.setValue(this.drag.field, Math.max(0.0005, cur + (px - this.drag.grabX) * perPx))
      this.drag.grabX = px
    }
    e.preventDefault()
  }

  private onUp = (e: PointerEvent): void => { this.drag = null; try { this.canvas.releasePointerCapture(e.pointerId) } catch {} }

  setEnv(env: number): void {
    this.env = env
    this.draw()
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    this.w = this.root.clientWidth
    this.h = this.root.clientHeight
    this.canvas.width = this.w * dpr
    this.canvas.height = this.h * dpr
    this.canvas.style.width = `${this.w}px`
    this.canvas.style.height = `${this.h}px`
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.draw()
  }

  private v(field: string): number {
    const i = paramIndex(`env${this.env}.${field}`)
    return normToValue(PARAMS[i], this.engine.getParam(i))
  }

  draw(): void {
    const c = this.cx
    const w = this.w
    const h = this.h
    if (!w || !h) return
    c.clearRect(0, 0, w, h)

    const del = this.v('delay')
    const atk = this.v('attack')
    const hold = this.v('hold')
    const dec = this.v('decay')
    const sus = this.v('sustain')
    const rel = this.v('release')
    const ac = this.v('atk_curve')
    const dc = this.v('dec_curve')
    const rc = this.v('rel_curve')

    const susTime = Math.max(0.15 * (del + atk + hold + dec + rel), 0.05)
    const total = del + atk + hold + dec + susTime + rel
    const X = (t: number) => (t / total) * (w - 8) + 4
    const Y = (v: number) => (1 - v) * (h - 10) + 5

    c.beginPath()
    c.moveTo(X(0), Y(0))
    c.lineTo(X(del), Y(0))
    const N = 40
    for (let i = 1; i <= N; i++) c.lineTo(X(del + (i / N) * atk), Y(shape(i / N, ac)))
    c.lineTo(X(del + atk + hold), Y(1))
    for (let i = 1; i <= N; i++) c.lineTo(X(del + atk + hold + (i / N) * dec), Y(sus + (1 - sus) * (1 - shape(i / N, -dc))))
    c.lineTo(X(del + atk + hold + dec + susTime), Y(sus))
    for (let i = 1; i <= N; i++) c.lineTo(X(del + atk + hold + dec + susTime + (i / N) * rel), Y(sus * (1 - shape(i / N, -rc))))
    c.strokeStyle = '#ff9a3c'
    c.lineWidth = 2
    c.stroke()
    c.lineTo(X(total), Y(0) + 5)
    c.lineTo(X(0), Y(0) + 5)
    c.closePath()
    c.fillStyle = '#ff9a3c15'
    c.fill()

    // SP-EXT: the drag handles, at the same coordinates the shape is drawn with
    const susX = X(del + atk + hold + dec + susTime / 2)
    this.handles = [
      { field: 'delay', kind: 'time', x: X(del), y: Y(0) },
      { field: 'attack', kind: 'time', x: X(del + atk), y: Y(1) },
      { field: 'hold', kind: 'time', x: X(del + atk + hold), y: Y(1) },
      { field: 'decay', kind: 'time', x: X(del + atk + hold + dec), y: Y(sus) },
      { field: 'release', kind: 'time', x: X(total), y: Y(0) },
      { field: 'sustain', kind: 'level', x: susX, y: Y(sus) },
      { field: 'attack', kind: 'curve', x: X(del + atk / 2), y: Y(shape(0.5, ac)) },
      { field: 'decay', kind: 'curve', x: X(del + atk + hold + dec / 2), y: Y(sus + (1 - sus) * (1 - shape(0.5, -dc))) },
      { field: 'release', kind: 'curve', x: X(del + atk + hold + dec + susTime + rel / 2), y: Y(sus * (1 - shape(0.5, -rc))) },
    ]
    c.fillStyle = '#ff9a3c'
    for (const hd of this.handles) { c.beginPath(); c.arc(hd.x, hd.y, 3.5, 0, Math.PI * 2); c.fill() }

    // live value line
    const live = this.engine.sourceValues[this.env - 1] ?? 0
    if (live > 0.001) {
      c.beginPath()
      c.moveTo(0, Y(live))
      c.lineTo(w, Y(live))
      c.strokeStyle = '#ff9a3c50'
      c.lineWidth = 1
      c.stroke()
    }
  }
}
