// Browser preview: plays the transcribed notes through a small Web Audio
// synth, time-locked to the accompaniment <audio> element using the same
// offset math the backend bakes into the real MIDI render. Rough piano tone —
// for judging sync and dynamics, not fidelity.

function midiToFreq(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

function mapVelocity(raw, velMin, velMax, gamma) {
  let norm = raw / 127
  if (norm < 0) norm = 0
  if (norm > 1) norm = 1
  const shaped = Math.pow(norm, gamma)
  const out = velMin + shaped * (velMax - velMin)
  return Math.max(1, Math.min(127, out))
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
    const vel = mapVelocity(
      note.velocity, settings.velMin, settings.velMax, settings.gamma)
    const gainVal = Math.pow(vel / 127, 1.6) * 0.35
    const dur = Math.max(0.15, Math.min(4, note.offset - note.onset))

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
