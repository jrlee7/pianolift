// Live closed-loop sync monitor. While a song plays, the scheduler reports each
// note it sends (pitch, the timestamp it was sent, and the video-synced time it
// SHOULD be heard). If the piano echoes its key sensors back on MIDI input, we
// hear when each note actually sounded and can measure the residual error —
// "the piano is running 18 ms late" — and offer a one-click trim.
//
// This only works when the piano transmits its sensors during solenoid playback
// (many don't, and delay mode may suppress it). If no matches arrive, the caller
// keeps the panel hidden. Nothing here ever changes timing on its own.

const MATCH_WINDOW_MS = 250   // an echo this far from a scheduled note's target
const LOOPBACK_MS = 25        // arrivals this close to when we SENT = command echo
const PRUNE_MS = 5000         // forget scheduled notes older than this
const KEEP = 15               // rolling window of recent match errors

function median(xs) {
  if (!xs.length) return null
  const s = xs.slice().sort(function (a, b) { return a - b })
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function createLiveSyncMonitor(midi, opts) {
  const o = opts || {}
  const echoPortId = o.echoPortId || null
  const scheduled = []   // {pitch, sendTs, soundTs}
  const errors = []      // recent match errors (ms); +ve = piano late
  let matches = 0
  let onUpdate = null
  let off = null

  // Called by the scheduler for every note-on it emits.
  function noteScheduled(ev) {
    scheduled.push(ev)
    const cutoff = performance.now() - PRUNE_MS
    while (scheduled.length && scheduled[0].sendTs < cutoff) scheduled.shift()
  }

  function onEcho(pitch, vel, ts, port) {
    const t = ts != null ? ts : performance.now()
    if (echoPortId && port && port.id && port.id !== echoPortId) return
    // Drop the piano/thru echoing back the command we just sent (not a strike).
    for (let i = 0; i < scheduled.length; i++) {
      const s = scheduled[i]
      if (s.pitch === pitch && Math.abs(t - s.sendTs) < LOOPBACK_MS) return
    }
    // Match the nearest scheduled note of the same pitch by its intended sound
    // time; the gap is the residual sync error.
    let best = null
    let bestErr = 0
    for (let i = 0; i < scheduled.length; i++) {
      const s = scheduled[i]
      if (s.pitch !== pitch) continue
      const err = t - s.soundTs
      if (Math.abs(err) <= MATCH_WINDOW_MS &&
          (best === null || Math.abs(err) < Math.abs(bestErr))) {
        best = s
        bestErr = err
      }
    }
    if (best === null) return
    errors.push(bestErr)
    if (errors.length > KEEP) errors.shift()
    matches++
    if (onUpdate) onUpdate({ medianErr: median(errors), matches: matches, samples: errors.length })
  }

  function start() {
    if (off || !midi.onInputNoteOn) return
    off = midi.onInputNoteOn(onEcho)
  }
  function stop() { if (off) { off(); off = null } }
  function reset() { scheduled.length = 0; errors.length = 0; matches = 0 }

  return {
    noteScheduled: noteScheduled,
    start: start,
    stop: stop,
    reset: reset,
    setOnUpdate: function (cb) { onUpdate = cb }
  }
}
