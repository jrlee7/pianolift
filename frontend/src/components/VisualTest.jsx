// Visual Sync Test: a falling-notes keyboard that plays "Teach Me to Walk in
// the Light" on screen (shown on the TV over HDMI) while the same notes fire on
// the Disklavier through the real scheduler. Watch a key light up on the TV and
// hear the piano strike — any gap is the residual sync error. Nudge it to zero
// with the slider / , . keys and save as the new default.
//
// It drives the ACTUAL createVideoMidiPlayer via a "virtual video" shim (a fake
// <video> whose currentTime advances in real time), so syncMs, pedal lag and
// the hardware calibration all behave exactly as they do for real videos.

import { useEffect, useRef, useState } from 'react'
import { prepareEvents, createVideoMidiPlayer } from '../videoMidiPlayer.js'
import { effectiveCalibration } from '../calibrate.js'
import { TEACH_ME_HYMN } from '../teachMeHymn.js'

const VIS_LOOKAHEAD = 3.0   // seconds of notes visible falling toward the line
const LOW = 36              // C2
const HIGH = 84             // C6
const WHITE = [0, 2, 4, 5, 7, 9, 11]

function isWhite(pitch) { return WHITE.indexOf(pitch % 12) !== -1 }

// A minimal <video> stand-in: currentTime advances in real time while playing;
// the scheduler reads it every tick just like a real element.
function createVirtualVideo(duration) {
  let paused = true
  let ended = false
  let base = 0            // currentTime at the last play/seek
  let anchorPerf = 0      // performance.now at the last play/seek
  const listeners = {}

  function emit(type) {
    (listeners[type] || []).forEach(function (fn) { fn() })
  }

  const v = {
    playbackRate: 1,
    duration: duration,
    get paused() { return paused },
    get ended() { return ended },
    get currentTime() {
      if (paused) return base
      const t = base + (performance.now() - anchorPerf) / 1000 * v.playbackRate
      return t >= duration ? duration : t
    },
    set currentTime(t) {
      base = Math.max(0, Math.min(duration, t))
      anchorPerf = performance.now()
      ended = false
      emit('seeking'); emit('seeked')
    },
    play() {
      if (!paused) return
      if (v.currentTime >= duration) { base = 0 }
      anchorPerf = performance.now()
      paused = false
      ended = false
      emit('play')
    },
    pause() {
      if (paused) return
      base = v.currentTime
      paused = true
      emit('pause')
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn)
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter(function (f) { return f !== fn })
    },
    _tickEnd() {
      if (!paused && !ended && v.currentTime >= duration) {
        ended = true
        paused = true
        base = duration
        emit('ended')
      }
    }
  }
  return v
}

export default function VisualTest({ midi, syncMs, pedalMs, velScale, pedalOn,
                                     calibration, onSyncChange, onClose }) {
  const canvasRef = useRef(null)
  const vvRef = useRef(null)
  const playerRef = useRef(null)
  const rafRef = useRef(0)
  const perfRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)
  playingRef.current = playing

  // keep the live scheduler in step with props
  const syncRef = useRef(syncMs)
  syncRef.current = syncMs

  // Build events + player once.
  useEffect(function () {
    const prepared = prepareEvents(TEACH_ME_HYMN.events, { releaseMs: 0, capSustain: false }, true, 0)
    perfRef.current = prepared
    const vv = createVirtualVideo(TEACH_ME_HYMN.duration)
    vvRef.current = vv
    const eff = effectiveCalibration(calibration)
    const player = createVideoMidiPlayer(vv, midi, prepared, {
      syncMs: syncMs, pedalMs: pedalMs, velScale: velScale, pedalOn: pedalOn,
      latencyCurve: eff.curve, tvLatencyMs: eff.tvLatencyMs, uniformComp: eff.uniformComp
    })
    player.attach()
    playerRef.current = player

    function loop() {
      vv._tickEnd()
      draw()
      // keep the button in step with the virtual clock (e.g. natural end)
      if (playingRef.current !== !vv.paused) setPlaying(!vv.paused)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)

    return function () {
      cancelAnimationFrame(rafRef.current)
      player.detach()
      playerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live parameter pushes to the running scheduler.
  useEffect(function () {
    if (playerRef.current) playerRef.current.setSyncMs(syncMs)
  }, [syncMs])
  useEffect(function () {
    if (playerRef.current) playerRef.current.setPedalLagMs(pedalMs)
  }, [pedalMs])
  useEffect(function () {
    if (playerRef.current && calibration) {
      const eff = effectiveCalibration(calibration)
      playerRef.current.setCalibration(eff.curve, eff.tvLatencyMs, { uniformComp: eff.uniformComp })
    }
  }, [calibration])

  // Keyboard nudge while the test runs.
  useEffect(function () {
    function onKey(e) {
      if (e.key === ',') onSyncChange(Math.round(syncRef.current - 5))
      else if (e.key === '.') onSyncChange(Math.round(syncRef.current + 5))
      else if (e.code === 'Space') { e.preventDefault(); toggle() }
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return function () { window.removeEventListener('keydown', onKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggle() {
    const vv = vvRef.current
    if (!vv) return
    if (vv.paused) { vv.play(); setPlaying(true) }
    else { vv.pause(); setPlaying(false) }
  }

  function restart() {
    const vv = vvRef.current
    if (!vv) return
    vv.currentTime = 0
    vv.play()
    setPlaying(true)
  }

  // ---- rendering --------------------------------------------------------
  function keyGeometry(w, kbTop, kbH) {
    // white-key layout across [LOW, HIGH]
    const whites = []
    for (let p = LOW; p <= HIGH; p++) if (isWhite(p)) whites.push(p)
    const ww = w / whites.length
    const xOf = {}
    for (let i = 0; i < whites.length; i++) xOf[whites[i]] = i * ww
    // black keys sit between their neighbors
    function xForPitch(p) {
      if (isWhite(p)) return { x: xOf[p], w: ww, black: false }
      // black key: place over the gap after the white key below it
      const below = p - 1
      const bx = (xOf[below] != null ? xOf[below] : 0) + ww * 0.66
      return { x: bx, w: ww * 0.66, black: true }
    }
    return { whites: whites, ww: ww, xForPitch: xForPitch, kbTop: kbTop, kbH: kbH }
  }

  function draw() {
    const canvas = canvasRef.current
    const vv = vvRef.current
    const prepared = perfRef.current
    if (!canvas || !vv || !prepared) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width
    const h = canvas.height
    const kbH = Math.min(160, h * 0.28)
    const kbTop = h - kbH
    const g = keyGeometry(w, kbTop, kbH)
    const t = vv.currentTime

    ctx.clearRect(0, 0, w, h)
    // background
    ctx.fillStyle = '#0d0f14'
    ctx.fillRect(0, 0, w, h)

    // falling notes (raw timeline; the strike line = "now")
    const notes = prepared.notes
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      const dt = n.tOn - t
      if (dt > VIS_LOOKAHEAD || n.tOff - t < -0.2) continue
      const geo = g.xForPitch(n.pitch)
      // y of the note's leading edge: top when dt==LOOKAHEAD, strike line at dt==0
      const yHit = kbTop
      const y = yHit * (1 - dt / VIS_LOOKAHEAD)
      const len = ((n.tOff - n.tOn) / VIS_LOOKAHEAD) * yHit
      const nearNow = dt <= 0.03 && n.tOff - t > 0
      ctx.fillStyle = geo.black
        ? (nearNow ? '#7cc4ff' : '#3b6ea5')
        : (nearNow ? '#a9e5ff' : '#5b8fd6')
      ctx.fillRect(geo.x + 1, y - len, Math.max(2, geo.w - 2), Math.max(3, len))
    }

    // strike line
    ctx.strokeStyle = '#ff5a7a'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(0, kbTop); ctx.lineTo(w, kbTop); ctx.stroke()

    // keyboard — white keys first, then black
    for (let i = 0; i < g.whites.length; i++) {
      const p = g.whites[i]
      const lit = isPitchSounding(notes, p, t)
      ctx.fillStyle = lit ? '#ffd45e' : '#f4f4f4'
      ctx.fillRect(i * g.ww + 0.5, kbTop, g.ww - 1, kbH)
      ctx.strokeStyle = '#333'
      ctx.strokeRect(i * g.ww + 0.5, kbTop, g.ww - 1, kbH)
    }
    for (let p = LOW; p <= HIGH; p++) {
      if (isWhite(p)) continue
      const geo = g.xForPitch(p)
      const lit = isPitchSounding(notes, p, t)
      ctx.fillStyle = lit ? '#e0a800' : '#1a1a1a'
      ctx.fillRect(geo.x, kbTop, geo.w, kbH * 0.62)
    }
  }

  function isPitchSounding(notes, pitch, t) {
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      if (n.pitch === pitch && t >= n.tOn && t <= Math.min(n.tOff, n.tOn + 0.5)) return true
      if (n.tOn > t + 0.01) break
    }
    return false
  }

  // Resize canvas to its container.
  useEffect(function () {
    function fit() {
      const c = canvasRef.current
      if (!c) return
      c.width = c.clientWidth
      c.height = c.clientHeight
    }
    fit()
    window.addEventListener('resize', fit)
    return function () { window.removeEventListener('resize', fit) }
  }, [])

  return (
    <div className="visual-test">
      <div className="vt-bar">
        <button className="primary" onClick={toggle}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button onClick={restart}>↺ Restart</button>
        <div className="vt-sync">
          <button onClick={function () { onSyncChange(Math.round(syncMs - 10)) }}>−10</button>
          <input type="range" min="-500" max="500" step="5" value={syncMs}
            onChange={function (e) { onSyncChange(parseFloat(e.target.value)) }} />
          <button onClick={function () { onSyncChange(Math.round(syncMs + 10)) }}>+10</button>
          <strong>{Math.round(syncMs)} ms</strong>
        </div>
        <span className="meta">Watch a key light, hear the piano — nudge with , and . until they match.</span>
        <button onClick={onClose}>✕ Close</button>
      </div>
      <canvas ref={canvasRef} className="vt-canvas" />
    </div>
  )
}
