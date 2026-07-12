// Browser preview: plays the transcribed notes through a small Web Audio
// synth, time-locked to the accompaniment <audio> element using the same
// offset math the backend bakes into the real MIDI render. Rough piano tone —
// for judging sync and dynamics, not fidelity.

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

// Schedule one synth note at AudioContext time `when`. Shared by both the
// accompaniment-locked player and the standalone MIDI-only player, so what you
// hear (dynamics, release trim, sustain cap) matches the exported files.
function synthNote(ctx, master, settings, note, when) {
  const vel = mapVelocity(
    note.velocity, settings.velMin, settings.velMax, settings.gamma)
  const gainVal = Math.pow(vel / 127, 1.6) * 0.35
  // mirror the backend's note-tail trim + sustain cap so preview matches
  const release = (settings.releaseMs || 0) / 1000
  let end = note.offset - release
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

export function createPreviewPlayer(notes, settings, audioEl, effOffsetSec) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  const master = ctx.createGain()
  master.gain.value = 0.5
  master.connect(ctx.destination)

  let timer = null
  let nextIdx = 0
  let stopped = false
  let lastTime = 0

  // notes sorted by onset already (backend sorts). Schedule with lookahead.
  const LOOKAHEAD = 0.4   // schedule this far into the future
  const INTERVAL = 120    // ms between scheduler ticks

  function scheduleNote(note, when) {
    synthNote(ctx, master, settings, note, when)
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
        scheduleNote(n, anchor + playAt)
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
export function createNotePlayer(notes, settings, onTime, onEnded, startSec) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  const master = ctx.createGain()
  master.gain.value = 0.5
  master.connect(ctx.destination)

  const LOOKAHEAD = 0.4
  const INTERVAL = 120
  let endSec = 0
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].offset > endSec) endSec = notes[i].offset
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
      if (n.onset >= elapsed - 0.05) synthNote(ctx, master, settings, n, anchor + n.onset)
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
