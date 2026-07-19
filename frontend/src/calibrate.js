// Hardware sync calibration for the video-sync player.
//
// Goal: measure the two physical delays that a file-only auto-sync can't know,
// so the scheduler can fire each note early by exactly the right amount:
//   1. Piano actuation latency  — MIDI note-on -> the key actually SOUNDS.
//      This is velocity-dependent (a soft note's solenoid moves slower than a
//      loud one), so we measure a CURVE, not one number. That velocity
//      dependence is why a single flat offset can never be exact.
//   2. TV/display latency       — the video path (HDMI -> TV) delays picture
//      (and lip-synced audio) by tens to >100 ms outside "game mode".
//
// Compensation applied per note = pianoLatency(velocity) - tvLatency.
//
// Two measurement methods:
//   * MIDI key-echo (preferred): many Disklavier/Enspire pianos echo their key
//     sensors back out USB TO HOST. Send note at perf.now T0, hear the echo at
//     perf.now T1 -> latency = T1 - T0. One clock domain, no mic, no acoustics.
//   * Microphone (fallback): detect the acoustic onset with the laptop mic and
//     map the audio clock to perf.now via AudioContext.getOutputTimestamp().
//     Mic input latency cancels out because we subtract the (identically
//     measured) TV latency from the piano latency.
//
// All times are milliseconds in the performance.now() domain unless noted, the
// same clock Web MIDI timestamps ride, so the numbers drop straight into the
// scheduler.

const DEFAULT_VELOCITIES = [30, 55, 80, 105, 127]
const REPS = 3
const NOTE_GAP_MS = 750        // spacing so acoustic onsets never overlap
const MAX_LATENCY_MS = 450     // ignore "onsets" later than this after a send
const MIN_LATENCY_MS = 3       // and implausibly early ones (noise)
const TEST_PITCH = 60          // middle C — a mid-range solenoid
const NOTE_HOLD_MS = 180

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

function median(xs) {
  if (!xs.length) return null
  const s = xs.slice().sort(function (a, b) { return a - b })
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---- Microphone onset detection -------------------------------------------
// A ScriptProcessorNode gives us input blocks with a ctx-time anchor
// (e.playbackTime). We track a slow noise floor and flag a sharp energy rise
// as an onset, recording its perf.now timestamp. Deprecated but present in
// Electron/Chromium and dead-simple to reason about vs. AudioWorklet messaging.
function createMicOnsetStream(audioCtx, source, onOnset) {
  const BLOCK = 1024
  const node = audioCtx.createScriptProcessor(BLOCK, 1, 1)
  let noiseFloor = 1e-4
  let lastOnsetPerf = 0
  const REFRACTORY_MS = 120

  node.onaudioprocess = function (e) {
    const buf = e.inputBuffer.getChannelData(0)
    // block energy (RMS^2) and the sample index of the loudest rise
    let sum = 0
    let peak = 0
    let peakIdx = 0
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] * buf[i]
      sum += v
      if (v > peak) { peak = v; peakIdx = i }
    }
    const energy = sum / buf.length
    // Map the block's ctx-time to perf.now. getOutputTimestamp correlates the
    // two clocks; playbackTime is this block's ctx-time.
    const ots = audioCtx.getOutputTimestamp ? audioCtx.getOutputTimestamp() : null
    let blockPerf
    if (ots && ots.contextTime != null && ots.performanceTime != null) {
      blockPerf = ots.performanceTime + (e.playbackTime - ots.contextTime) * 1000
    } else {
      blockPerf = performance.now() // last-resort; less precise
    }
    const onsetPerf = blockPerf + (peakIdx / audioCtx.sampleRate) * 1000

    // Rising-edge detection against an adaptive floor.
    if (energy > noiseFloor * 8 && energy > 1e-5) {
      if (onsetPerf - lastOnsetPerf > REFRACTORY_MS) {
        lastOnsetPerf = onsetPerf
        onOnset(onsetPerf)
      }
    }
    // Update the floor slowly, only from quiet blocks, so a held note doesn't
    // drag it up and swallow the next onset.
    if (energy < noiseFloor * 4) {
      noiseFloor = noiseFloor * 0.95 + energy * 0.05
    }
  }
  source.connect(node)
  // ScriptProcessor only fires while connected to a destination; route to a
  // muted gain so nothing is actually played back.
  const sink = audioCtx.createGain()
  sink.gain.value = 0
  node.connect(sink)
  sink.connect(audioCtx.destination)
  return function stop() {
    try { node.disconnect(); source.disconnect(); sink.disconnect() } catch (e) { /* */ }
  }
}

export function createCalibrator(midi) {
  let audioCtx = null
  let micStream = null
  let stopOnset = null
  let onsetBuffer = []        // recent {perf} acoustic onsets

  async function startMic() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // These MUST be off or they smear/shift transient onsets.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    const src = audioCtx.createMediaStreamSource(micStream)
    stopOnset = createMicOnsetStream(audioCtx, src, function (perf) {
      onsetBuffer.push(perf)
      if (onsetBuffer.length > 64) onsetBuffer.shift()
    })
  }

  function stopMic() {
    if (stopOnset) { stopOnset(); stopOnset = null }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop() }); micStream = null }
    if (audioCtx) { try { audioCtx.close() } catch (e) { /* */ } audioCtx = null }
    onsetBuffer = []
  }

  // First acoustic onset in (sendPerf, sendPerf + MAX] — polled briefly since
  // the mic block callback is async relative to the send.
  async function waitForOnset(sendPerf) {
    const deadline = sendPerf + MAX_LATENCY_MS
    while (performance.now() < deadline + 60) {
      for (let i = 0; i < onsetBuffer.length; i++) {
        const dt = onsetBuffer[i] - sendPerf
        if (dt >= MIN_LATENCY_MS && dt <= MAX_LATENCY_MS) return dt
      }
      await sleep(15)
    }
    return null
  }

  // ---- MIDI echo probe ----------------------------------------------------
  // Returns true if the piano echoes key events back on MIDI input, meaning we
  // can measure without a mic. Sends a couple of notes and watches for input.
  async function probeMidiEcho() {
    if (!midi.enableInput) return false
    const got = { any: false }
    const off = midi.onInputNoteOn(function () { got.any = true })
    midi.noteOn(TEST_PITCH, 80)
    await sleep(NOTE_HOLD_MS)
    midi.noteOff(TEST_PITCH)
    await sleep(400)
    off()
    return got.any
  }

  // Measure piano latency for one velocity using whichever method is active.
  async function measureOne(vel, useEcho) {
    const samples = []
    for (let r = 0; r < REPS; r++) {
      let latency = null
      if (useEcho) {
        const t0 = performance.now()
        const got = { t: null }
        const off = midi.onInputNoteOn(function (pitch, v, ts) {
          if (got.t == null) got.t = (ts != null ? ts : performance.now())
        })
        midi.noteOn(TEST_PITCH, vel)
        const deadline = t0 + MAX_LATENCY_MS
        while (got.t == null && performance.now() < deadline) await sleep(8)
        off()
        midi.noteOff(TEST_PITCH)
        if (got.t != null) {
          const dt = got.t - t0
          if (dt >= MIN_LATENCY_MS && dt <= MAX_LATENCY_MS) latency = dt
        }
      } else {
        onsetBuffer = []
        const t0 = performance.now()
        midi.noteOn(TEST_PITCH, vel)
        latency = await waitForOnset(t0)
        midi.noteOff(TEST_PITCH)
      }
      if (latency != null) samples.push(latency)
      await sleep(NOTE_GAP_MS)
    }
    return median(samples)
  }

  // Full piano sweep -> curve [{vel, ms}] (only points we actually measured).
  async function measurePiano(opts) {
    const o = opts || {}
    const velocities = o.velocities || DEFAULT_VELOCITIES
    const onProgress = o.onProgress || function () {}
    const useEcho = Boolean(o.useEcho)
    if (!useEcho && !audioCtx) await startMic()
    const curve = []
    for (let i = 0; i < velocities.length; i++) {
      onProgress('piano', i / velocities.length,
        'Testing velocity ' + velocities[i] + '…')
      const ms = await measureOne(velocities[i], useEcho)
      if (ms != null) curve.push({ vel: velocities[i], ms: Math.round(ms) })
    }
    onProgress('piano', 1, 'Piano measured')
    return curve
  }

  // ---- TV latency ---------------------------------------------------------
  // Play short beeps through the given <video>/<audio> element (same output
  // path as real playback) and time each acoustic beep with the mic. Needs the
  // element wired to a generated beep track; the caller supplies a play(fn)
  // that triggers one beep and returns the perf.now it was scheduled to sound.
  async function measureTv(opts) {
    const o = opts || {}
    const beep = o.beep       // async () => sendPerf   (fires one beep)
    const reps = o.reps || 4
    const onProgress = o.onProgress || function () {}
    if (!audioCtx) await startMic()
    const samples = []
    for (let r = 0; r < reps; r++) {
      onProgress('tv', r / reps, 'Timing the TV/display…')
      onsetBuffer = []
      const sendPerf = await beep()
      const dt = await waitForOnset(sendPerf)
      if (dt != null) samples.push(dt)
      await sleep(NOTE_GAP_MS)
    }
    onProgress('tv', 1, 'Display measured')
    return median(samples)
  }

  return {
    startMic,
    stopMic,
    probeMidiEcho,
    measurePiano,
    measureTv,
    get hasMic() { return Boolean(audioCtx) }
  }
}

// ---- Curve helpers (also used by the scheduler) ---------------------------

// Linear-interpolate a velocity -> latency(ms) from measured curve points.
// Flat-extends past the ends. Returns 0 for an empty curve (no compensation).
export function latencyForVelocity(curve, vel) {
  if (!curve || !curve.length) return 0
  if (vel <= curve[0].vel) return curve[0].ms
  if (vel >= curve[curve.length - 1].vel) return curve[curve.length - 1].ms
  for (let i = 1; i < curve.length; i++) {
    if (vel <= curve[i].vel) {
      const a = curve[i - 1]
      const b = curve[i]
      const t = (vel - a.vel) / (b.vel - a.vel)
      return a.ms + t * (b.ms - a.ms)
    }
  }
  return curve[curve.length - 1].ms
}

export const CAL_LS = {
  curve: 'pf_piano_lat_curve',   // JSON [{vel,ms}]
  tv: 'pf_tv_lat_ms'             // number
}

export function loadCalibration() {
  let curve = []
  let tv = 0
  try { curve = JSON.parse(localStorage.getItem(CAL_LS.curve) || '[]') } catch (e) { curve = [] }
  const t = parseFloat(localStorage.getItem(CAL_LS.tv))
  if (Number.isFinite(t)) tv = t
  return { curve: Array.isArray(curve) ? curve : [], tvLatencyMs: tv }
}

export function saveCalibration(curve, tvLatencyMs) {
  localStorage.setItem(CAL_LS.curve, JSON.stringify(curve || []))
  if (tvLatencyMs != null) localStorage.setItem(CAL_LS.tv, String(Math.round(tvLatencyMs)))
}
