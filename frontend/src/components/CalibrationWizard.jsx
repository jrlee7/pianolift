// Calibration wizard: measures the Disklavier's per-velocity actuation latency
// so the scheduler can fire each note early by exactly the right (velocity-
// dependent) amount. The velocity dependence is the whole point — a soft note's
// solenoid is slower than a loud one, so no single flat offset can ever be
// exact.
//
// Method is chosen automatically: if the piano echoes its key sensors back on
// MIDI input we use that (no mic, one clock domain, most accurate); otherwise
// we fall back to the laptop microphone. The constant TV/display latency is NOT
// measured here — it's velocity-independent, so the Visual Sync Test folds it
// into the ordinary sync offset, which is easy to zero by eye and ear.

import { useEffect, useRef, useState } from 'react'
import { createCalibrator, saveCalibration, latencyForVelocity } from '../calibrate.js'

export default function CalibrationWizard({ midi, onApply, onClose, onLaunchVisual }) {
  const [step, setStep] = useState('intro') // intro | running | done | error
  const [method, setMethod] = useState(null) // 'echo' | 'mic'
  const [progress, setProgress] = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [curve, setCurve] = useState([])
  const [errMsg, setErrMsg] = useState('')
  const calRef = useRef(null)

  useEffect(function () {
    return function () { if (calRef.current) calRef.current.stopMic() }
  }, [])

  const connected = midi.connected

  async function run() {
    setErrMsg('')
    setStep('running')
    setProgress(0)
    const cal = createCalibrator(midi)
    calRef.current = cal
    try {
      // Prefer MIDI key-echo when the piano provides it.
      setProgressMsg('Checking whether the piano reports its keys…')
      let useEcho = false
      try { useEcho = await cal.probeMidiEcho() } catch (e) { useEcho = false }
      setMethod(useEcho ? 'echo' : 'mic')

      if (!useEcho) {
        setProgressMsg('Starting the microphone… (allow access if asked)')
        await cal.startMic()
      }

      const result = await cal.measurePiano({
        useEcho: useEcho,
        onProgress: function (stage, frac, msg) {
          setProgress(frac)
          if (msg) setProgressMsg(msg)
        }
      })
      cal.stopMic()

      if (!result.length) {
        setErrMsg(useEcho
          ? 'No key-echo detected. Reconnect the piano or try again in a quiet room for the microphone method.'
          : 'No note strikes were heard. Put the laptop nearer the piano, lower the room noise, and retry.')
        setStep('error')
        return
      }
      setCurve(result)
      setStep('done')
    } catch (e) {
      setErrMsg(e.message || String(e))
      setStep('error')
    }
  }

  function apply() {
    saveCalibration(curve, 0) // TV latency handled via the Visual Test's offset
    onApply(curve, 0)
  }

  const span = curve.length
    ? (curve[curve.length - 1].ms - curve[0].ms)
    : 0

  return (
    <div className="cal-modal-backdrop">
      <div className="cal-modal">
        <div className="cal-head">
          <h3>⚡ Calibrate piano timing</h3>
          <button className="cal-x" onClick={onClose}>✕</button>
        </div>

        {step === 'intro' && (
          <div className="cal-body">
            <p>This plays a few test notes on the piano and measures how long
              each takes to actually sound — soft notes are slower than loud
              ones, so we measure the whole range. Takes about 30 seconds.</p>
            <ul className="cal-list">
              <li>Piano connected over USB and turned on.</li>
              <li>If your piano doesn’t report its keys, the laptop microphone is
                used instead — keep the room quiet and the laptop near the piano.</li>
            </ul>
            {!connected && <p className="cal-warn">⚠ No MIDI device connected — connect the piano first.</p>}
            <div className="cal-actions">
              <button className="primary" disabled={!connected} onClick={run}>Start</button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}

        {step === 'running' && (
          <div className="cal-body">
            <p>{method === 'echo' ? '🎹 Reading the piano’s key sensors…'
              : method === 'mic' ? '🎤 Listening to the piano…'
              : 'Preparing…'}</p>
            <div className="cal-progress"><div className="cal-progress-fill"
              style={{ width: Math.round(progress * 100) + '%' }} /></div>
            <p className="meta">{progressMsg}</p>
          </div>
        )}

        {step === 'done' && (
          <div className="cal-body">
            <p>✓ Measured. Latency by velocity:</p>
            <table className="cal-table">
              <thead><tr><th>Velocity</th><th>Latency</th></tr></thead>
              <tbody>
                {curve.map(function (pt) {
                  return <tr key={pt.vel}><td>{pt.vel}</td><td>{pt.ms} ms</td></tr>
                })}
              </tbody>
            </table>
            <p className="meta">
              Method: {method === 'echo' ? 'key-echo (most accurate)' : 'microphone'}.
              {span > 8 ? ' The ' + span + ' ms spread across velocities is why per-note compensation matters.'
                : ' Latency is fairly flat across velocities here.'}
            </p>
            <div className="cal-actions">
              <button className="primary" onClick={function () { apply(); if (onLaunchVisual) onLaunchVisual() }}>
                Apply &amp; open Visual Test
              </button>
              <button onClick={apply}>Apply &amp; close</button>
              <button onClick={run}>Re-measure</button>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="cal-body">
            <p className="cal-warn">{errMsg}</p>
            <div className="cal-actions">
              <button className="primary" onClick={run}>Try again</button>
              <button onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
