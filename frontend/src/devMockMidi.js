// Development mock for createMidiOut — a full drop-in that simulates a
// Disklavier so the sync UI (calibration wizard, Visual Test, live monitor) can
// be exercised without hardware or Web MIDI. It records everything sent and can
// echo key-sensor note-ons back on a fake input port, with configurable:
//   - solenoid latency curve (velocity-dependent) OR a fixed delay-mode constant
//   - an optional immediate command-loopback (to prove the wizard rejects it)
//   - connect/disconnect (hot-plug) and jitter
//
// Enable in the browser with ?mockmidi in the URL, or set window.__PF_MOCK_MIDI
// = true (optionally window.__PF_MOCK_MIDI_OPTS = {...}) before the player
// mounts. PlayerView picks it up in place of the real createMidiOut.

export function createMockMidi(opts) {
  const o = opts || {}
  const state = {
    deviceName: o.name || 'Disklavier ENSPIRE (mock)',
    connected: o.connected !== false,
    delayMode: Boolean(o.delayMode),
    delayConstMs: o.delayConstMs != null ? o.delayConstMs : 500,
    loopbackMs: o.loopbackMs != null ? o.loopbackMs : null, // null = no command loopback
    jitterMs: o.jitterMs || 0,
    transmitsDuringPlayback: o.transmitsDuringPlayback !== false,
    latency: o.latency || function (vel) { return 120 - (vel / 127) * 60 } // 120ms soft -> 60ms loud
  }
  const sends = []          // every message: {bytes, ts, at}
  const inputCbs = []
  const inPort = { id: o.inId || 'mock-in-1', name: o.inName || state.deviceName }
  let onChange = null

  function fireInput(pitch, vel) {
    const t = performance.now()
    for (let i = 0; i < inputCbs.length; i++) inputCbs[i](pitch, vel, t, inPort)
  }

  function scheduleEcho(pitch, vel) {
    if (!state.connected || !state.transmitsDuringPlayback) return
    if (state.loopbackMs != null) {
      setTimeout(function () { fireInput(pitch, vel) }, state.loopbackMs)
    }
    const base = state.delayMode ? state.delayConstMs : state.latency(vel)
    const jit = state.jitterMs ? (Math.random() * 2 - 1) * state.jitterMs : 0
    setTimeout(function () { fireInput(pitch, vel) }, Math.max(1, base + jit))
  }

  function send(bytes) {
    sends.push({ bytes: bytes, at: performance.now() })
    if (!state.connected) return false
    const status = bytes[0] & 0xf0
    if (status === 0x90 && bytes[2] > 0) scheduleEcho(bytes[1], bytes[2])
    return true
  }

  const api = {
    init: async function () { if (onChange) onChange() },
    select: function () { if (onChange) onChange() },
    outputs: function () { return state.connected ? [{ id: 'mock-out-1', name: state.deviceName }] : [] },
    inputs: function () { return state.connected ? [{ id: inPort.id, name: inPort.name }] : [] },
    inputMatchingOutput: function () { return state.connected ? { id: inPort.id, name: inPort.name } : null },
    enableInput: function () {},
    onInputNoteOn: function (cb) {
      inputCbs.push(cb)
      return function () { const i = inputCbs.indexOf(cb); if (i !== -1) inputCbs.splice(i, 1) }
    },
    noteOn: function (pitch, vel, ts) { return send([0x90, pitch & 0x7f, vel & 0x7f], ts) },
    noteOff: function (pitch, ts) { return send([0x80, pitch & 0x7f, 0], ts) },
    cc: function (num, val, ts) { return send([0xB0, num & 0x7f, val & 0x7f], ts) },
    clearQueue: function () {},
    panic: function () { send([0xB0, 123, 0]) },
    testNote: function () { api.noteOn(60, 80); setTimeout(function () { api.noteOff(60) }, 500) },
    testPedal: function () { api.cc(64, 127); setTimeout(function () { api.cc(64, 0) }, 700) },
    get connected() { return state.connected },
    get deviceName() { return state.connected ? state.deviceName : null },
    get deviceId() { return state.connected ? 'mock-out-1' : null },
    get error() { return null },

    // --- test / dev controls (not part of the real interface) ---------------
    _sends: sends,
    _state: state,
    _fireInput: fireInput,
    setDelayMode: function (on, constMs) { state.delayMode = Boolean(on); if (constMs != null) state.delayConstMs = constMs },
    setLoopback: function (ms) { state.loopbackMs = ms },
    setConnected: function (b) { state.connected = Boolean(b); if (onChange) onChange() }
  }

  // hidden constructor hook so PlayerView can pass its onChange callback
  api._setOnChange = function (cb) { onChange = cb }
  return api
}

// Factory matching createMidiOut(onChange)'s signature.
export function createMockMidiOut(onChange) {
  const opts = (typeof window !== 'undefined' && window.__PF_MOCK_MIDI_OPTS) || {}
  const m = createMockMidi(opts)
  m._setOnChange(onChange)
  return m
}

export function mockMidiEnabled() {
  if (typeof window === 'undefined') return false
  if (window.__PF_MOCK_MIDI) return true
  try { return String(window.location.search || '').indexOf('mockmidi') !== -1 } catch (e) { return false }
}
