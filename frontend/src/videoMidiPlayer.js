// Video-locked MIDI streamer: the <video> element is the master clock, and
// transcribed note/pedal events are scheduled onto a Web MIDI output (the
// Disklavier's USB TO HOST port) with a short lookahead window — the same
// pattern previewSynth uses for the Web Audio preview, but emitting real MIDI.
//
// Everything the user can nudge live (piano offset, pedal lag, velocity
// scale, pedal on/off, playback speed via video.playbackRate) is read at
// scheduling time, so adjustments take effect within one tick (~100 ms).

import { mapVelocity, maxSustainSec } from './previewSynth.js'
import { latencyForVelocity } from './calibrate.js'

const MIN_LOOKAHEAD_SEC = 0.35  // floor for how far ahead we schedule (real s)
const TICK_MS = 100          // scheduler cadence
const EPSILON = 0.03         // don't fire events already this far in the past

// Build the playable event lists once per song load.
//  - events: {notes, pedals} in transcription time
//  - settings: the job's export tuning (velocity curve, release trim, sustain
//    cap). rawVelocity=true (library songs: velocities already mapped at
//    render time) skips the curve so dynamics aren't compressed twice.
//  - srcStartSec: destructive-trim shift — maps transcription time back onto
//    the original (untrimmed) video timeline.
export function prepareEvents(events, settings, rawVelocity, srcStartSec) {
  const shift = srcStartSec || 0
  const s = settings || {}
  const release = (s.releaseMs || 0) / 1000
  const notes = []
  for (let i = 0; i < events.notes.length; i++) {
    const n = events.notes[i]
    let off = n.offset - release
    if (s.capSustain !== false) {
      const cap = n.onset + maxSustainSec(n.pitch)
      if (off > cap) off = cap
    }
    if (off < n.onset + 0.02) off = n.onset + 0.02
    const vel = rawVelocity
      ? Math.max(1, Math.min(127, n.velocity))
      : mapVelocity(n.velocity, s.velMin != null ? s.velMin : 20,
                    s.velMax != null ? s.velMax : 112,
                    s.gamma != null ? s.gamma : 1.0)
    notes.push({
      tOn: n.onset + shift,
      tOff: off + shift,
      pitch: n.pitch,
      vel: vel
    })
  }
  notes.sort(function (a, b) { return a.tOn - b.tOn })
  const pedals = []
  for (let i = 0; i < events.pedals.length; i++) {
    const p = events.pedals[i]
    pedals.push({ tOn: p.onset + shift, tOff: p.offset + shift })
  }
  pedals.sort(function (a, b) { return a.tOn - b.tOn })
  return { notes: notes, pedals: pedals }
}

export function createVideoMidiPlayer(videoEl, midi, prepared, initial) {
  // live-adjustable parameters (seconds)
  let syncSec = (initial && initial.syncMs || 0) / 1000
  let pedalSec = (initial && initial.pedalMs || 0) / 1000
  let velScale = (initial && initial.velScale != null) ? initial.velScale : 1.0
  let pedalOn = !initial || initial.pedalOn !== false
  // Hardware calibration (see calibrate.js): a velocity->latency curve for the
  // piano's solenoids and a single TV/display latency. Each note is sent early
  // by pianoLatency(vel) - tvLatency (real-time ms) so the acoustic strike
  // lands when the TV shows that note. Empty curve => zero compensation, i.e.
  // exactly the old behavior.
  let latencyCurve = (initial && initial.latencyCurve) || []
  let tvLatencyMs = (initial && initial.tvLatencyMs) || 0
  // Disklavier "MIDI IN Delay" mode: the piano delays EVERY incoming message by
  // a fixed constant (~500 ms), so note-offs and pedal CC must be shifted early
  // too (not just note-ons) to keep durations and pedal timing correct. In the
  // ordinary per-velocity-curve mode this stays false and only note-ons shift,
  // preserving the previously shipped behavior.
  let uniformComp = Boolean(initial && initial.uniformComp)

  // How far ahead the scheduler must look: at least MIN_LOOKAHEAD_SEC, but more
  // when compensation is large (delay mode pulls sends ~0.5 s earlier, which
  // must fit inside the window or every send lands in the past and gets clamped
  // late). Recomputed whenever the calibration changes.
  let lookaheadSec = MIN_LOOKAHEAD_SEC
  function recomputeLookahead() {
    let maxMs = 0
    for (let i = 0; i < latencyCurve.length; i++) {
      if (latencyCurve[i].ms > maxMs) maxMs = latencyCurve[i].ms
    }
    const maxCompSec = Math.max(0, maxMs - tvLatencyMs) / 1000
    lookaheadSec = Math.max(MIN_LOOKAHEAD_SEC, maxCompSec + 0.25)
  }
  recomputeLookahead()

  // Real-time ms to pull a note's MIDI send earlier, for the velocity actually
  // sent to the piano. Rate-independent: latencies are physical constants, not
  // scaled by playbackRate.
  function compMs(vel) {
    if (!latencyCurve.length && !tvLatencyMs) return 0
    return latencyForVelocity(latencyCurve, vel) - tvLatencyMs
  }

  let timer = null
  let noteIdx = 0
  let pedalIdx = 0
  // Note-ons already sent whose note-offs haven't been scheduled yet; offs are
  // only committed once they fall inside the lookahead window, so seeks and
  // speed changes can't strand a queued-months-ahead note-off.
  let sounding = []        // [{pitch, tOff}]
  let pedalHeld = null     // tOff of the sounding pedal, or null
  let notesSent = 0
  let onActivity = null    // cb(notesSent) for the UI counter
  let onScheduled = null   // cb({pitch,vel,sendTs,soundTs}) for live-sync monitor
  // Note-ons sent with a still-in-the-future timestamp. Chromium queues them in
  // the driver; if the user pauses/seeks before they fire, clearQueue() may be
  // a no-op (MIDIOutput.clear isn't universal), so quiet() releases them by
  // stamping a note-off just after each — a bounded blip instead of ghost notes
  // playing 0.5 s into a pause. Pruned as their time passes.
  let queuedFuture = []    // [{pitch, ts}]

  function noteTime(t) { return t + syncSec }
  function pedalTime(t) { return t + syncSec + pedalSec }

  // Map a video-timeline second to a Web MIDI timestamp using the current
  // tick's anchor. rate-aware: at 0.5x a note 1 video-second away is 2 real
  // seconds away.
  function tsFor(tv, nowMs, vt, rate) {
    return nowMs + ((tv - vt) / rate) * 1000
  }

  function tick() {
    if (videoEl.paused || videoEl.ended) return
    const nowMs = performance.now()
    const vt = videoEl.currentTime
    const rate = videoEl.playbackRate || 1
    const horizon = vt + lookaheadSec * rate

    // drop future-queue entries that have already fired
    if (queuedFuture.length) {
      queuedFuture = queuedFuture.filter(function (q) { return q.ts > nowMs })
    }

    // note-ons entering the window
    while (noteIdx < prepared.notes.length) {
      const n = prepared.notes[noteIdx]
      const tv = noteTime(n.tOn)
      if (tv > horizon) break
      if (tv >= vt - EPSILON) {
        let vel = Math.round(n.vel * velScale)
        if (vel < 1) vel = 1
        if (vel > 127) vel = 127
        // Fire earlier by the (velocity-dependent) net hardware latency so the
        // hammer sounds in sync with the picture. clamp to not stamp absurdly
        // far in the past if we're already at the note.
        const soundTs = tsFor(tv, nowMs, vt, rate)
        let ts = soundTs - compMs(vel)
        if (ts < nowMs) ts = nowMs
        midi.noteOn(n.pitch, vel, ts)
        sounding.push({ pitch: n.pitch, tOff: n.tOff })
        if (ts > nowMs) queuedFuture.push({ pitch: n.pitch, ts: ts })
        if (onScheduled) onScheduled({ pitch: n.pitch, vel: vel, sendTs: ts, soundTs: soundTs })
        notesSent++
      }
      noteIdx++
    }
    // note-offs whose time has entered the window. In uniform (delay) mode the
    // off must be pulled early by the same constant as the on, or the piano —
    // which delays every message equally — would hold each note ~0.5 s too long.
    for (let i = sounding.length - 1; i >= 0; i--) {
      const tv = noteTime(sounding[i].tOff)
      if (tv <= horizon) {
        let offTs = tsFor(Math.max(tv, vt), nowMs, vt, rate)
        if (uniformComp) {
          offTs -= compMs(64)
          if (offTs < nowMs) offTs = nowMs
        }
        midi.noteOff(sounding[i].pitch, offTs)
        sounding.splice(i, 1)
      }
    }
    // pedal — CC64 is likewise shifted early in uniform (delay) mode so the
    // sustain lands with the notes; curve mode leaves it uncompensated so any
    // hand-tuned pedalMs still means what it did before.
    if (pedalOn) {
      while (pedalIdx < prepared.pedals.length) {
        const p = prepared.pedals[pedalIdx]
        const tv = pedalTime(p.tOn)
        if (tv > horizon) break
        if (tv >= vt - EPSILON) {
          let onTs = tsFor(tv, nowMs, vt, rate)
          if (uniformComp) { onTs -= compMs(64); if (onTs < nowMs) onTs = nowMs }
          midi.cc(64, 127, onTs)
          pedalHeld = p.tOff
        }
        pedalIdx++
      }
      if (pedalHeld != null) {
        const tv = pedalTime(pedalHeld)
        if (tv <= horizon) {
          let offTs = tsFor(Math.max(tv, vt), nowMs, vt, rate)
          if (uniformComp) { offTs -= compMs(64); if (offTs < nowMs) offTs = nowMs }
          midi.cc(64, 0, offTs)
          pedalHeld = null
        }
      }
    }
    if (onActivity) onActivity(notesSent)
  }

  // Silence everything sounding and drop queued future messages. Cursors are
  // re-derived separately so play/seek decide where to resume.
  function quiet() {
    midi.clearQueue()
    for (let i = 0; i < sounding.length; i++) midi.noteOff(sounding[i].pitch)
    sounding = []
    // Notes already queued with future timestamps may still fire if the driver
    // ignored clearQueue(). Stamp a note-off just after each so it's released
    // the instant it sounds — a brief blip, not a note bleeding through a pause.
    const nowMs = performance.now()
    for (let i = 0; i < queuedFuture.length; i++) {
      const q = queuedFuture[i]
      if (q.ts > nowMs) midi.noteOff(q.pitch, q.ts + 5)
    }
    queuedFuture = []
    if (pedalHeld != null || pedalOn) midi.cc(64, 0)
    pedalHeld = null
    midi.cc(123, 0)
    // Backstop after the longest possible queued lead, in case a future-stamped
    // message slipped past the per-note releases above.
    midi.cc(123, 0, nowMs + lookaheadSec * 1000 + 20)
    midi.cc(120, 0, nowMs + lookaheadSec * 1000 + 20)
  }

  // Point the cursors at the first events at/after the current video time.
  function resetCursors() {
    const vt = videoEl.currentTime
    noteIdx = 0
    while (noteIdx < prepared.notes.length
        && noteTime(prepared.notes[noteIdx].tOn) < vt - EPSILON) noteIdx++
    pedalIdx = 0
    while (pedalIdx < prepared.pedals.length
        && pedalTime(prepared.pedals[pedalIdx].tOn) < vt - EPSILON) pedalIdx++
  }

  // Resuming mid-pedal: restore the sustain state the song is in at this
  // point, otherwise every seek loses the pedal until its next event.
  function chasePedal() {
    if (!pedalOn) return
    const vt = videoEl.currentTime
    for (let i = 0; i < prepared.pedals.length; i++) {
      const p = prepared.pedals[i]
      if (pedalTime(p.tOn) <= vt && vt < pedalTime(p.tOff)) {
        midi.cc(64, 127)
        pedalHeld = p.tOff
        // cursor must skip this interval so its on-event isn't re-sent
        if (pedalIdx <= i) pedalIdx = i + 1
        return
      }
    }
  }

  // Soft resync after a live offset/speed change: kill the (stale-stamped)
  // queue and re-derive cursors; notes already sounding keep sounding and
  // their offs get restamped on the next tick.
  function resync() {
    midi.clearQueue()
    queuedFuture = []
    resetCursors()
  }

  function onPlay() { resetCursors(); chasePedal(); tick() }
  function onPause() { quiet() }
  function onSeeking() { quiet() }
  function onSeeked() {
    resetCursors()
    if (!videoEl.paused) chasePedal()
  }
  function onRate() { resync() }
  function onEnded() { quiet() }

  function attach() {
    videoEl.addEventListener('play', onPlay)
    videoEl.addEventListener('pause', onPause)
    videoEl.addEventListener('seeking', onSeeking)
    videoEl.addEventListener('seeked', onSeeked)
    videoEl.addEventListener('ratechange', onRate)
    videoEl.addEventListener('ended', onEnded)
    timer = setInterval(tick, TICK_MS)
  }

  function detach() {
    if (timer) clearInterval(timer)
    timer = null
    videoEl.removeEventListener('play', onPlay)
    videoEl.removeEventListener('pause', onPause)
    videoEl.removeEventListener('seeking', onSeeking)
    videoEl.removeEventListener('seeked', onSeeked)
    videoEl.removeEventListener('ratechange', onRate)
    videoEl.removeEventListener('ended', onEnded)
    quiet()
  }

  return {
    attach,
    detach,
    setSyncMs(ms) { syncSec = ms / 1000; resync() },
    setPedalLagMs(ms) { pedalSec = ms / 1000; resync(); if (!videoEl.paused) chasePedal() },
    setCalibration(curve, tvMs, opts) {
      latencyCurve = curve || []
      tvLatencyMs = tvMs || 0
      uniformComp = Boolean(opts && opts.uniformComp)
      recomputeLookahead()
    },
    setOnScheduled(cb) { onScheduled = cb },
    setVelScale(x) { velScale = x },
    setPedalOn(b) {
      pedalOn = Boolean(b)
      if (!pedalOn) { midi.cc(64, 0); pedalHeld = null }
      else if (!videoEl.paused) { resetCursors(); chasePedal() }
    },
    setActivityCallback(cb) { onActivity = cb },
    panic() { quiet(); midi.panic() },
    get notesSent() { return notesSent }
  }
}
