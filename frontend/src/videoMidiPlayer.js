// Video-locked MIDI streamer: the <video> element is the master clock, and
// transcribed note/pedal events are scheduled onto a Web MIDI output (the
// Disklavier's USB TO HOST port) with a short lookahead window — the same
// pattern previewSynth uses for the Web Audio preview, but emitting real MIDI.
//
// Everything the user can nudge live (piano offset, pedal lag, velocity
// scale, pedal on/off, playback speed via video.playbackRate) is read at
// scheduling time, so adjustments take effect within one tick (~100 ms).

import { mapVelocity, maxSustainSec } from './previewSynth.js'

const LOOKAHEAD_SEC = 0.35   // schedule this far ahead (real seconds)
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
    const horizon = vt + LOOKAHEAD_SEC * rate

    // note-ons entering the window
    while (noteIdx < prepared.notes.length) {
      const n = prepared.notes[noteIdx]
      const tv = noteTime(n.tOn)
      if (tv > horizon) break
      if (tv >= vt - EPSILON) {
        let vel = Math.round(n.vel * velScale)
        if (vel < 1) vel = 1
        if (vel > 127) vel = 127
        midi.noteOn(n.pitch, vel, tsFor(tv, nowMs, vt, rate))
        sounding.push({ pitch: n.pitch, tOff: n.tOff })
        notesSent++
      }
      noteIdx++
    }
    // note-offs whose time has entered the window
    for (let i = sounding.length - 1; i >= 0; i--) {
      const tv = noteTime(sounding[i].tOff)
      if (tv <= horizon) {
        midi.noteOff(sounding[i].pitch,
          tsFor(Math.max(tv, vt), nowMs, vt, rate))
        sounding.splice(i, 1)
      }
    }
    // pedal
    if (pedalOn) {
      while (pedalIdx < prepared.pedals.length) {
        const p = prepared.pedals[pedalIdx]
        const tv = pedalTime(p.tOn)
        if (tv > horizon) break
        if (tv >= vt - EPSILON) {
          midi.cc(64, 127, tsFor(tv, nowMs, vt, rate))
          pedalHeld = p.tOff
        }
        pedalIdx++
      }
      if (pedalHeld != null) {
        const tv = pedalTime(pedalHeld)
        if (tv <= horizon) {
          midi.cc(64, 0, tsFor(Math.max(tv, vt), nowMs, vt, rate))
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
    if (pedalHeld != null || pedalOn) midi.cc(64, 0)
    pedalHeld = null
    midi.cc(123, 0)
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
