// Calibration wizard. Two ways to make the Disklavier land in sync with the TV:
//
//  1. Delay mode (recommended): turn on the piano's own "MIDI IN Delay" so it
//     sounds every note a fixed ~500 ms after receiving it. Latency becomes a
//     single constant (velocity-independent), and the scheduler just fires each
//     note that much earlier. The wizard VERIFIES the piano is really in this
//     mode by checking a soft and a loud note both land at ~500 ms and agree.
//  2. Curve mode: measure the raw per-velocity solenoid latency (soft notes are
//     slower than loud), producing a curve the scheduler interpolates.
//
// Measurement uses the piano's MIDI key-echo when available (one clock domain,
// no mic), rejecting the immediate command-loopback that a MIDI-thru produces;
// otherwise it falls back to the laptop microphone. It also measures the TV/
// display latency by clicking a beep out the HDMI audio path and timing it.

import { useEffect, useRef, useState } from 'react'
import {
  createCalibrator, saveCalibration, makeBeepPlayer, DEFAULT_DELAY_MS
} from '../calibrate.js'

export default function CalibrationWizard({ midi, current, onApply, onClose, onLaunchVisual }) {
  const [step, setStep] = useState('intro') // intro|running|probeDone|measureDone|done|error
  const [mode, setMode] = useState('delay')  // 'delay' | 'curve'
  const [method, setMethod] = useState(null)  // 'echo' | 'mic'
  const [probe, setProbe] = useState(null)    // {hasEcho, port, medianDt, sawLoopback}
  const [progress, setProgress] = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [curve, setCurve] = useState([])
  const [delayResult, setDelayResult] = useState(null) // {ok, constMs, lo, hi, spread}
  const [micOffset, setMicOffset] = useState(current && current.micOffsetMs || 0)
  const [tvLatency, setTvLatency] = useState(current && current.tvLatencyMs || 0)
  const [tvMeasured, setTvMeasured] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const calRef = useRef(null)
  const beepRef = useRef(null)

  useEffect(function () {
    return function () {
      if (calRef.current) calRef.current.stopMic()
      if (beepRef.current) beepRef.current.dispose()
    }
  }, [])

  const connected = midi.connected

  function prog(stage, frac, msg) {
    setProgress(frac)
    if (msg) setProgressMsg(msg)
  }

  function echoPortId() { return probe && probe.port ? probe.port.id : null }

  // Step 1: probe for key-echo.
  async function runProbe() {
    setErrMsg('')
    setStep('running')
    setProgress(0)
    setProgressMsg('Checking whether the piano reports its keys…')
    const cal = createCalibrator(midi)
    calRef.current = cal
    try {
      let p = { hasEcho: false, port: null, medianDt: null, sawLoopback: false }
      try { p = await cal.probeEcho({ outputName: midi.deviceName }) } catch (e) { /* mic */ }
      setProbe(p)
      setMethod(p.hasEcho ? 'echo' : 'mic')
      setStep('probeDone')
    } catch (e) {
      setErrMsg(e.message || String(e))
      setStep('error')
    }
  }

  // Step 2: measure — delay-verify or full curve.
  async function runMeasure() {
    setStep('running')
    setProgress(0)
    const cal = calRef.current
    const useEcho = method === 'echo'
    try {
      if (mode === 'delay') {
        setProgressMsg('Confirming the fixed delay…')
        const res = await cal.verifyDelayMode({
          useEcho: useEcho, echoPortId: echoPortId(), onProgress: prog
        })
        setDelayResult(res)
      } else {
        setProgressMsg('Measuring latency by velocity…')
        const res = await cal.measurePiano({
          useEcho: useEcho, echoPortId: echoPortId(), onProgress: prog
        })
        if (!res.length) {
          setErrMsg(useEcho
            ? 'No key-echo timing captured. Reconnect the piano, or use the microphone method in a quiet room.'
            : 'No note strikes were heard. Put the laptop nearer the piano and lower the room noise.')
          setStep('error')
          return
        }
        setCurve(res)
      }
      setStep('measureDone')
    } catch (e) {
      setErrMsg(e.message || String(e))
      setStep('error')
    }
  }

  // Step 3 (optional): TV/display latency via a beep out the HDMI audio path.
  async function runTv() {
    setStep('running')
    setProgress(0)
    setProgressMsg('Preparing the beep…')
    const cal = calRef.current
    const useEcho = method === 'echo'
    const beeper = makeBeepPlayer()
    beepRef.current = beeper
    try {
      let micOff = 0
      if (useEcho) {
        setProgressMsg('Measuring the microphone offset…')
        const mo = await cal.measureMicOffset({ echoPortId: echoPortId() })
        micOff = Number.isFinite(mo) ? Math.round(mo) : 0
      }
      const raw = await cal.measureTv({ beep: beeper.beep, onProgress: prog })
      beeper.dispose()
      beepRef.current = null
      if (raw == null) {
        setErrMsg('No beep was heard. Set the computer\'s sound output to the TV (HDMI), turn the TV up, and retry — or Skip and zero the TV offset in the Visual Test.')
        setStep('error')
        return
      }
      // Piano measured by echo? The (mic-only) TV reading carries a mic-path
      // offset the piano number doesn't, so subtract it. Mic-measured piano
      // already shares that offset, so leave the reading raw (it cancels).
      setMicOffset(useEcho ? micOff : 0)
      setTvLatency(Math.round(raw - (useEcho ? micOff : 0)))
      setTvMeasured(true)
      setStep('done')
    } catch (e) {
      if (beepRef.current) { beepRef.current.dispose(); beepRef.current = null }
      setErrMsg(e.message || String(e))
      setStep('error')
    }
  }

  function skipTv() {
    if (calRef.current) calRef.current.stopMic()
    setStep('done')
  }

  function switchToCurve() {
    setMode('curve')
    setDelayResult(null)
    runMeasure()
  }

  function buildCal() {
    const port = echoPortId() || (current ? current.echoPortId : null)
    if (mode === 'delay') {
      return {
        delayMode: true,
        delayVerified: Boolean(delayResult && delayResult.ok),
        delayConstMs: delayResult && delayResult.constMs != null
          ? delayResult.constMs : DEFAULT_DELAY_MS,
        curve: [],
        tvLatencyMs: tvLatency,
        micOffsetMs: micOffset,
        echoPortId: port
      }
    }
    return {
      delayMode: false,
      curve: curve,
      tvLatencyMs: tvLatency,
      micOffsetMs: micOffset,
      echoPortId: port
    }
  }

  function apply() {
    const cal = buildCal()
    saveCalibration(cal)
    onApply(cal)
  }

  const canApply = mode === 'curve'
    ? curve.length > 0
    : Boolean(delayResult && delayResult.ok)

  const span = curve.length ? (curve[curve.length - 1].ms - curve[0].ms) : 0

  return (
    <div className="cal-modal-backdrop">
      <div className="cal-modal">
        <div className="cal-head">
          <h3>⚡ Calibrate piano timing</h3>
          <button className="cal-x" onClick={onClose}>✕</button>
        </div>

        {step === 'intro' && (
          <div className="cal-body">
            <p>Two ways to lock the piano to the picture. Takes under a minute.</p>
            <label className="cal-radio">
              <input type="radio" name="calmode" checked={mode === 'delay'}
                onChange={function () { setMode('delay') }} />
              <span><strong>Disklavier delay mode</strong> (recommended) — the piano
                applies one fixed delay, so timing is exact and velocity-independent.</span>
            </label>
            <label className="cal-radio">
              <input type="radio" name="calmode" checked={mode === 'curve'}
                onChange={function () { setMode('curve') }} />
              <span><strong>Measure velocity curve</strong> — for pianos without the
                delay setting; measures how soft vs loud notes differ.</span>
            </label>
            {mode === 'delay' && (
              <div className="cal-note">
                <p className="meta"><strong>On the piano first</strong> (ENSPIRE Controller app →
                  Settings → MIDI):</p>
                <ul className="cal-list">
                  <li>MIDI IN Delay: <strong>ON</strong></li>
                  <li>MIDI OUT: <strong>Keyboard Out</strong> (lets the wizard read your keys)</li>
                  <li>MIDI OUT Port: <strong>USB</strong> (or MIDI+USB)</li>
                </ul>
                <p className="meta">This only changes timing — it does not affect the piano's
                  sound or dynamics.</p>
              </div>
            )}
            {!connected && <p className="cal-warn">⚠ No MIDI device connected — connect the piano first.</p>}
            <div className="cal-actions">
              <button className="primary" disabled={!connected} onClick={runProbe}>Start</button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}

        {step === 'running' && (
          <div className="cal-body">
            <p>{method === 'echo' ? '🎹 Reading the piano\'s key sensors…'
              : method === 'mic' ? '🎤 Listening…'
              : 'Working…'}</p>
            <div className="cal-progress"><div className="cal-progress-fill"
              style={{ width: Math.round(progress * 100) + '%' }} /></div>
            <p className="meta">{progressMsg}</p>
          </div>
        )}

        {step === 'probeDone' && (
          <div className="cal-body">
            {probe && probe.hasEcho ? (
              <p>✓ Key-echo detected{probe.port ? ' on “' + probe.port.name + '”' : ''}
                {probe.medianDt != null ? ' (~' + Math.round(probe.medianDt) + ' ms)' : ''}.
                Measuring straight from the piano — no microphone needed.</p>
            ) : (
              <p>No key-echo{probe && probe.sawLoopback
                ? ' (saw only an immediate MIDI-thru echo, which is not the key sensor)'
                : ''}. Falling back to the <strong>microphone</strong>. For the more
                accurate method, set MIDI OUT to <strong>Keyboard Out</strong>, Port
                <strong> USB</strong> on the piano and re-run.</p>
            )}
            <div className="cal-actions">
              <button className="primary" onClick={runMeasure}>
                {mode === 'delay' ? 'Verify delay' : 'Measure curve'}
              </button>
              <button onClick={runProbe}>Re-probe</button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}

        {step === 'measureDone' && mode === 'delay' && (
          <div className="cal-body">
            {delayResult && delayResult.ok ? (
              <>
                <p>✓ Delay mode confirmed: a flat <strong>{delayResult.constMs} ms</strong> at
                  both soft and loud (soft {delayResult.lo} ms · loud {delayResult.hi} ms).</p>
                <p className="meta">Now optionally measure your TV's picture delay, or skip and
                  fine-tune it later in the Visual Test.</p>
                <div className="cal-actions">
                  <button className="primary" onClick={runTv}>Measure TV delay</button>
                  <button onClick={skipTv}>Skip</button>
                </div>
              </>
            ) : (
              <>
                <p className="cal-warn">Delay mode does not look active.
                  {delayResult && delayResult.lo != null
                    ? ' Measured soft ' + delayResult.lo + ' ms · loud ' + delayResult.hi +
                      ' ms (spread ' + delayResult.spread + ' ms).'
                    : ' No timing captured.'}</p>
                <p className="meta">Turn on <strong>MIDI IN Delay</strong> in the ENSPIRE app
                  (Settings → MIDI) and re-verify, or measure the velocity curve instead.</p>
                <div className="cal-actions">
                  <button className="primary" onClick={runMeasure}>Re-verify</button>
                  <button onClick={switchToCurve}>Measure curve instead</button>
                  <button onClick={onClose}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}

        {step === 'measureDone' && mode === 'curve' && (
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
              {span > 8 ? ' The ' + span + ' ms spread is why per-note compensation matters.'
                : ' Latency is fairly flat here.'}
            </p>
            <div className="cal-actions">
              <button className="primary" onClick={runTv}>Measure TV delay</button>
              <button onClick={skipTv}>Skip</button>
              <button onClick={runMeasure}>Re-measure</button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="cal-body">
            <p>✓ Ready to apply.</p>
            <ul className="cal-list">
              <li>{mode === 'delay'
                ? 'Piano: fixed ' + (delayResult ? delayResult.constMs : DEFAULT_DELAY_MS) + ' ms delay'
                : 'Piano: ' + curve.length + '-point velocity curve'}</li>
              <li>TV/display latency: {tvMeasured ? tvLatency + ' ms (measured)' : tvLatency + ' ms (unchanged)'}</li>
            </ul>
            <div className="cal-actions">
              <button className="primary"
                onClick={function () { apply(); if (onLaunchVisual) onLaunchVisual() }}>
                Apply &amp; open Visual Test
              </button>
              <button onClick={apply}>Apply &amp; close</button>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="cal-body">
            <p className="cal-warn">{errMsg}</p>
            <div className="cal-actions">
              <button className="primary" onClick={runProbe}>Start over</button>
              {canApply && <button onClick={apply}>Apply what we have</button>}
              <button onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
