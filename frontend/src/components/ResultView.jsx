import { useEffect, useRef, useState } from 'react'
import PianoRoll from './PianoRoll.jsx'
import { getEvents, midiUrl, audioUrl, fetchMidiBase64 } from '../api.js'
import { saveSong } from '../firebase.js'

const DEFAULTS = { velMin: 20, velMax: 112, gamma: 1.0, offsetMs: 0, pedal: true }

export default function ResultView({ job, firebaseReady }) {
  const [events, setEvents] = useState(null)
  const [settings, setSettings] = useState(DEFAULTS)
  const [playhead, setPlayhead] = useState(0)
  const [saving, setSaving] = useState(false)
  const audioRef = useRef(null)

  useEffect(function () {
    let alive = true
    getEvents(job.id).then(function (ev) {
      if (alive) setEvents(ev)
    }).catch(function (e) {
      console.error(e)
    })
    return function () { alive = false }
  }, [job.id])

  useEffect(function () {
    const audio = audioRef.current
    if (!audio) return
    let raf = null
    function tick() {
      setPlayhead(audio.paused ? audio.currentTime : audio.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return function () { cancelAnimationFrame(raf) }
  }, [events])

  function set(key, value) {
    const next = {}
    for (const k in settings) next[k] = settings[k]
    next[key] = value
    setSettings(next)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const b64 = await fetchMidiBase64(job.id, settings)
      if (b64.length > 900000) {
        alert('MIDI too large for the cloud library (>900KB). Download it instead.')
        return
      }
      await saveSong({
        title: job.name,
        noteCount: job.noteCount,
        pedalCount: job.pedalCount,
        settings: settings,
        midiBase64: b64
      })
      alert('Saved to library ✓')
    } catch (e) {
      alert('Save failed: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <h3>{job.name} — preview & export</h3>

      <div className="players">
        <div className="player">
          <label>Extracted piano stem (what the transcription heard)</label>
          <audio ref={audioRef} controls src={audioUrl(job.id, 'piano')} />
        </div>
        {job.accompaniment ? (
          <div className="player">
            <label>Accompaniment, piano removed (plays through ENSPIRE speakers)</label>
            <audio controls src={audioUrl(job.id, 'accompaniment')} />
          </div>
        ) : (
          <div className="player">
            <label>Original MP3 (re-convert to get a piano-less accompaniment)</label>
            <audio controls src={audioUrl(job.id, 'original')} />
          </div>
        )}
      </div>

      {events
        ? <PianoRoll events={events} playheadSec={playhead} />
        : <div className="meta">Loading note data…</div>}

      <div className="controls">
        <div className="control">
          <label>Velocity floor — <span className="val">{settings.velMin}</span></label>
          <input type="range" min="1" max="80" value={settings.velMin}
            onChange={function (e) { set('velMin', Number(e.target.value)) }} />
        </div>
        <div className="control">
          <label>Velocity ceiling — <span className="val">{settings.velMax}</span></label>
          <input type="range" min="60" max="127" value={settings.velMax}
            onChange={function (e) { set('velMax', Number(e.target.value)) }} />
        </div>
        <div className="control">
          <label>
            Dynamics curve — <span className="val">{settings.gamma.toFixed(2)}</span>
            {settings.gamma < 1 ? ' (flatter)' : settings.gamma > 1 ? ' (more contrast)' : ''}
          </label>
          <input type="range" min="0.4" max="2.0" step="0.05" value={settings.gamma}
            onChange={function (e) { set('gamma', Number(e.target.value)) }} />
        </div>
        <div className="control">
          <label>Timing offset — <span className="val">{settings.offsetMs} ms</span></label>
          <input type="range" min="-500" max="500" step="10" value={settings.offsetMs}
            onChange={function (e) { set('offsetMs', Number(e.target.value)) }} />
        </div>
        <div className="control check" style={{ alignSelf: 'end' }}>
          <input id="pedal" type="checkbox" checked={settings.pedal}
            onChange={function (e) { set('pedal', e.target.checked) }} />
          <label htmlFor="pedal" style={{ margin: 0 }}>Include sustain pedal (CC64)</label>
        </div>
      </div>

      <div className="actions">
        <a href={midiUrl(job.id, settings)} download={job.name + '.mid'}>
          <button className="primary">⬇ Download .mid for ENSPIRE</button>
        </a>
        {job.accompaniment && (
          <a href={audioUrl(job.id, 'accompaniment')}
            download={job.name + ' (no piano).mp3'}>
            <button className="primary">⬇ Download accompaniment .mp3</button>
          </a>
        )}
        {firebaseReady && (
          <button className="ghost" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : '☁ Save to library'}
          </button>
        )}
      </div>

      <div className="notice">
        <strong>Disklavier playback:</strong> copy the .mid and the accompaniment .mp3
        (piano removed — vocals and band only) to a USB stick. On the ENSPIRE, play the
        MIDI (piano keys move) and start the MP3 together — both share the same
        timeline. Use the timing offset slider if the piano feels early/late, then
        re-download.
      </div>
    </div>
  )
}
