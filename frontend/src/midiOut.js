// Web MIDI output manager for the video-sync player. Chromium (Electron and
// Chrome/Edge dev) implements Web MIDI natively, so the renderer talks straight
// to the Disklavier's USB-MIDI port — no backend hop, and note timestamps ride
// the same performance.now() clock as the <video> element.

const STORE_KEY = 'pf_midi_output_id'

// Names that suggest the Disklavier's USB TO HOST port, tried in order when
// no stored device matches.
const AUTO_PICK = /disklavier|dkv|enspire|yamaha|usb.?midi/i

export function createMidiOut(onChange) {
  let access = null
  let output = null      // selected MIDIOutput (or null)
  let error = null       // human-readable init failure

  function outputs() {
    if (!access) return []
    const list = []
    access.outputs.forEach(function (o) {
      list.push({ id: o.id, name: o.name || 'MIDI device' })
    })
    return list
  }

  function notify() {
    if (onChange) onChange()
  }

  function pickDefault() {
    if (!access || access.outputs.size === 0) {
      output = null
      return
    }
    const stored = localStorage.getItem(STORE_KEY)
    let best = null
    access.outputs.forEach(function (o) {
      if (stored && o.id === stored) best = o
    })
    if (!best) {
      access.outputs.forEach(function (o) {
        if (!best && AUTO_PICK.test(o.name || '')) best = o
      })
    }
    if (!best) {
      access.outputs.forEach(function (o) { if (!best) best = o })
    }
    output = best
  }

  async function init() {
    if (access) return
    if (!navigator.requestMIDIAccess) {
      error = 'Web MIDI not supported here. Use the desktop app or Chrome/Edge.'
      notify()
      return
    }
    try {
      access = await navigator.requestMIDIAccess({ sysex: false })
    } catch (e) {
      error = 'MIDI access denied: ' + (e.message || e.name)
      notify()
      return
    }
    // Hot-plug: refresh the device list and keep a valid selection when the
    // piano is connected/disconnected mid-session.
    access.onstatechange = function () {
      if (output) {
        let still = false
        access.outputs.forEach(function (o) {
          if (o.id === output.id) still = true
        })
        if (!still) output = null
      }
      if (!output) pickDefault()
      notify()
    }
    pickDefault()
    notify()
  }

  function select(id) {
    if (!access) return
    let found = null
    access.outputs.forEach(function (o) { if (o.id === id) found = o })
    output = found
    if (found) localStorage.setItem(STORE_KEY, id)
    notify()
  }

  // ts: DOMHighResTimeStamp (performance.now() based); omit for "now".
  // Chromium queues future-stamped messages in the MIDI driver, so scheduled
  // notes land with sub-ms jitter regardless of JS timer slop.
  function send(bytes, ts) {
    if (!output) return false
    try {
      if (ts != null) output.send(bytes, ts)
      else output.send(bytes)
      return true
    } catch (e) {
      return false
    }
  }

  function noteOn(pitch, vel, ts) { return send([0x90, pitch & 0x7f, vel & 0x7f], ts) }
  function noteOff(pitch, ts) { return send([0x80, pitch & 0x7f, 0], ts) }
  function cc(num, val, ts) { return send([0xB0, num & 0x7f, val & 0x7f], ts) }

  // Drop messages already queued with future timestamps (seek/pause/panic).
  // clear() is in the spec but not every Chromium ships it.
  function clearQueue() {
    if (output && typeof output.clear === 'function') {
      try { output.clear() } catch (e) { /* best-effort */ }
    }
  }

  function panic() {
    clearQueue()
    cc(64, 0)     // sustain off
    cc(123, 0)    // all notes off
    cc(120, 0)    // all sound off (kills anything CC123 misses)
  }

  function testNote() {
    // Middle C, mezzo-forte, half a second — enough to hear the solenoid fire.
    noteOn(60, 80)
    noteOn(64, 80)
    setTimeout(function () { noteOff(60); noteOff(64) }, 500)
  }

  function testPedal() {
    cc(64, 127)
    setTimeout(function () { cc(64, 0) }, 700)
  }

  return {
    init,
    select,
    outputs,
    noteOn, noteOff, cc,
    clearQueue,
    panic,
    testNote,
    testPedal,
    get connected() { return Boolean(output) },
    get deviceName() { return output ? (output.name || 'MIDI device') : null },
    get deviceId() { return output ? output.id : null },
    get error() { return error }
  }
}
