import { useEffect, useRef } from 'react'

const PX_PER_SEC = 40
const NOTE_H = 3
const PITCH_MIN = 21
const PITCH_MAX = 108
const ROLL_H = (PITCH_MAX - PITCH_MIN + 1) * NOTE_H
const PEDAL_H = 14
const HEIGHT = ROLL_H + PEDAL_H + 4

export default function PianoRoll({ events, playheadSec }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)

  const duration = eventsDuration(events)
  const width = Math.max(600, Math.ceil(duration * PX_PER_SEC) + 40)

  useEffect(function () {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, width, HEIGHT)

    // beat-ish grid every second
    ctx.strokeStyle = '#1a1e26'
    ctx.lineWidth = 1
    for (let s = 0; s <= duration + 1; s++) {
      const x = s * PX_PER_SEC + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, ROLL_H)
      ctx.stroke()
      if (s % 10 === 0) {
        ctx.fillStyle = '#4a5160'
        ctx.font = '10px sans-serif'
        ctx.fillText(formatTime(s), x + 3, 10)
      }
    }

    // pedal lane
    ctx.fillStyle = '#232a3a'
    for (let i = 0; i < events.pedals.length; i++) {
      const p = events.pedals[i]
      ctx.fillRect(
        p.onset * PX_PER_SEC, ROLL_H + 4,
        (p.offset - p.onset) * PX_PER_SEC, PEDAL_H - 4)
    }

    // notes colored by velocity
    for (let i = 0; i < events.notes.length; i++) {
      const n = events.notes[i]
      const x = n.onset * PX_PER_SEC
      const w = Math.max(2, (n.offset - n.onset) * PX_PER_SEC)
      const y = (PITCH_MAX - n.pitch) * NOTE_H
      const v = n.velocity / 127
      // quiet = blue, loud = amber
      const r = Math.round(80 + v * 152)
      const g = Math.round(110 + v * 70)
      const b = Math.round(230 - v * 156)
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')'
      ctx.fillRect(x, y, w, NOTE_H - 1)
    }
  }, [events, width, duration])

  // playhead drawn via overlaid div so canvas doesn't redraw each frame
  useEffect(function () {
    const wrap = wrapRef.current
    if (!wrap) return
    if (playheadSec > 0) {
      const x = playheadSec * PX_PER_SEC
      const view = wrap.clientWidth
      if (x < wrap.scrollLeft || x > wrap.scrollLeft + view - 60) {
        wrap.scrollLeft = Math.max(0, x - view / 4)
      }
    }
  }, [playheadSec])

  return (
    <div className="pianoroll-wrap" ref={wrapRef} style={{ position: 'relative' }}>
      <canvas ref={canvasRef} width={width} height={HEIGHT} />
      {playheadSec > 0 && (
        <div style={{
          position: 'absolute',
          left: playheadSec * PX_PER_SEC,
          top: 0,
          width: 1,
          height: HEIGHT,
          background: '#e8b44a',
          pointerEvents: 'none'
        }} />
      )}
    </div>
  )
}

function eventsDuration(events) {
  let end = 10
  const notes = events.notes
  const pedals = events.pedals
  if (notes.length > 0) {
    end = Math.max(end, notes[notes.length - 1].offset)
  }
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].offset > end) end = notes[i].offset
  }
  if (pedals.length > 0) {
    const lastPedal = pedals[pedals.length - 1].offset
    if (lastPedal > end) end = lastPedal
  }
  return end
}

function formatTime(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m + ':' + (sec < 10 ? '0' : '') + sec
}
