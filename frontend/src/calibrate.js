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
// A real solenoid strike is physically >= ~50 ms even fortissimo; a software or
// hardware MIDI-thru that echoes the command we just sent comes back in ~0-20
// ms. Any input note-on arriving sooner than this is that command loopback, not
// the key sensor, and must be rejected or it corrupts the whole latency curve.
const LOOPBACK_REJECT_MS = 25
// Disklavier MIDI IN Delay mode sounds every note a fixed constant after
// reception. Verify against this window; it's wider than the curve range.
const DELAY_MIN_MS = 400
const DELAY_MAX_MS = 650
const DELAY_MEASURE_MAX_MS = 800   // accept echoes out to here when verifying
const DELAY_FLAT_TOL_MS = 25       // soft vs loud must agree within this

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

function median(xs) {
  if (!xs.length) return null
  const s = xs.slice().sort(function (a, b) { return a - b })
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Loose port-name match — the piano's paired in/out ports share a name (maybe
// with a suffix like " MIDI 1"), so treat one as a prefix of the other.
function nameMatch(a, b) {
  a = (a || '').toLowerCase(); b = (b || '').toLowerCase()
  if (!a || !b) return false
  return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0
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

  // First acoustic onset in (sendPerf, sendPerf + max] — polled briefly since
  // the mic block callback is async relative to the send.
  async function waitForOnset(sendPerf, maxLatency) {
    const max = maxLatency || MAX_LATENCY_MS
    const deadline = sendPerf + max
    while (performance.now() < deadline + 60) {
      for (let i = 0; i < onsetBuffer.length; i++) {
        const dt = onsetBuffer[i] - sendPerf
        if (dt >= MIN_LATENCY_MS && dt <= max) return dt
      }
      await sleep(15)
    }
    return null
  }

  // ---- MIDI echo probe ----------------------------------------------------
  // Does the piano echo its key sensors back on MIDI input? Send one test note
  // and collect every input note-on for a moment, then classify:
  //   dt < LOOPBACK_REJECT_MS   -> a MIDI-thru command loopback of our own note,
  //                                NOT the key sensor (ignored, but reported)
  //   dt in [reject, delayMax]  -> a genuine key-sensor echo we can time against
  // Prefer arrivals on the input port paired with the selected output. Returns
  // {hasEcho, port, medianDt, sawLoopback} so the wizard can show what it found
  // and which port it will listen to.
  async function probeEcho(opts) {
    const o = opts || {}
    if (!midi.onInputNoteOn) {
      return { hasEcho: false, port: null, medianDt: null, sawLoopback: false }
    }
    const outputName = o.outputName || ''
    const arrivals = []
    const t0 = performance.now()
    const off = midi.onInputNoteOn(function (pitch, v, ts, port) {
      arrivals.push({
        dt: (ts != null ? ts : performance.now()) - t0,
        pitch: pitch, port: port || null
      })
    })
    midi.noteOn(TEST_PITCH, 80)
    await sleep(NOTE_HOLD_MS)
    midi.noteOff(TEST_PITCH)
    await sleep(600)
    off()

    let sawLoopback = false
    const sensor = []
    for (let i = 0; i < arrivals.length; i++) {
      const a = arrivals[i]
      if (a.pitch !== TEST_PITCH) continue
      if (a.dt < LOOPBACK_REJECT_MS) { sawLoopback = true; continue }
      if (a.dt > DELAY_MEASURE_MAX_MS) continue
      sensor.push(a)
    }
    if (!sensor.length) {
      return { hasEcho: false, port: null, medianDt: null, sawLoopback: sawLoopback }
    }
    let pool = sensor
    if (outputName) {
      const matched = sensor.filter(function (a) {
        return a.port && nameMatch(a.port.name, outputName)
      })
      if (matched.length) pool = matched
    }
    const port = pool[0].port
    const dts = pool
      .filter(function (a) { return !port || !a.port || a.port.id === port.id })
      .map(function (a) { return a.dt })
    return {
      hasEcho: true,
      port: port ? { id: port.id, name: port.name } : null,
      medianDt: median(dts),
      sawLoopback: sawLoopback
    }
  }

  // One echo-measured strike: send TEST_PITCH at vel, collect every input note-
  // on in the window, and return the earliest arrival that is our test pitch,
  // on the chosen echo port, and later than LOOPBACK_REJECT_MS (i.e. a real
  // sensor echo, not a command loopback). null if nothing qualifies.
  async function echoStrike(vel, echoPortId, maxLatency) {
    const arrivals = []
    const t0 = performance.now()
    const off = midi.onInputNoteOn(function (pitch, v, ts, port) {
      arrivals.push({
        dt: (ts != null ? ts : performance.now()) - t0,
        pitch: pitch, portId: port && port.id
      })
    })
    midi.noteOn(TEST_PITCH, vel)
    const deadline = t0 + maxLatency
    while (performance.now() < deadline + 40) await sleep(8)
    off()
    midi.noteOff(TEST_PITCH)
    let best = null
    for (let i = 0; i < arrivals.length; i++) {
      const a = arrivals[i]
      if (a.pitch !== TEST_PITCH) continue
      if (echoPortId && a.portId && a.portId !== echoPortId) continue
      if (a.dt < LOOPBACK_REJECT_MS || a.dt > maxLatency) continue
      if (best == null || a.dt < best) best = a.dt
    }
    return best
  }

  // Measure piano latency for one velocity using whichever method is active.
  async function measureOne(vel, opts) {
    const o = opts || {}
    const useEcho = Boolean(o.useEcho)
    const maxLatency = o.maxLatency || MAX_LATENCY_MS
    const samples = []
    for (let r = 0; r < REPS; r++) {
      let latency = null
      if (useEcho) {
        latency = await echoStrike(vel, o.echoPortId, maxLatency)
      } else {
        onsetBuffer = []
        const t0 = performance.now()
        midi.noteOn(TEST_PITCH, vel)
        latency = await waitForOnset(t0, maxLatency)
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
      const ms = await measureOne(velocities[i], {
        useEcho: useEcho, echoPortId: o.echoPortId
      })
      if (ms != null) curve.push({ vel: velocities[i], ms: Math.round(ms) })
    }
    onProgress('piano', 1, 'Piano measured')
    return curve
  }

  // Verify the piano's MIDI IN Delay mode: measure soft (30) and loud (127) and
  // confirm both land in the ~500 ms window AND agree (velocity-flat), which is
  // the signature of the fixed reception->sound delay. If they're small and
  // spread apart, delay mode is OFF and this is just raw solenoid latency.
  async function verifyDelayMode(opts) {
    const o = opts || {}
    const useEcho = Boolean(o.useEcho)
    const onProgress = o.onProgress || function () {}
    if (!useEcho && !audioCtx) await startMic()
    onProgress('verify', 0.1, 'Testing soft notes…')
    const lo = await measureOne(30, {
      useEcho: useEcho, echoPortId: o.echoPortId, maxLatency: DELAY_MEASURE_MAX_MS
    })
    onProgress('verify', 0.55, 'Testing loud notes…')
    const hi = await measureOne(127, {
      useEcho: useEcho, echoPortId: o.echoPortId, maxLatency: DELAY_MEASURE_MAX_MS
    })
    onProgress('verify', 1, 'Done')
    if (lo == null || hi == null) {
      return { ok: false, constMs: null, lo: lo, hi: hi, spread: null }
    }
    const spread = Math.abs(lo - hi)
    const constMs = Math.round((lo + hi) / 2)
    const ok = lo >= DELAY_MIN_MS && lo <= DELAY_MAX_MS &&
      hi >= DELAY_MIN_MS && hi <= DELAY_MAX_MS && spread < DELAY_FLAT_TOL_MS
    return {
      ok: ok, constMs: constMs,
      lo: Math.round(lo), hi: Math.round(hi), spread: Math.round(spread)
    }
  }

  // The systematic offset the microphone path adds vs. the clean MIDI-echo
  // clock: strike the piano while BOTH listeners are live and take
  // median(micOnset - echoOnset). Used to correct the (mic-only) TV reading
  // when the piano itself was echo-measured, so the two don't share the offset
  // automatically. null when there's no usable echo.
  async function measureMicOffset(opts) {
    const o = opts || {}
    const maxLatency = o.maxLatency || DELAY_MEASURE_MAX_MS
    if (!audioCtx) await startMic()
    const diffs = []
    for (let r = 0; r < REPS; r++) {
      onsetBuffer = []
      const arrivals = []
      const t0 = performance.now()
      const off = midi.onInputNoteOn(function (pitch, v, ts, port) {
        arrivals.push({
          dt: (ts != null ? ts : performance.now()) - t0,
          pitch: pitch, portId: port && port.id
        })
      })
      midi.noteOn(TEST_PITCH, 100)
      const micDt = await waitForOnset(t0, maxLatency)
      off()
      midi.noteOff(TEST_PITCH)
      let echoDt = null
      for (let i = 0; i < arrivals.length; i++) {
        const a = arrivals[i]
        if (a.pitch !== TEST_PITCH) continue
        if (o.echoPortId && a.portId && a.portId !== o.echoPortId) continue
        if (a.dt < LOOPBACK_REJECT_MS || a.dt > maxLatency) continue
        if (echoDt == null || a.dt < echoDt) echoDt = a.dt
      }
      if (micDt != null && echoDt != null) diffs.push(micDt - echoDt)
      await sleep(NOTE_GAP_MS)
    }
    return median(diffs)
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
    probeEcho,
    measurePiano,
    verifyDelayMode,
    measureMicOffset,
    measureTv,
    get hasMic() { return Boolean(audioCtx) }
  }
}

// Build a one-shot beep player for TV-latency measurement. The beep is a short
// bright click (fast-decaying 2 kHz burst) rendered to an <audio> element, so
// it plays out the system's default output — set that to the TV over HDMI and
// the click travels the same picture/audio path we're trying to time. Returns
// { beep, dispose }; beep() fires once and resolves to the perf.now it started.
export function makeBeepPlayer() {
  const sr = 44100
  const durSec = 0.06
  const n = Math.floor(sr * durSec)
  const dataLen = n * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const dv = new DataView(buf)
  function wstr(off, s) { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE')
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true)
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  wstr(36, 'data'); dv.setUint32(40, dataLen, true)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const env = Math.exp(-t * 80)                 // sharp attack, fast decay
    const s = Math.sin(2 * Math.PI * 2000 * t) * env
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true)
  }
  let bin = ''
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
  const el = new Audio('data:audio/wav;base64,' + btoa(bin))
  el.preload = 'auto'
  async function beep() {
    try { el.currentTime = 0 } catch (e) { /* */ }
    const p = el.play()
    if (p && p.catch) p.catch(function () { /* autoplay/route hiccup */ })
    return performance.now()
  }
  function dispose() { try { el.pause() } catch (e) { /* */ } }
  return { beep: beep, dispose: dispose }
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

export const DEFAULT_DELAY_MS = 500   // Yamaha's fixed MIDI IN Delay constant

export const CAL_LS = {
  curve: 'pf_piano_lat_curve',   // JSON [{vel,ms}]
  tv: 'pf_tv_lat_ms',            // number
  delayMode: 'pf_delay_mode',    // '1' | '0'
  delayConst: 'pf_delay_const_ms', // number (measured flat latency)
  delayVerified: 'pf_delay_verified', // '1' once the wizard confirmed the delay
  micOffset: 'pf_mic_offset_ms', // number (mic path systematic offset)
  echoPort: 'pf_echo_port_id'    // remembered key-echo input port id
}

export function loadCalibration() {
  let curve = []
  try { curve = JSON.parse(localStorage.getItem(CAL_LS.curve) || '[]') } catch (e) { curve = [] }
  const tv = parseFloat(localStorage.getItem(CAL_LS.tv))
  const dc = parseFloat(localStorage.getItem(CAL_LS.delayConst))
  const mo = parseFloat(localStorage.getItem(CAL_LS.micOffset))
  return {
    curve: Array.isArray(curve) ? curve : [],
    tvLatencyMs: Number.isFinite(tv) ? tv : 0,
    delayMode: localStorage.getItem(CAL_LS.delayMode) === '1',
    delayConstMs: Number.isFinite(dc) ? dc : DEFAULT_DELAY_MS,
    delayVerified: localStorage.getItem(CAL_LS.delayVerified) === '1',
    micOffsetMs: Number.isFinite(mo) ? mo : 0,
    echoPortId: localStorage.getItem(CAL_LS.echoPort) || null
  }
}

export function saveCalibration(cal) {
  const c = cal || {}
  localStorage.setItem(CAL_LS.curve, JSON.stringify(c.curve || []))
  if (c.tvLatencyMs != null) localStorage.setItem(CAL_LS.tv, String(Math.round(c.tvLatencyMs)))
  localStorage.setItem(CAL_LS.delayMode, c.delayMode ? '1' : '0')
  localStorage.setItem(CAL_LS.delayVerified, c.delayVerified ? '1' : '0')
  if (c.delayConstMs != null) localStorage.setItem(CAL_LS.delayConst, String(Math.round(c.delayConstMs)))
  if (c.micOffsetMs != null) localStorage.setItem(CAL_LS.micOffset, String(Math.round(c.micOffsetMs)))
  if (c.echoPortId != null) localStorage.setItem(CAL_LS.echoPort, String(c.echoPortId))
}

// Collapse the stored calibration object into what the scheduler consumes. In
// delay mode the whole velocity curve becomes a single flat point (the piano
// itself makes latency velocity-independent), and uniformComp tells the
// scheduler to shift note-offs and pedal early by the same constant too.
export function effectiveCalibration(cal) {
  if (!cal) return { curve: [], tvLatencyMs: 0, uniformComp: false }
  if (cal.delayMode) {
    const c = Number.isFinite(cal.delayConstMs) ? cal.delayConstMs : DEFAULT_DELAY_MS
    return {
      curve: [{ vel: 64, ms: Math.round(c) }],
      tvLatencyMs: cal.tvLatencyMs || 0,
      uniformComp: true
    }
  }
  return {
    curve: cal.curve || [],
    tvLatencyMs: cal.tvLatencyMs || 0,
    uniformComp: false
  }
}
