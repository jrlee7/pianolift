import { useEffect, useRef, useState } from 'react'
import PianoRoll from './PianoRoll.jsx'
import { getEvents, midiUrl, audioUrl, fetchMidiBase64 } from '../api.js'
import { saveSong } from '../firebase.js'
import { createPreviewPlayer } from '../previewSynth.js'

const DEFAULTS = { velMin: 20, velMax: 112, gamma: 1.0, offsetMs: 0, pedal: true }

export default function ResultView({ job, firebaseReady }) {
  const [events, setEvents] = useState(null)
  const [settings, setSettings] = useState(DEFAULTS)
  const [playhead, setPlayhead] = useState(0)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const stemRef = useRef(null)
  const accompRef = useRef(null)
  const playerRef = useRef(null)

  const trimStart = job.trimStartSec || 0
  const encDelay = (job.encoderDelayMs || 0) / 1000

  useEffect(function () {
    let alive = true
    getEvents(job.id).then(function (ev) {
      if (alive) setEvents(ev)
    }).catch(function (e) {
      console.error(e)
    })
    return function () {
      alive = false
      if (playerRef.current) playerRef.current.stop()
    }
  }, [job.id])

  useEffect(function () {
    let raf = null
    function tick() {
      const stem = stemRef.current
      const acc = accompRef.current
      // piano roll runs on the original (untrimmed) timeline: the stem player
      // maps 1:1, the accompaniment player is shifted by the trim cut
      if (acc && !acc.paused) {
        setPlayhead(acc.currentTime + trimStart)
      } else if (stem && !stem.paused) {
        setPlayhead(stem.currentTime)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return function () { cancelAnimationFrame(raf) }
  }, [events, trimStart])

  function set(key, value) {
    const next = {}
    for (const k in settings) next[k] = settings[k]
    next[key] = value
    setSettings(next)
  }

  function stopPreview() {
    if (playerRef.current) {
      playerRef.current.stop()
      playerRef.current = null
    }
    setPreviewing(false)
  }

  async function playBoth() {
    if (previewing) {
      stopPreview()
      return
    }
    if (!events || !accompRef.current) return
    if (stemRef.current) stemRef.current.pause()
    // Same math the backend bakes into the real MIDI render:
    // user offset + codec-delay compensation - dead-space trim.
    const effOffset = settings.offsetMs / 1000 + encDelay - trimStart
    const player = createPreviewPlayer(
      events.notes, settings, accompRef.current, effOffset)
    playerRef.current = player
    setPreviewing(true)
    try {
      await player.start()
    } catch (e) {
      alert('Playback failed: ' + e.message)
      stopPreview()
    }
  }

  useEffect(function () {
    const acc = accompRef.current
    if (!acc) return
    // Only 'ended' tears the preview down. Pauses (user or browser media
    // suspension) just silence the synth; it resumes with the audio.
    function onEnded() { stopPreview() }
    acc.addEventListener('ended', onEnded)
    return function () {
      acc.removeEventListener('ended', onEnded)
    }
  }, [events])

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
          <audio ref={stemRef} controls src={audioUrl(job.id, 'piano')} />
        </div>
        {job.accompaniment ? (
          <div className="player">
            <label>Accompaniment, piano removed (plays through ENSPIRE speakers)</label>
            <audio ref={accompRef} controls src={audioUrl(job.id, 'accompaniment')} />
          </div>
        ) : (
          <div className="player">
            <label>Original MP3 (re-convert to get a piano-less accompaniment)</label>
            <audio controls src={audioUrl(job.id, 'original')} />
          </div>
        )}
      </div>

      {job.accompaniment && (
        <div className="actions" style={{ marginTop: 10 }}>
          <button className={previewing ? 'ghost' : 'primary'} onClick={playBoth}
            disabled={!events}>
            {previewing ? '■ Stop preview' : '▶ Play both together'}
          </button>
          <span className="meta" style={{ alignSelf: 'center' }}>
            Synth piano + accompaniment, using current slider settings —
            rough tone, real timing. Judge sync here before the USB trip.
          </span>
        </div>
      )}

      {events
        ? <PianoRoll events={events} playheadSec={playhead} />
        : <div className="meta">Loading note data…</div>}

      <div className="controls">
        <div className="control">
          <label>Velocity floor — <span className="val">{settings.velMin}</span></label>
          <input type="range" min="1" max="80" value={settings.velMin}
            onChange={function (e) { set('velMin', Number(e.target.value)) }} />
          <div className="hint">
            Quietest allowed note. Raise if soft passages barely move the keys;
            lower if whisper-quiet moments lose their character.
          </div>
        </div>
        <div className="control">
          <label>Velocity ceiling — <span className="val">{settings.velMax}</span></label>
          <input type="range" min="60" max="127" value={settings.velMax}
            onChange={function (e) { set('velMax', Number(e.target.value)) }} />
          <div className="hint">
            Loudest allowed note. Lower if big moments bang or feel harsh in
            the room; raise if climaxes feel timid.
          </div>
        </div>
        <div className="control">
          <label>
            Dynamics curve — <span className="val">{settings.gamma.toFixed(2)}</span>
            {settings.gamma < 1 ? ' (flatter)' : settings.gamma > 1 ? ' (more contrast)' : ''}
          </label>
          <input type="range" min="0.4" max="2.0" step="0.05" value={settings.gamma}
            onChange={function (e) { set('gamma', Number(e.target.value)) }} />
          <div className="hint">
            Below 1.0 = flatter, more even (background music). Above 1.0 = more
            contrast between soft and loud (expressive listening). 1.0 = as
            transcribed.
          </div>
        </div>
        <div className="control">
          <label>Timing offset — <span className="val">{settings.offsetMs} ms</span></label>
          <input type="range" min="-500" max="500" step="10" value={settings.offsetMs}
            onChange={function (e) { set('offsetMs', Number(e.target.value)) }} />
          <div className="hint">
            0 is already synced. Piano ahead of the band → go negative; piano
            behind → positive. Move in 50 ms steps, re-download, re-test.
          </div>
        </div>
        <div className="control">
          <div className="check">
            <input id="pedal" type="checkbox" checked={settings.pedal}
              onChange={function (e) { set('pedal', e.target.checked) }} />
            <label htmlFor="pedal" style={{ margin: 0 }}>Include sustain pedal (CC64)</label>
          </div>
          <div className="hint">
            Turn off if busy passages blur or sound muddy — drier, more
            staccato. Turn back on if notes cut off unnaturally.
          </div>
        </div>
      </div>

      <details className="tips">
        <summary>Tips for better sound</summary>
        <ul>
          <li><strong>Listen to the piano stem player first.</strong> That's exactly
            what the transcription heard. Clean stem = accurate MIDI. Vocal or
            cymbal bleed = expect ghost notes.</li>
          <li><strong>Scan the piano roll.</strong> Scattered specks outside the
            melodic shape are bleed from other instruments, not real piano.</li>
          <li><strong>Tune on the real piano, not headphones.</strong> Set
            floor/ceiling for the room first; only touch the dynamics curve if
            soft-vs-loud contrast still feels wrong.</li>
          <li><strong>Judging accuracy?</strong> Toggle pedal off temporarily —
            sustain masks timing and dynamics problems.</li>
          <li><strong>Rough results?</strong> Try a different master of the same
            song (acoustic/unplugged versions transcribe far cleaner than dense
            studio mixes). Some wall-of-sound productions just won't convert well.</li>
          <li><strong>Piano-forward songs work best</strong> — piano + vocals,
            ballads, hymn arrangements. Heavy synth-pop confuses the separator.</li>
        </ul>
      </details>

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
