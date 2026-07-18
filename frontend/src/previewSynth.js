// Browser preview: plays the transcribed notes through a small Web Audio
// synth, time-locked to the accompaniment <audio> element using the same
// offset math the backend bakes into the real MIDI render. Rough piano tone —
// for judging sync, dynamics, and sustain, not fidelity.
//
// Sustain pedal: the real MIDI export and the Disklavier both get pedal as
// separate CC64 events — a real piano's damper naturally rings a note past
// key-release while the pedal is down, no note-length change needed. This
// synth has no damper mechanism, so to sound right it must fake that ring by
// extending the note's audible end to pedal-up (see computeAudibleEnds).
// Without this, pedaled/held material (hymns, tied chords) sounds chopped
// here even though the real notes and pedal events are correct.

function midiToFreq(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

// Physical audible-ring ceiling by pitch — mirrors midi_writer.max_sustain_sec
// so the preview key-hold matches the exported files. Exported: the video-sync
// MIDI player applies the same cap so live playback matches exports too.
export function maxSustainSec(pitch) {
  const p = Math.min(108, Math.max(21, pitch))
  const frac = (p - 21) / (108 - 21)
  return 30 * Math.pow(1 / 30, frac)
}

export function mapVelocity(raw, velMin, velMax, gamma) {
  let norm = raw / 127
  if (norm < 0) norm = 0
  if (norm > 1) norm = 1
  const shaped = Math.pow(norm, gamma)
  const out = velMin + shaped * (velMax - velMin)
  return Math.max(1, Math.min(127, out))
}

// For each note, the time it actually stops sounding: extended to pedal-up
// when the pedal is down at key-release, but never past the next same-pitch
// re-strike (a fresh hammer stops the old string's ring). Precomputed once
// per player (not per-note-scheduled) since it needs a full look-ahead/back
// over the note list. `notes` must be onset-sorted (both callers already
// guarantee this — backend-sorted or trim-sorted).
export function computeAudibleEnds(notes, pedals) {
  const sortedPedals = (pedals || []).slice().sort(function (a, b) {
    return a.onset - b.onset
  })

  function pedalDownAtIndex(t) {
    let lo = 0, hi = sortedPedals.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const seg = sortedPedals[mid]
      if (t < seg.onset) hi = mid - 1
      else if (t > seg.offset) lo = mid + 1
      else return mid
    }
    return -1
  }

  // Next onset at the same pitch, scanned backwards so each note only looks
  // at what it needs — O(n) total, no per-note re-scan of the whole list.
  const nextSamePitchOnset = new Array(notes.length)
  const lastOnsetByPitch = new Map()
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i]
    nextSamePitchOnset[i] = lastOnsetByPitch.has(n.pitch)
      ? lastOnsetByPitch.get(n.pitch) : Infinity
    lastOnsetByPitch.set(n.pitch, n.onset)
  }

  const ends = new Array(notes.length)
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    let end = n.offset
    const si = pedalDownAtIndex(n.offset)
    if (si >= 0) {
      end = Math.max(end, sortedPedals[si].offset)
      // Follow through short re-pedal gaps (<0.25s) to avoid synthetic dropout
      for (let sj = si + 1; sj < sortedPedals.length; sj++) {
        const next = sortedPedals[sj]
        if (next.onset - end < 0.25) {
          end = Math.max(end, next.offset)
        } else break
      }
    }
    ends[i] = Math.min(end, nextSamePitchOnset[i])
  }
  return ends
}

// Schedule one synth note at AudioContext time `when`. Shared by both the
// accompaniment-locked player and the standalone MIDI-only player, so what you
// hear (dynamics, release trim, sustain cap) matches the exported files.
// `audibleEnd` (from computeAudibleEnds) stands in for note.offset when given,
// so a pedaled note rings through the preview instead of cutting at key-release.
function synthNote(ctx, master, settings, note, when, audibleEnd) {
  const vel = mapVelocity(
    note.velocity, settings.velMin, settings.velMax, settings.gamma)
  const gainVal = Math.pow(vel / 127, 1.6) * 0.35
  // mirror the backend's note-tail trim + sustain cap so preview matches
  const release = (settings.releaseMs || 0) / 1000
  let end = (audibleEnd != null ? audibleEnd : note.offset) - release
  if (settings.capSustain) {
    const cap = note.onset + maxSustainSec(note.pitch)
    if (end > cap) end = cap
  }
  // Clamp to the bass sustain ceiling (30s) rather than a flat 4s so a
  // capped vs uncapped long note is actually audibly different in preview.
  const dur = Math.max(0.15, Math.min(30, end - note.onset))

  const gain = ctx.createGain()
  gain.connect(master)
  gain.gain.setValueAtTime(0, when)
  gain.gain.linearRampToValueAtTime(gainVal, when + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0004, when + dur)

  const freq = midiToFreq(note.pitch)
  const o1 = ctx.createOscillator()
  o1.type = 'triangle'
  o1.frequency.value = freq
  o1.connect(gain)
  const g2 = ctx.createGain()
  g2.gain.value = 0.25
  g2.connect(gain)
  const o2 = ctx.createOscillator()
  o2.type = 'sine'
  o2.frequency.value = freq * 2
  o2.connect(g2)

  o1.start(when)
  o2.start(when)
  o1.stop(when + dur + 0.05)
  o2.stop(when + dur + 0.05)
}

export function createPreviewPlayer(notes, settings, audioEl, effOffsetSec, pedals) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  const master = ctx.createGain()
  master.gain.value = 0.5
  master.connect(ctx.destination)

  let timer = null
  let nextIdx = 0
  let stopped = false
  let lastTime = 0
  const audibleEnds = computeAudibleEnds(notes, pedals)

  // notes sorted by onset already (backend sorts). Schedule with lookahead.
  const LOOKAHEAD = 0.4   // schedule this far into the future
  const INTERVAL = 120    // ms between scheduler ticks

  function scheduleNote(note, when, audibleEnd) {
    synthNote(ctx, master, settings, note, when, audibleEnd)
  }

  function tick() {
    if (stopped) return
    // Survive pauses (incl. browser-initiated media suspension): go quiet
    // and pick back up when the element plays again.
    if (audioEl.paused) return
    // Rewind/seek-back: re-derive the schedule cursor.
    if (audioEl.currentTime < lastTime - 0.5) {
      nextIdx = 0
    }
    lastTime = audioEl.currentTime
    // anchor: audio element clock -> AudioContext clock
    const anchor = ctx.currentTime - audioEl.currentTime
    const horizon = audioEl.currentTime + LOOKAHEAD
    while (nextIdx < notes.length) {
      const n = notes[nextIdx]
      const playAt = n.onset + effOffsetSec
      if (playAt > horizon) break
      if (playAt >= audioEl.currentTime - 0.05) {
        scheduleNote(n, anchor + playAt, audibleEnds[nextIdx])
      }
      nextIdx++
    }
  }

  return {
    async start() {
      audioEl.currentTime = 0
      nextIdx = 0
      stopped = false
      await ctx.resume()
      await audioEl.play()
      tick()
      timer = setInterval(tick, INTERVAL)
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      audioEl.pause()
      try { ctx.close() } catch (e) { /* already closed */ }
    },
    get done() {
      return audioEl.ended
    }
  }
}

// Standalone player for MIDI-only songs (e.g. library imports with no
// accompaniment). Clocks straight off the AudioContext — no <audio> element.
// onTime(sec) fires each tick to drive the playhead/keyboard; onEnded fires
// once the last note has passed. startSec begins playback mid-song.
export function createNotePlayer(notes, settings, onTime, onEnded, startSec, pedals) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  const master = ctx.createGain()
  master.gain.value = 0.5
  master.connect(ctx.destination)

  const LOOKAHEAD = 0.4
  const INTERVAL = 120
  const audibleEnds = computeAudibleEnds(notes, pedals)
  // Pedal-extended, so onEnded doesn't fire while the last chord still rings.
  let endSec = 0
  for (let i = 0; i < audibleEnds.length; i++) {
    if (audibleEnds[i] > endSec) endSec = audibleEnds[i]
  }

  let timer = null
  let nextIdx = 0
  let stopped = false
  let anchor = 0        // AudioContext time that maps to song-time 0
  let lastElapsed = 0
  const begin = startSec > 0 ? startSec : 0

  function stop() {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    try { ctx.close() } catch (e) { /* already closed */ }
  }

  function tick() {
    if (stopped) return
    const elapsed = ctx.currentTime - anchor
    // Seek-back (playhead dragged earlier): re-derive the schedule cursor.
    if (elapsed < lastElapsed - 0.5) nextIdx = 0
    lastElapsed = elapsed
    const horizon = elapsed + LOOKAHEAD
    while (nextIdx < notes.length) {
      const n = notes[nextIdx]
      if (n.onset > horizon) break
      if (n.onset >= elapsed - 0.05) {
        synthNote(ctx, master, settings, n, anchor + n.onset, audibleEnds[nextIdx])
      }
      nextIdx++
    }
    if (onTime) onTime(elapsed)
    if (elapsed > endSec + 0.3) {
      stop()
      if (onEnded) onEnded()
    }
  }

  return {
    async start() {
      await ctx.resume()
      stopped = false
      // anchor so that ctx.currentTime - anchor == begin at t0
      anchor = ctx.currentTime + 0.1 - begin
      lastElapsed = begin
      nextIdx = 0
      while (nextIdx < notes.length && notes[nextIdx].onset < begin) nextIdx++
      tick()
      timer = setInterval(tick, INTERVAL)
    },
    // Move the play position live (dragging the playhead): re-anchor so
    // song-time == sec now, and let tick reschedule from there.
    seek(sec) {
      const b = sec > 0 ? sec : 0
      anchor = ctx.currentTime - b
      lastElapsed = b
      nextIdx = 0
      while (nextIdx < notes.length && notes[nextIdx].onset < b) nextIdx++
    },
    stop
  }
}
