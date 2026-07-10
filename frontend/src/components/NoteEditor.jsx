import { useEffect, useRef, useState } from 'react'

// Vertical piano-roll editor (Synthesia-style): a real 88-key keyboard sits
// fixed along the bottom, time runs up the screen, and each note falls in its
// key's column onto the keyboard. Keys light as the playhead reaches them.
// Select/move/resize/delete notes, hunt ghost notes, draw sustain-pedal
// segments (right lane), trim, undo/redo. Edits live in the parent's `events`
// state; Save persists them so every export (MIDI, E-SEQ, .hfe, USB) picks
// them up.

const PITCH_MIN = 21
const PITCH_MAX = 108
const BLACK_PC = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 }

const WKEY_W = 13          // white-key column width
const BKEY_W = 8           // black-key column width
const GUTTER = 26          // left time-label gutter
const PEDAL_W = 16         // right sustain-pedal lane
const PAD = 10             // top/bottom padding inside the scroll content
const KB_H = 66            // bottom keyboard height
const KB_BLACK_H = 42

// Key geometry: map each pitch to a center x, flag black keys, and record the
// white-key order for x->pitch lookups. White keys are equal width; black keys
// sit on the boundary between their neighbors.
const KEY_CX = {}
const KEY_IS_BLACK = {}
const WHITE_PITCHES = []
;(function () {
  let wc = 0
  for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
    const blk = !!BLACK_PC[p % 12]
    KEY_IS_BLACK[p] = blk
    if (blk) {
      KEY_CX[p] = wc * WKEY_W
    } else {
      KEY_CX[p] = wc * WKEY_W + WKEY_W / 2
      WHITE_PITCHES.push(p)
      wc++
    }
  }
})()
const N_WHITE = WHITE_PITCHES.length
const ROLL_W = N_WHITE * WKEY_W
const PEDAL_X = GUTTER + ROLL_W
const STAGE_W = GUTTER + ROLL_W + PEDAL_W

const MIN_DUR = 0.05
const EDGE_PX = 5

// Physical audible-ring ceiling by pitch — mirrors the backend's
// midi_writer.max_sustain_sec so the baked cap matches what exports produce.
// Bass strings ring ~30s with the key held; the top octave barely 1s.
function maxSustainSec(pitch) {
  const p = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch))
  const frac = (p - PITCH_MIN) / (PITCH_MAX - PITCH_MIN)
  return 30 * Math.pow(1 / 30, frac)
}
const PX_MIN = 10
const PX_MAX = 240
const NEW_NOTE_VEL = 85

function keyW(p) { return KEY_IS_BLACK[p] ? BKEY_W : WKEY_W }

// Roll-local x (0..ROLL_W) -> pitch. Black keys are narrower and on top, so
// test them first, then fall back to the white column.
function pitchAtX(rx) {
  for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
    if (KEY_IS_BLACK[p] && Math.abs(rx - KEY_CX[p]) <= BKEY_W / 2) return p
  }
  let w = Math.floor(rx / WKEY_W)
  if (w < 0) w = 0
  if (w >= N_WHITE) w = N_WHITE - 1
  return WHITE_PITCHES[w]
}

// tiny audition synth so clicking / adding a note is audible
let auditionCtx = null
function audition(pitch, velocity) {
  try {
    if (!auditionCtx) {
      auditionCtx = new (window.AudioContext || window.webkitAudioContext)()
    }
    const ctx = auditionCtx
    if (ctx.state === 'suspended') ctx.resume()
    const t = ctx.currentTime
    const freq = 440 * Math.pow(2, (pitch - 69) / 12)
    const gain = ctx.createGain()
    const level = Math.pow(velocity / 127, 1.6) * 0.3
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(level, t + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0004, t + 0.45)
    gain.connect(ctx.destination)
    const o1 = ctx.createOscillator()
    o1.type = 'triangle'
    o1.frequency.value = freq
    o1.connect(gain)
    o1.start(t)
    o1.stop(t + 0.5)
  } catch (e) { /* audio not available; stay silent */ }
}

function byOnset(a, b) { return a.onset - b.onset }

function clampPitch(p) {
  return Math.min(PITCH_MAX, Math.max(PITCH_MIN, p))
}

function mergePedals(pedals) {
  if (pedals.length < 2) return pedals
  const sorted = pedals.slice().sort(byOnset)
  const out = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1]
    const p = sorted[i]
    if (p.onset <= prev.offset) {
      if (p.offset > prev.offset) {
        out[out.length - 1] = {
          _id: prev._id, onset: prev.onset, offset: p.offset
        }
      }
    } else {
      out.push(p)
    }
  }
  return out
}

export default function NoteEditor({
  events, onChange, onSave, onReset, dirty, saving, playheadSec, onSeek,
  trimStart, trimEnd, onApplyTrim, trimming, hasAccompaniment,
  onPlay, onRestart, previewing
}) {
  const [pxPerSec, setPxPerSec] = useState(40)
  const [tool, setTool] = useState('select')
  const [sel, setSel] = useState({ notes: new Set(), pedals: new Set() })
  const [marquee, setMarquee] = useState(null)
  const [ghostDur, setGhostDur] = useState(90)
  const [ghostVel, setGhostVel] = useState(30)
  const [ghostMsg, setGhostMsg] = useState('')
  const [capMsg, setCapMsg] = useState('')
  const [trimMode, setTrimMode] = useState(false)
  const [trimLo, setTrimLo] = useState(trimStart || 0)
  const [trimHi, setTrimHi] = useState(trimEnd)

  const canvasRef = useRef(null)
  const keyboardRef = useRef(null)
  const wrapRef = useRef(null)
  const dragRef = useRef(null)
  const eventsRef = useRef(events)
  const undoRef = useRef({ undo: [], redo: [] })

  eventsRef.current = events

  const duration = eventsDuration(events)
  const contentH = Math.max(320, Math.ceil(duration * pxPerSec) + PAD * 2)

  // Time <-> screen-y. Time runs UP: t=0 sits at the bottom (by the keyboard),
  // later time is higher. A note's onset is its lower edge (nearest the keys).
  function yOf(t) { return (duration - t) * pxPerSec + PAD }
  function tOf(y) { return duration - (y - PAD) / pxPerSec }

  const hiVal = (trimHi == null) ? duration : trimHi
  const trimLoRef = useRef(trimLo)
  const trimHiRef = useRef(hiVal)
  trimLoRef.current = trimLo
  trimHiRef.current = hiVal

  useEffect(function () {
    setTrimLo(trimStart || 0)
    setTrimHi(trimEnd)
  }, [trimStart, trimEnd])

  function apply(next) {
    eventsRef.current = next
    onChange(next)
  }

  // ---------- undo/redo ----------

  function pushUndo() {
    const st = undoRef.current
    st.undo.push(eventsRef.current)
    if (st.undo.length > 100) st.undo.shift()
    st.redo.length = 0
  }

  function undo() {
    const st = undoRef.current
    if (st.undo.length === 0) return
    st.redo.push(eventsRef.current)
    apply(st.undo.pop())
    clearSelection()
  }

  function redo() {
    const st = undoRef.current
    if (st.redo.length === 0) return
    st.undo.push(eventsRef.current)
    apply(st.redo.pop())
    clearSelection()
  }

  // ---------- mutation helpers ----------

  function commit(nextNotes, nextPedals) {
    const cur = eventsRef.current
    apply({
      notes: (nextNotes || cur.notes).slice().sort(byOnset),
      pedals: nextPedals || cur.pedals
    })
  }

  function newId() {
    let m = 0
    const ev = eventsRef.current
    for (let i = 0; i < ev.notes.length; i++) {
      if (ev.notes[i]._id > m) m = ev.notes[i]._id
    }
    for (let i = 0; i < ev.pedals.length; i++) {
      if (ev.pedals[i]._id > m) m = ev.pedals[i]._id
    }
    return m + 1
  }

  function clearSelection() {
    setSel({ notes: new Set(), pedals: new Set() })
    setGhostMsg('')
  }

  function selectAll() {
    const ev = eventsRef.current
    const ids = new Set()
    for (let i = 0; i < ev.notes.length; i++) ids.add(ev.notes[i]._id)
    setSel({ notes: ids, pedals: new Set() })
    setGhostMsg('')
  }

  function deleteSelected() {
    if (sel.notes.size === 0 && sel.pedals.size === 0) return
    pushUndo()
    const ev = eventsRef.current
    const notes = []
    for (let i = 0; i < ev.notes.length; i++) {
      if (!sel.notes.has(ev.notes[i]._id)) notes.push(ev.notes[i])
    }
    const pedals = []
    for (let i = 0; i < ev.pedals.length; i++) {
      if (!sel.pedals.has(ev.pedals[i]._id)) pedals.push(ev.pedals[i])
    }
    commit(notes, pedals)
    clearSelection()
  }

  function setSelectedVelocity(v) {
    const ev = eventsRef.current
    const notes = []
    for (let i = 0; i < ev.notes.length; i++) {
      const n = ev.notes[i]
      notes.push(sel.notes.has(n._id)
        ? { _id: n._id, onset: n.onset, offset: n.offset, pitch: n.pitch, velocity: v }
        : n)
    }
    commit(notes, null)
  }

  // ---------- ghost notes ----------

  function findGhosts() {
    const ev = eventsRef.current
    const ids = new Set()
    let first = null
    for (let i = 0; i < ev.notes.length; i++) {
      const n = ev.notes[i]
      const durMs = (n.offset - n.onset) * 1000
      if (durMs <= ghostDur && n.velocity <= ghostVel) {
        ids.add(n._id)
        if (first === null || n.onset > first.onset) first = n
      }
    }
    setSel({ notes: ids, pedals: new Set() })
    if (ids.size === 0) {
      setGhostMsg('No notes match — try higher thresholds.')
    } else {
      setGhostMsg(ids.size + ' ghost candidate' + (ids.size === 1 ? '' : 's') +
        ' selected — review, then press Delete.')
      const wrap = wrapRef.current
      if (wrap && first) {
        wrap.scrollTop = Math.max(0, yOf(first.onset) - wrap.clientHeight / 2)
      }
    }
  }

  // ---------- sustain cap ----------

  // Shorten every note the transcriber marked longer than its pitch could
  // physically ring. Undoable (undo = before, redo = after) and it flags the
  // events dirty, so Save edits bakes it into every export. Notes already
  // within the limit are untouched; pedal segments are never changed.
  function capLongNotes() {
    const ev = eventsRef.current
    let changed = 0
    const notes = []
    for (let i = 0; i < ev.notes.length; i++) {
      const n = ev.notes[i]
      const cap = n.onset + maxSustainSec(n.pitch)
      if (n.offset > cap + 1e-4) {
        notes.push({
          _id: n._id, onset: n.onset,
          offset: Math.max(n.onset + MIN_DUR, cap),
          pitch: n.pitch, velocity: n.velocity
        })
        changed++
      } else {
        notes.push(n)
      }
    }
    if (changed === 0) {
      setCapMsg('No notes exceed the piano sustain limit — nothing to cap.')
      return
    }
    pushUndo()
    commit(notes, null)
    setCapMsg('Capped ' + changed + ' over-long note' +
      (changed === 1 ? '' : 's') +
      ' — Play both to compare, Ctrl+Z to undo, Save edits to keep.')
  }

  // ---------- hit testing ----------

  function noteAt(x, y) {
    const notes = eventsRef.current.notes
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i]
      const kw = keyW(n.pitch)
      const nx = GUTTER + KEY_CX[n.pitch] - kw / 2
      const yTop = yOf(n.offset)
      const yBot = yOf(n.onset)
      if (x >= nx - 1 && x <= nx + kw + 1 && y >= yTop - 1 && y <= yBot + 1) return n
    }
    return null
  }

  function pedalAt(x, y) {
    if (x < PEDAL_X - 2) return null
    const pedals = eventsRef.current.pedals
    for (let i = pedals.length - 1; i >= 0; i--) {
      const p = pedals[i]
      if (y >= yOf(p.offset) - 2 && y <= yOf(p.onset) + 2) return p
    }
    return null
  }

  // ---------- mouse ----------

  function canvasPos(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      x: Math.min(STAGE_W, Math.max(0, e.clientX - rect.left)),
      y: Math.min(contentH - 1, Math.max(0, e.clientY - rect.top))
    }
  }

  function beginWindowDrag() {
    function onMove(e) { handleDragMove(canvasPos(e)) }
    function onUp(e) {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      handleDragEnd(canvasPos(e))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return
    const pos = canvasPos(e)
    const x = pos.x
    const y = pos.y
    const rx = x - GUTTER
    const t = tOf(y)
    const inRoll = rx >= 0 && rx <= ROLL_W

    if (tool === 'note' && inRoll) {
      pushUndo()
      const pitch = pitchAtX(rx)
      const onset = Math.max(0, t)
      const note = {
        _id: newId(), onset: onset, offset: onset + 0.15,
        pitch: pitch, velocity: NEW_NOTE_VEL
      }
      audition(pitch, NEW_NOTE_VEL)
      dragRef.current = {
        mode: 'create', note: note, baseNotes: eventsRef.current.notes
      }
      commit(eventsRef.current.notes.concat([note]), null)
      setSel({ notes: new Set([note._id]), pedals: new Set() })
      beginWindowDrag()
      return
    }

    if (tool === 'pedal') {
      pushUndo()
      const anchor = Math.max(0, t)
      const ped = { _id: newId(), onset: anchor, offset: anchor + MIN_DUR }
      dragRef.current = {
        mode: 'pedal-create', ped: ped, anchor: anchor,
        basePedals: eventsRef.current.pedals
      }
      commit(null, eventsRef.current.pedals.concat([ped]))
      setSel({ notes: new Set(), pedals: new Set([ped._id]) })
      beginWindowDrag()
      return
    }

    // select tool — notes
    if (inRoll) {
      const n = noteAt(x, y)
      if (n) {
        let ids
        if (e.shiftKey) {
          ids = new Set(sel.notes)
          if (ids.has(n._id)) ids.delete(n._id)
          else ids.add(n._id)
        } else if (sel.notes.has(n._id)) {
          ids = sel.notes
        } else {
          ids = new Set([n._id])
        }
        setSel({ notes: ids, pedals: new Set() })
        audition(n.pitch, n.velocity)
        if (!e.shiftKey && ids.has(n._id)) {
          // top edge (later time) resizes the note's length
          const yTop = yOf(n.offset)
          const yBot = yOf(n.onset)
          const mode = (y < yTop + EDGE_PX && (yBot - yTop) > EDGE_PX * 2)
            ? 'resize' : 'move'
          const orig = {}
          const notes = eventsRef.current.notes
          for (let i = 0; i < notes.length; i++) {
            const m = notes[i]
            if (ids.has(m._id)) {
              orig[m._id] = { onset: m.onset, offset: m.offset, pitch: m.pitch }
            }
          }
          dragRef.current = {
            mode: mode, startT: t, startPitch: pitchAtX(rx), ids: ids,
            orig: orig, undoPushed: false
          }
          beginWindowDrag()
        }
      } else {
        dragRef.current = {
          mode: 'marquee', startX: x, startY: y, additive: e.shiftKey
        }
        setMarquee({ x0: x, y0: y, x1: x, y1: y })
        beginWindowDrag()
      }
      return
    }

    // pedal lane with select tool
    const p = pedalAt(x, y)
    if (p) {
      setSel({ notes: new Set(), pedals: new Set([p._id]) })
      const yTop = yOf(p.offset)
      const yBot = yOf(p.onset)
      let mode = 'pedal-move'
      if (y < yTop + EDGE_PX) mode = 'pedal-resize-hi'      // later edge (top)
      else if (y > yBot - EDGE_PX) mode = 'pedal-resize-lo' // earlier edge (bottom)
      dragRef.current = {
        mode: mode, startT: t, id: p._id,
        orig: { onset: p.onset, offset: p.offset }, undoPushed: false
      }
      beginWindowDrag()
    } else {
      clearSelection()
    }
  }

  function handleDragMove(pos) {
    const d = dragRef.current
    if (!d) return
    const x = pos.x
    const y = pos.y
    const t = tOf(y)
    const rx = x - GUTTER

    if (d.mode === 'marquee') {
      setMarquee({ x0: d.startX, y0: d.startY, x1: x, y1: y })
      return
    }

    if (d.mode === 'create') {
      const n = d.note
      const offset = Math.max(n.onset + MIN_DUR, t)
      commit(d.baseNotes.concat([{
        _id: n._id, onset: n.onset, offset: offset,
        pitch: n.pitch, velocity: n.velocity
      }]), null)
      return
    }

    if (d.mode === 'pedal-create') {
      const onset = Math.max(0, Math.min(d.anchor, t))
      const offset = Math.max(d.anchor + MIN_DUR, t)
      commit(null, d.basePedals.concat([{
        _id: d.ped._id, onset: onset, offset: offset
      }]))
      return
    }

    if (d.mode === 'move' || d.mode === 'resize') {
      if (!d.undoPushed) { pushUndo(); d.undoPushed = true }
      const dt = t - d.startT
      const dp = pitchAtX(rx) - d.startPitch
      const notes = []
      const src = eventsRef.current.notes
      for (let i = 0; i < src.length; i++) {
        const n = src[i]
        const o = d.orig[n._id]
        if (!o) { notes.push(n); continue }
        if (d.mode === 'move') {
          const shift = Math.max(dt, -o.onset)
          notes.push({
            _id: n._id, onset: o.onset + shift, offset: o.offset + shift,
            pitch: clampPitch(o.pitch + dp), velocity: n.velocity
          })
        } else {
          notes.push({
            _id: n._id, onset: o.onset,
            offset: Math.max(o.onset + MIN_DUR, o.offset + dt),
            pitch: o.pitch, velocity: n.velocity
          })
        }
      }
      commit(notes, null)
      return
    }

    if (d.mode === 'pedal-move' || d.mode === 'pedal-resize-lo' ||
        d.mode === 'pedal-resize-hi') {
      if (!d.undoPushed) { pushUndo(); d.undoPushed = true }
      const dt = t - d.startT
      const pedals = []
      const src = eventsRef.current.pedals
      for (let i = 0; i < src.length; i++) {
        const p = src[i]
        if (p._id !== d.id) { pedals.push(p); continue }
        const o = d.orig
        if (d.mode === 'pedal-move') {
          const shift = Math.max(dt, -o.onset)
          pedals.push({ _id: p._id, onset: o.onset + shift, offset: o.offset + shift })
        } else if (d.mode === 'pedal-resize-lo') {
          pedals.push({
            _id: p._id,
            onset: Math.max(0, Math.min(o.offset - MIN_DUR, o.onset + dt)),
            offset: o.offset
          })
        } else {
          pedals.push({
            _id: p._id, onset: o.onset,
            offset: Math.max(o.onset + MIN_DUR, o.offset + dt)
          })
        }
      }
      commit(null, pedals)
    }
  }

  function handleDragEnd(pos) {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return

    if (d.mode === 'marquee') {
      const x0 = Math.min(d.startX, pos.x)
      const x1 = Math.max(d.startX, pos.x)
      const y0 = Math.min(d.startY, pos.y)
      const y1 = Math.max(d.startY, pos.y)
      setMarquee(null)
      if (x1 - x0 < 3 && y1 - y0 < 3) {
        if (!d.additive) clearSelection()
        // Plain click on empty roll space seeks the playhead there.
        if (onSeek) onSeek(Math.max(0, Math.min(duration, tOf(pos.y))))
        return
      }
      const ids = d.additive ? new Set(sel.notes) : new Set()
      const notes = eventsRef.current.notes
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i]
        const kw = keyW(n.pitch)
        const nx = GUTTER + KEY_CX[n.pitch] - kw / 2
        const nyTop = yOf(n.offset)
        const nyBot = yOf(n.onset)
        if (nx <= x1 && nx + kw >= x0 && nyTop <= y1 && nyBot >= y0) {
          ids.add(n._id)
        }
      }
      setSel({ notes: ids, pedals: new Set() })
      setGhostMsg('')
      return
    }

    if (d.mode === 'pedal-create' || d.mode === 'pedal-move' ||
        d.mode === 'pedal-resize-lo' || d.mode === 'pedal-resize-hi') {
      commit(null, mergePedals(eventsRef.current.pedals))
    }
  }

  function handleContextMenu(e) {
    e.preventDefault()
    const pos = canvasPos(e)
    if (pos.x - GUTTER >= 0 && pos.x - GUTTER <= ROLL_W) {
      const n = noteAt(pos.x, pos.y)
      if (n) {
        pushUndo()
        const notes = []
        const src = eventsRef.current.notes
        for (let i = 0; i < src.length; i++) {
          if (src[i]._id !== n._id) notes.push(src[i])
        }
        commit(notes, null)
      }
    } else {
      const p = pedalAt(pos.x, pos.y)
      if (p) {
        pushUndo()
        const pedals = []
        const src = eventsRef.current.pedals
        for (let i = 0; i < src.length; i++) {
          if (src[i]._id !== p._id) pedals.push(src[i])
        }
        commit(null, pedals)
      }
    }
  }

  function handleHover(e) {
    if (dragRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const pos = canvasPos(e)
    const inRoll = pos.x - GUTTER >= 0 && pos.x - GUTTER <= ROLL_W
    if (tool === 'note') {
      canvas.style.cursor = inRoll ? 'crosshair' : 'default'
      return
    }
    if (tool === 'pedal') {
      canvas.style.cursor = 'crosshair'
      return
    }
    if (inRoll) {
      const n = noteAt(pos.x, pos.y)
      if (n) {
        const yTop = yOf(n.offset)
        const yBot = yOf(n.onset)
        canvas.style.cursor =
          (pos.y < yTop + EDGE_PX && (yBot - yTop) > EDGE_PX * 2) ? 'ns-resize' : 'move'
      } else {
        canvas.style.cursor = 'default'
      }
    } else {
      const p = pedalAt(pos.x, pos.y)
      if (p) {
        const yTop = yOf(p.offset)
        const yBot = yOf(p.onset)
        canvas.style.cursor =
          (pos.y < yTop + EDGE_PX || pos.y > yBot - EDGE_PX) ? 'ns-resize' : 'move'
      } else {
        canvas.style.cursor = 'default'
      }
    }
  }

  // ---------- keyboard shortcuts ----------

  useEffect(function () {
    function onKey(e) {
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelected()
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey &&
                 e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      } else if ((e.ctrlKey || e.metaKey) &&
                 (e.key.toLowerCase() === 'y' ||
                  (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault()
        redo()
      } else if (e.key === 'Escape') {
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return function () { window.removeEventListener('keydown', onKey) }
  })

  // ---------- zoom ----------

  function zoom(factor) {
    const next = Math.min(PX_MAX, Math.max(PX_MIN, Math.round(pxPerSec * factor)))
    if (next === pxPerSec) return
    const wrap = wrapRef.current
    if (wrap) {
      // keep the time at the viewport center pinned while zooming
      const centerT = duration - (wrap.scrollTop + wrap.clientHeight / 2 - PAD) / pxPerSec
      requestAnimationFrame(function () {
        wrap.scrollTop = Math.max(
          0, (duration - centerT) * next + PAD - wrap.clientHeight / 2)
      })
    }
    setPxPerSec(next)
  }

  // ---------- trim handles ----------

  function trimTimeAt(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    return Math.max(0, Math.min(duration, tOf(y)))
  }

  function beginTrimDrag(which) {
    return function (e) {
      e.preventDefault()
      e.stopPropagation()
      const dur = eventsDuration(eventsRef.current)
      function onMove(ev) {
        const t = trimTimeAt(ev)
        if (which === 'lo') {
          setTrimLo(Math.max(0, Math.min(t, trimHiRef.current - 0.1)))
        } else {
          setTrimHi(Math.min(dur, Math.max(t, trimLoRef.current + 0.1)))
        }
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
  }

  // ---------- scrub (drag the playhead to seek) ----------

  function beginScrub(e) {
    e.preventDefault()
    e.stopPropagation()
    if (!onSeek) return
    const rect = canvasRef.current.getBoundingClientRect()
    function seekAt(ev) {
      const t = Math.max(0, Math.min(duration, tOf(ev.clientY - rect.top)))
      onSeek(t)
    }
    seekAt(e)
    function onMove(ev) { seekAt(ev) }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ---------- render roll ----------

  useEffect(function () {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, STAGE_W, contentH)

    // pitch-column lanes: white lanes lighter, black lanes darker
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
      if (!KEY_IS_BLACK[p]) continue
      const cx = GUTTER + KEY_CX[p]
      ctx.fillStyle = '#0a0c11'
      ctx.fillRect(cx - BKEY_W / 2, 0, BKEY_W, contentH)
    }
    // white-key column separators + octave C tint
    ctx.strokeStyle = '#171b24'
    ctx.lineWidth = 1
    for (let w = 0; w <= N_WHITE; w++) {
      const x = GUTTER + w * WKEY_W + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, contentH)
      ctx.stroke()
    }
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
      if (p % 12 === 0) {
        const x = GUTTER + KEY_CX[p]
        ctx.strokeStyle = '#242c3a'
        ctx.beginPath()
        ctx.moveTo(x - WKEY_W / 2 + 0.5, 0)
        ctx.lineTo(x - WKEY_W / 2 + 0.5, contentH)
        ctx.stroke()
      }
    }

    // time grid (horizontal) + labels in the gutter
    ctx.strokeStyle = '#1a1e26'
    ctx.lineWidth = 1
    for (let s = 0; s <= duration + 1; s++) {
      const y = yOf(s) + 0.5
      ctx.beginPath()
      ctx.moveTo(GUTTER, y)
      ctx.lineTo(GUTTER + ROLL_W, y)
      ctx.stroke()
      if (s % 10 === 0) {
        ctx.fillStyle = '#4a5160'
        ctx.font = '10px sans-serif'
        ctx.fillText(formatTime(s), 2, y - 2)
      }
    }

    // pedal lane background
    ctx.fillStyle = '#0d1017'
    ctx.fillRect(PEDAL_X, 0, PEDAL_W, contentH)
    ctx.save()
    ctx.translate(PEDAL_X + 11, 8)
    ctx.rotate(Math.PI / 2)
    ctx.fillStyle = '#3d4454'
    ctx.font = '9px sans-serif'
    ctx.fillText('sustain pedal', 0, 0)
    ctx.restore()
    for (let i = 0; i < events.pedals.length; i++) {
      const p = events.pedals[i]
      const selP = sel.pedals.has(p._id)
      const yTop = yOf(p.offset)
      const h = Math.max(2, (p.offset - p.onset) * pxPerSec)
      ctx.fillStyle = selP ? '#7aa2f7' : '#2c3a5e'
      ctx.fillRect(PEDAL_X + 2, yTop, PEDAL_W - 4, h)
      if (selP) {
        ctx.strokeStyle = '#ffffff'
        ctx.strokeRect(PEDAL_X + 2.5, yTop + 0.5, PEDAL_W - 5, h - 1)
      }
    }

    // notes colored by velocity (quiet = blue, loud = amber)
    for (let i = 0; i < events.notes.length; i++) {
      const n = events.notes[i]
      const kw = keyW(n.pitch)
      const x = GUTTER + KEY_CX[n.pitch] - kw / 2
      const yTop = yOf(n.offset)
      const h = Math.max(3, (n.offset - n.onset) * pxPerSec)
      const v = n.velocity / 127
      const r = Math.round(80 + v * 152)
      const g = Math.round(110 + v * 70)
      const b = Math.round(230 - v * 156)
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')'
      ctx.fillRect(x + 1, yTop, kw - 2, h)
      if (sel.notes.has(n._id)) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, yTop - 0.5, kw - 1, h + 1)
      }
    }

    // marquee
    if (marquee) {
      const mx = Math.min(marquee.x0, marquee.x1)
      const my = Math.min(marquee.y0, marquee.y1)
      const mw = Math.abs(marquee.x1 - marquee.x0)
      const mh = Math.abs(marquee.y1 - marquee.y0)
      ctx.fillStyle = 'rgba(232,180,74,0.08)'
      ctx.fillRect(mx, my, mw, mh)
      ctx.strokeStyle = '#e8b44a'
      ctx.setLineDash([4, 3])
      ctx.strokeRect(mx + 0.5, my + 0.5, mw, mh)
      ctx.setLineDash([])
    }
  }, [events, contentH, duration, pxPerSec, sel, marquee])

  // ---------- render bottom keyboard ----------

  useEffect(function () {
    const c = keyboardRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, STAGE_W, KB_H)
    const active = new Set()
    if (playheadSec > 0) {
      const ns = events.notes
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i]
        if (n.onset <= playheadSec && n.offset > playheadSec) active.add(n.pitch)
      }
    }
    // white keys first
    for (let w = 0; w < N_WHITE; w++) {
      const p = WHITE_PITCHES[w]
      const x = GUTTER + w * WKEY_W
      ctx.fillStyle = active.has(p) ? '#e8b44a' : '#d7dae1'
      ctx.fillRect(x, 0, WKEY_W - 1, KB_H)
      if (p % 12 === 0) {
        ctx.fillStyle = '#3a3f4a'
        ctx.font = '8px sans-serif'
        ctx.fillText('C' + (Math.floor(p / 12) - 1), x + 1, KB_H - 3)
      }
    }
    // black keys on top
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
      if (!KEY_IS_BLACK[p]) continue
      const cx = GUTTER + KEY_CX[p]
      ctx.fillStyle = active.has(p) ? '#e8b44a' : '#14171d'
      ctx.fillRect(cx - BKEY_W / 2, 0, BKEY_W, KB_BLACK_H)
    }
  }, [playheadSec, events])

  // ---------- auto-scroll ----------

  // Follow the playhead: keep it low in the viewport (near the keyboard) so
  // upcoming notes are visible above it.
  useEffect(function () {
    const wrap = wrapRef.current
    if (!wrap) return
    if (playheadSec > 0) {
      const y = yOf(playheadSec)
      const view = wrap.clientHeight
      if (y > wrap.scrollTop + view - 60 || y < wrap.scrollTop) {
        wrap.scrollTop = Math.max(0, y - view * 0.72)
      }
    }
  }, [playheadSec, pxPerSec])

  // Jump to the trimmed window when an applied trim changes (and on load).
  useEffect(function () {
    const wrap = wrapRef.current
    if (!wrap) return
    wrap.scrollTop = Math.max(0, yOf(trimStart || 0) - wrap.clientHeight + 60)
  }, [trimStart])

  const selCount = sel.notes.size + sel.pedals.size
  let selVel = NEW_NOTE_VEL
  if (sel.notes.size > 0) {
    for (let i = 0; i < events.notes.length; i++) {
      if (sel.notes.has(events.notes[i]._id)) {
        selVel = events.notes[i].velocity
        break
      }
    }
  }
  const canUndo = undoRef.current.undo.length > 0
  const canRedo = undoRef.current.redo.length > 0

  return (
    <div className="editor">
      <div className="editor-bar">
        <div className="tool-group">
          <button className={tool === 'select' ? 'tool active' : 'tool'}
            title="Select, move and resize notes"
            onClick={function () { setTool('select') }}>⬚ Select</button>
          <button className={tool === 'note' ? 'tool active' : 'tool'}
            title="Click-drag on the roll to add a note"
            onClick={function () { setTool('note') }}>✏ Add notes</button>
          <button className={tool === 'pedal' ? 'tool active' : 'tool'}
            title="Click-drag to add a sustain-pedal segment (right lane)"
            onClick={function () { setTool('pedal') }}>▁ Add pedal</button>
        </div>
        <div className="tool-group">
          <button className="tool" title="Zoom out"
            onClick={function () { zoom(1 / 1.4) }}>−</button>
          <button className="tool" title="Zoom in"
            onClick={function () { zoom(1.4) }}>+</button>
        </div>
        <div className="tool-group">
          <button className="tool" disabled={!canUndo} title="Ctrl+Z"
            onClick={undo}>↶ Undo</button>
          <button className="tool" disabled={!canRedo} title="Ctrl+Y"
            onClick={redo}>↷ Redo</button>
        </div>
        <div className="tool-group">
          <button className={trimMode ? 'tool active' : 'tool'}
            title="Trim the start/end — cuts the MP3 and MIDI together"
            onClick={function () { setTrimMode(function (m) { return !m }) }}>
            ✂ Trim song
          </button>
          <button className="tool"
            title="Shorten notes held longer than a real piano string can ring (bass ~30s → treble ~1s). Undoable — Play both to hear before/after."
            onClick={capLongNotes}>
            ⭰ Cap long notes
          </button>
        </div>
        {selCount > 0 && (
          <div className="tool-group">
            <span className="sel-count">{selCount} selected</span>
            <button className="tool danger" title="Delete key works too"
              onClick={deleteSelected}>🗑 Delete</button>
          </div>
        )}
        <div className="tool-group grow" />
        {dirty && <span className="dirty-chip">● unsaved edits</span>}
        <button className="primary" disabled={!dirty || saving}
          onClick={onSave}>
          {saving ? 'Saving…' : '💾 Save edits'}
        </button>
        <button className="tool danger" onClick={onReset}
          title="Restore the untouched transcription">
          Reset to original
        </button>
      </div>

      <div className="editor-bar ghost-row">
        <span className="ghost-label">👻 Ghost-note finder:</span>
        <label>shorter than
          <input type="number" min="10" max="1000" value={ghostDur}
            onChange={function (e) { setGhostDur(Number(e.target.value)) }} /> ms
        </label>
        <label>and velocity below
          <input type="number" min="1" max="127" value={ghostVel}
            onChange={function (e) { setGhostVel(Number(e.target.value)) }} />
        </label>
        <button className="tool" onClick={findGhosts}>Find &amp; select</button>
        {ghostMsg && <span className="ghost-msg">{ghostMsg}</span>}
        {capMsg && <span className="ghost-msg">{capMsg}</span>}
      </div>

      {trimMode && (
        <div className="editor-bar trim-row">
          <span className="ghost-label">✂ Trim:</span>
          <span className="trim-readout">
            {formatTime(Math.round(trimLo))} → {formatTime(Math.round(hiVal))}
            <span className="trim-kept">
              {' '}({formatTime(Math.round(hiVal - trimLo))} kept)
            </span>
          </span>
          <button className="tool" title="Set start handle to the playhead"
            disabled={!(playheadSec > 0)}
            onClick={function () {
              setTrimLo(Math.max(0, Math.min(playheadSec, hiVal - 0.1)))
            }}>Start = playhead</button>
          <button className="tool" title="Set end handle to the playhead"
            disabled={!(playheadSec > 0)}
            onClick={function () {
              setTrimHi(Math.min(duration, Math.max(playheadSec, trimLo + 0.1)))
            }}>End = playhead</button>
          <button className="tool" title="Reset handles to the whole song"
            onClick={function () { setTrimLo(0); setTrimHi(duration) }}>
            Full song
          </button>
          <button className="primary" disabled={trimming}
            onClick={function () { onApplyTrim(trimLo, hiVal) }}>
            {trimming ? 'Applying…' : 'Apply trim'}
          </button>
          <button className="tool" onClick={function () { setTrimMode(false) }}>
            Close
          </button>
          <span className="trim-note">
            {hasAccompaniment
              ? 'Cuts MP3 + MIDI to this window, kept in sync. Re-encodes the MP3.'
              : 'MIDI only — no accompaniment on this job.'}
          </span>
        </div>
      )}

      {sel.notes.size > 0 && (
        <div className="editor-bar vel-row">
          <label>Velocity of selected — <span className="val">{selVel}</span></label>
          <input type="range" min="1" max="127" value={selVel}
            onMouseDown={pushUndo}
            onChange={function (e) { setSelectedVelocity(Number(e.target.value)) }} />
        </div>
      )}

      <div className="editor-stage-row">
      <div className="editor-vstage" style={{ width: STAGE_W }}>
        <div className="pianoroll-wrap editor-vwrap" ref={wrapRef}
          style={{ position: 'relative' }}>
          <canvas ref={canvasRef} width={STAGE_W} height={contentH}
            onMouseDown={handleMouseDown}
            onMouseMove={handleHover}
            onContextMenu={handleContextMenu} />
          {/* Playhead line (grab anywhere on it, or the gutter knob, to seek) */}
          <div title="Drag to scrub" onMouseDown={beginScrub} style={{
            position: 'absolute',
            left: GUTTER, top: yOf(playheadSec || 0) - 4,
            width: ROLL_W + PEDAL_W, height: 9,
            cursor: onSeek ? 'ns-resize' : 'default',
            pointerEvents: onSeek ? 'auto' : 'none',
            zIndex: 6
          }} />
          <div style={{
            position: 'absolute',
            left: GUTTER, top: yOf(playheadSec || 0),
            width: ROLL_W + PEDAL_W, height: 2,
            background: '#e8b44a', pointerEvents: 'none', zIndex: 6
          }} />
          <div onMouseDown={beginScrub} title="Drag to scrub" style={{
            position: 'absolute',
            left: 0, top: yOf(playheadSec || 0) - 6,
            width: GUTTER, height: 12,
            background: '#e8b44a', borderRadius: '2px',
            cursor: onSeek ? 'ns-resize' : 'default',
            pointerEvents: onSeek ? 'auto' : 'none', zIndex: 7
          }} />
          {!trimMode && ((trimStart || 0) > 0 || trimEnd != null) && (
            <>
              {(trimStart || 0) > 0 && (
                <div className="trim-shade applied" style={{
                  left: 0, top: yOf(trimStart), width: STAGE_W,
                  height: Math.max(0, contentH - yOf(trimStart))
                }} />
              )}
              {trimEnd != null && (
                <div className="trim-shade applied" style={{
                  left: 0, top: 0, width: STAGE_W, height: Math.max(0, yOf(trimEnd))
                }} />
              )}
            </>
          )}
          {trimMode && (
            <>
              <div className="trim-shade" style={{
                left: 0, top: yOf(trimLo), width: STAGE_W,
                height: Math.max(0, contentH - yOf(trimLo))
              }} />
              <div className="trim-shade" style={{
                left: 0, top: 0, width: STAGE_W, height: Math.max(0, yOf(hiVal))
              }} />
              <div className="trim-handle h start" title="Drag: song START — everything below is cut"
                style={{ left: 0, top: yOf(trimLo), width: STAGE_W }}
                onMouseDown={beginTrimDrag('lo')}>
                <span className="trim-tab">START ▾ cut below</span>
              </div>
              <div className="trim-handle h end" title="Drag: song END — everything above is cut"
                style={{ left: 0, top: yOf(hiVal), width: STAGE_W }}
                onMouseDown={beginTrimDrag('hi')}>
                <span className="trim-tab">END ▴ cut above</span>
              </div>
            </>
          )}
        </div>
        <canvas className="keyboard" ref={keyboardRef}
          width={STAGE_W} height={KB_H} />
      </div>
        {onPlay && (
          <div className="editor-side">
            <div className="editor-side-title">Playback</div>
            <button className={previewing ? 'ghost' : 'primary'} onClick={onPlay}
              title="Play from the start bar (click the roll to move it)">
              {previewing ? '■ Stop' : '▶ Play from bar'}
            </button>
            {onRestart && (
              <button className="tool" onClick={onRestart}
                title="Play from the very beginning">
                ⏮ Restart
              </button>
            )}
            {onSeek && (
              <button className="tool" onClick={function () { onSeek(0) }}
                title="Move the start bar to the beginning (no play)">
                ⤒ Bar to start
              </button>
            )}

            <div className="editor-side-title">Clean up</div>
            <button className="tool" onClick={findGhosts}
              title="Select faint/short ghost notes for review, then Delete">
              👻 Find ghosts
            </button>
            <button className="tool" onClick={capLongNotes}
              title="Shorten notes held longer than a real string can ring">
              ⭰ Cap long notes
            </button>
            <button className="tool" onClick={selectAll}
              title="Select every note">
              ▦ Select all
            </button>
            <button className="tool danger" disabled={selCount === 0}
              onClick={deleteSelected}
              title="Delete the selected notes / pedals (Del)">
              🗑 Delete{selCount > 0 ? ' (' + selCount + ')' : ''}
            </button>

            <div className="editor-side-title">History</div>
            <div className="editor-side-row">
              <button className="tool" disabled={!canUndo} onClick={undo}
                title="Undo (Ctrl+Z)">↶ Undo</button>
              <button className="tool" disabled={!canRedo} onClick={redo}
                title="Redo (Ctrl+Y)">↷ Redo</button>
            </div>

            <span className="editor-side-hint">
              Click anywhere on the roll to move the start bar, then Play.
            </span>
          </div>
        )}
      </div>
      <div className="hint">
        Time runs bottom→top; notes fall onto the keyboard. Click = select &amp;
        hear · drag = move · drag top edge = stretch · Shift-click = multi-select
        · drag empty space = box select · right-click = delete · Del = delete
        selected · Ctrl+Z / Ctrl+Y = undo / redo. Right lane = sustain pedal.
      </div>
    </div>
  )
}

function eventsDuration(events) {
  let end = 10
  const notes = events.notes
  const pedals = events.pedals
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].offset > end) end = notes[i].offset
  }
  for (let i = 0; i < pedals.length; i++) {
    if (pedals[i].offset > end) end = pedals[i].offset
  }
  return end
}

function formatTime(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m + ':' + (sec < 10 ? '0' : '') + sec
}
