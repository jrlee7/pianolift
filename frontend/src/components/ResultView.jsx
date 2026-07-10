import { useEffect, useRef, useState } from 'react'
import NoteEditor from './NoteEditor.jsx'
import {
  getEvents, midiUrl, audioUrl, eseqUrl, hfeUrl, fetchMidiBase64,
  getUsbStatus, saveToUsb, saveEvents, resetEvents,
  getDrives, exportToDrive, trimJob
} from '../api.js'
import { saveSong } from '../firebase.js'
import { createPreviewPlayer, createNotePlayer } from '../previewSynth.js'

const DEFAULTS = {
  velMin: 20, velMax: 112, gamma: 1.0, offsetMs: 0, pedal: true,
  releaseMs: 0, capSustain: true
}

// give every note/pedal a stable id the editor can track selections with
function tagIds(ev) {
  let id = 1
  for (let i = 0; i < ev.notes.length; i++) ev.notes[i]._id = id++
  for (let i = 0; i < ev.pedals.length; i++) ev.pedals[i]._id = id++
  return ev
}

export default function ResultView({ job, firebaseReady, onArchived }) {
  const [events, setEvents] = useState(null)
  const [settings, setSettings] = useState(DEFAULTS)
  const [playhead, setPlayhead] = useState(0)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [usb, setUsb] = useState(null)
  const [usbSaving, setUsbSaving] = useState(false)
  const [usbResult, setUsbResult] = useState(null)
  const [drives, setDrives] = useState([])
  const [driveSel, setDriveSel] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [savingEdits, setSavingEdits] = useState(false)
  const [trimStart, setTrimStart] = useState(job.trimStartSec || 0)
  const [trimEnd, setTrimEnd] = useState(
    job.trimEndSec == null ? null : job.trimEndSec)
  const [trimming, setTrimming] = useState(false)
  const [audioVer, setAudioVer] = useState(0)
  const stemRef = useRef(null)
  const accompRef = useRef(null)
  const playerRef = useRef(null)
  const usbRootRef = useRef(null)

  const encDelay = (job.encoderDelayMs || 0) / 1000
  // drive picked in the select, else the only/first drive present
  const selDrive = drives.length
    ? (drives.find(function (d) { return d.root === driveSel }) || drives[0])
    : null

  useEffect(function () {
    let alive = true
    getEvents(job.id).then(function (ev) {
      if (alive) setEvents(tagIds(ev))
    }).catch(function (e) {
      console.error(e)
    })
    return function () {
      alive = false
      if (playerRef.current) playerRef.current.stop()
    }
  }, [job.id])

  function handleEdit(next) {
    setEvents(next)
    setDirty(true)
  }

  // Scrub: dragging the playhead in the editor seeks the audio (stem on the
  // original timeline, accompaniment shifted by the trim). setPlayhead moves
  // the line immediately even while paused.
  function handleSeek(t) {
    setPlayhead(t)
    const stem = stemRef.current
    const acc = accompRef.current
    if (stem) { try { stem.currentTime = t } catch (e) { /* not seekable yet */ } }
    if (acc) { try { acc.currentTime = Math.max(0, t - trimStart) } catch (e) { /* not seekable yet */ } }
    // Piano-only synth preview: re-anchor so playback continues from the new
    // spot. (Accompaniment preview follows the <audio> clock above already.)
    const p = playerRef.current
    if (p && p.seek) p.seek(t)
  }

  // Trim front/end — destructive. Backend deletes events outside the window,
  // shifts the rest to start at 0, and cuts the MP3 + piano stem to match, so
  // the dead space is truly gone and everything stays locked. Reload the
  // rewritten events and bump audioVer so both <audio> elements re-fetch.
  async function handleApplyTrim(start, end) {
    // Persist any unsaved note edits first — the backend trims events.json.
    if (dirty) {
      try {
        await saveEvents(job.id, events)
      } catch (e) {
        alert('Save your edits before trimming failed: ' + e.message)
        return
      }
    }
    setTrimming(true)
    try {
      const updated = await trimJob(job.id, start, end)
      const ev = await getEvents(job.id)
      setEvents(tagIds(ev))
      setTrimStart(0)
      setTrimEnd(null)
      setPlayhead(0)
      setDirty(false)
      job.trimStartSec = 0
      job.trimEndSec = null
      job.encoderDelayMs = updated.encoderDelayMs
      job.noteCount = updated.noteCount
      job.pedalCount = updated.pedalCount
      setAudioVer(function (v) { return v + 1 })
    } catch (e) {
      alert('Trim failed: ' + e.message)
    } finally {
      setTrimming(false)
    }
  }

  async function handleSaveEdits() {
    setSavingEdits(true)
    try {
      await saveEvents(job.id, events)
      setDirty(false)
    } catch (e) {
      alert('Saving edits failed: ' + e.message)
    } finally {
      setSavingEdits(false)
    }
  }

  async function handleResetEvents() {
    if (!window.confirm(
      'Throw away ALL edits and restore the original transcription?')) return
    try {
      const ev = await resetEvents(job.id)
      setEvents(tagIds(ev))
      setDirty(false)
      // reset may also restore a trimmed stem/accompaniment to full length
      setTrimStart(0)
      setTrimEnd(null)
      setPlayhead(0)
      job.trimStartSec = 0
      job.trimEndSec = null
      setAudioVer(function (v) { return v + 1 })
    } catch (e) {
      // 409 = never saved edits; local-only edits just reload from server
      try {
        const ev = await getEvents(job.id)
        setEvents(tagIds(ev))
        setDirty(false)
      } catch (e2) {
        alert('Reset failed: ' + e2.message)
      }
    }
  }

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

  // Poll for drives every 5s so buttons appear the moment a stick is
  // plugged in. The cheap /drives listing runs every tick; the expensive
  // Gotek slot scan only runs when the stick first shows up (or changes).
  useEffect(function () {
    let alive = true
    async function poll() {
      try {
        const d = await getDrives()
        if (!alive) return
        setDrives(d.removable)
        if (d.gotekRoot) {
          if (usbRootRef.current !== d.gotekRoot) {
            usbRootRef.current = d.gotekRoot
            const s = await getUsbStatus()
            if (alive) setUsb(s)
          }
        } else {
          usbRootRef.current = null
          setUsb(null)
        }
      } catch (e) {
        // backend not up yet / mid-restart; try again next tick
      }
    }
    poll()
    const t = setInterval(poll, 5000)
    return function () { alive = false; clearInterval(t) }
  }, [job.id])

  async function handleUsbSave() {
    setUsbSaving(true)
    setUsbResult(null)
    try {
      const r = await saveToUsb(job.id, settings)
      setUsbResult(r)
      const s = await getUsbStatus()  // slot just filled; refresh next-free
      setUsb(s)
    } catch (e) {
      alert('USB save failed: ' + e.message)
    } finally {
      setUsbSaving(false)
    }
  }

  // Native save-as dialog (Chrome/Edge/Electron). Falls back to a plain
  // browser download where the File System Access API is missing.
  async function saveAsDialog(url, suggestedName, desc, mime, ext) {
    if (!window.showSaveFilePicker) {
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      a.click()
      return
    }
    let handle
    try {
      const accept = {}
      accept[mime] = [ext]
      handle = await window.showSaveFilePicker({
        suggestedName: suggestedName,
        types: [{ description: desc, accept: accept }]
      })
    } catch (e) {
      if (e.name === 'AbortError') return // user cancelled the dialog
      // picker blocked (permissions etc.) — plain download instead
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      a.click()
      return
    }
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error('render failed (' + res.status + ')')
      const blob = await res.blob()
      const w = await handle.createWritable()
      await w.write(blob)
      await w.close()
      setExportResult({ filename: handle.name, path: null })
    } catch (e) {
      alert('Save failed: ' + e.message)
    }
  }

  async function handleExportHfe(destRoot) {
    setExporting(true)
    setExportResult(null)
    try {
      const r = await exportToDrive(job.id, 'hfe', destRoot, settings)
      setExportResult(r)
    } catch (e) {
      alert('Save to drive failed: ' + e.message)
    } finally {
      setExporting(false)
    }
  }

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

  // Synth + accompaniment from the top. createPreviewPlayer.start() resets the
  // <audio> to 0, so this always begins at the beginning.
  function startBoth() {
    if (!events || !accompRef.current) return
    if (stemRef.current) stemRef.current.pause()
    // Same math the backend bakes into the real MIDI render:
    // user offset + codec-delay compensation - dead-space trim.
    const effOffset = settings.offsetMs / 1000 + encDelay - trimStart
    const player = createPreviewPlayer(
      events.notes, settings, accompRef.current, effOffset)
    playerRef.current = player
    setPreviewing(true)
    player.start().catch(function (e) {
      alert('Playback failed: ' + e.message)
      stopPreview()
    })
  }

  async function playBoth() {
    if (previewing) {
      stopPreview()
      return
    }
    startBoth()
  }

  // Piano-only playback for songs with no accompaniment (library imports,
  // piano-only jobs). Clocks off the AudioContext and drives the playhead so
  // you can hear the notes — and A/B the sustain cap — with no audio track.
  function startPianoAt(startAt) {
    if (!events) return
    if (stemRef.current) stemRef.current.pause()
    const player = createNotePlayer(
      events.notes, settings,
      function (t) { setPlayhead(t) },
      function () { stopPreview() },
      startAt)
    playerRef.current = player
    setPreviewing(true)
    player.start().catch(function (e) {
      alert('Playback failed: ' + e.message)
      stopPreview()
    })
  }

  async function playPiano() {
    if (previewing) {
      stopPreview()
      return
    }
    startPianoAt((playhead > 0) ? playhead : 0)
  }

  // Restart from the very beginning regardless of where the start bar sits.
  function handleRestart() {
    stopPreview()
    setPlayhead(0)
    if (job.accompaniment) {
      const acc = accompRef.current
      if (acc) { try { acc.currentTime = 0 } catch (e) { /* not seekable yet */ } }
      startBoth()
    } else {
      startPianoAt(0)
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
    if (dirty && !window.confirm(
      'You have unsaved edits. Move to library using the last SAVED version? ' +
      'Hit Cancel, then "Save edits" first to include them.')) return
    setSaving(true)
    try {
      const b64 = await fetchMidiBase64(job.id, settings)
      if (b64.length > 900000) {
        alert('MIDI too large for the cloud library (>900KB). Download it instead.')
        setSaving(false)
        return
      }
      // Keep the piano-removed accompaniment MP3 alongside the MIDI — that's the
      // file the Disklavier plays through its speakers, already encoded by the
      // pipeline (small, no re-transcode). Piano-only / library jobs have no
      // accompaniment; those stay MIDI-only.
      let mp3Blob = null
      if (job.accompaniment) {
        try {
          const res = await fetch(audioUrl(job.id, 'accompaniment'))
          if (res.ok) mp3Blob = await res.blob()
        } catch (e) {
          /* audio fetch failed — still archive the MIDI below */
        }
      }
      const r = await saveSong({
        title: job.name,
        noteCount: events ? events.notes.length : job.noteCount,
        pedalCount: events ? events.pedals.length : job.pedalCount,
        settings: settings,
        midiBase64: b64
      }, mp3Blob)
      if (mp3Blob && !r.mp3Uploaded) {
        alert('Saved the MIDI, but the source audio upload failed: ' +
          (r.mp3Error || 'unknown error') +
          '\nThe song is in the library without its MP3.')
      }
      // Saved: hand the job off to App, which drops it from the Convert tab.
      if (onArchived) onArchived(job.id)
    } catch (e) {
      alert('Save failed: ' + e.message)
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <h3>{job.name} — preview & export</h3>

      {job.fromLibrary && (
        <div className="notice">
          Imported from the library — <strong>MIDI only</strong> (the
          accompaniment was dropped when archived). Use <strong>▶ Play piano
          (synth)</strong> below to hear the notes and A/B the sustain cap, edit
          or cap them, then re-export the .mid / E-SEQ / USB.
        </div>
      )}

      <div className="players">
        {job.pianoStem && (
          <div className="player">
            <label>Extracted piano stem (what the transcription heard)</label>
            <audio ref={stemRef} controls
              src={audioUrl(job.id, 'piano') + '?v=' + audioVer} />
          </div>
        )}
        {job.accompaniment ? (
          <div className="player">
            <label>Accompaniment, piano removed (plays through ENSPIRE speakers)</label>
            <audio ref={accompRef} controls
              src={audioUrl(job.id, 'accompaniment') + '?v=' + audioVer} />
          </div>
        ) : (!job.fromLibrary && (
          <div className="player">
            <label>Original MP3 (re-convert to get a piano-less accompaniment)</label>
            <audio controls src={audioUrl(job.id, 'original')} />
          </div>
        ))}
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

      {!job.accompaniment && (
        <div className="actions" style={{ marginTop: 10 }}>
          <button className={previewing ? 'ghost' : 'primary'} onClick={playPiano}
            disabled={!events}>
            {previewing ? '■ Stop' : '▶ Play piano (synth)'}
          </button>
          <span className="meta" style={{ alignSelf: 'center' }}>
            No accompaniment — plays the notes alone through the synth using the
            current settings. Toggle the sustain cap / release and replay to hear
            before vs after. Drag the playhead first to start mid-song.
          </span>
        </div>
      )}

      {events
        ? <NoteEditor events={events} onChange={handleEdit}
            onSave={handleSaveEdits} onReset={handleResetEvents}
            dirty={dirty} saving={savingEdits} playheadSec={playhead}
            onSeek={handleSeek}
            trimStart={trimStart} trimEnd={trimEnd}
            onApplyTrim={handleApplyTrim} trimming={trimming}
            hasAccompaniment={!!job.accompaniment}
            onPlay={job.accompaniment ? playBoth : playPiano}
            onRestart={handleRestart} previewing={previewing} />
        : <div className="meta">Loading note data…</div>}

      {dirty && (
        <div className="notice warn">
          Unsaved edits — the downloads and USB save below still use the last
          saved version. Hit <strong>Save edits</strong> in the editor first.
        </div>
      )}

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
          <label>Note release — <span className="val">{settings.releaseMs} ms</span></label>
          <input type="range" min="0" max="400" step="10" value={settings.releaseMs}
            onChange={function (e) { set('releaseMs', Number(e.target.value)) }} />
          <div className="hint">
            Trims the tail off every note so keys don't stay depressed too long
            (the transcriber marks note-off at full decay, not finger-lift). 0 =
            as transcribed. Raise for tighter, more staccato playing; if notes
            start cutting off unnaturally, back it down or turn sustain pedal on.
          </div>
        </div>
        <div className="control">
          <div className="check">
            <input id="capSustain" type="checkbox" checked={settings.capSustain}
              onChange={function (e) { set('capSustain', e.target.checked) }} />
            <label htmlFor="capSustain" style={{ margin: 0 }}>
              Cap over-long notes to physical piano sustain
            </label>
          </div>
          <div className="hint">
            Clamps any note the transcriber marked longer than a real string
            could ring — bass ~30s down to ~1s in the top octave. Removes
            stuck-key artifacts without shortening genuine held notes. Leave on
            unless you want the raw, uncapped durations.
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
        <a href={eseqUrl(job.id, settings)}>
          <button className="ghost">⬇ E-SEQ .FIL (floppy Disklavier)</button>
        </a>
        <a href={hfeUrl(job.id, settings)}>
          <button className="ghost">⬇ Gotek floppy image (.hfe)</button>
        </a>
        {usb && usb.found && (
          <button className="primary" onClick={handleUsbSave} disabled={usbSaving}>
            {usbSaving
              ? 'Writing to USB…'
              : '💾 Save to piano USB (slot ' +
                (usbResult ? 'saved: ' + usbResult.slot : usb.nextFreeSlot) + ')'}
          </button>
        )}
        {firebaseReady && (
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Moving…' : '☁ Move to library'}
          </button>
        )}
      </div>

      <div className="actions" style={{ marginTop: 10 }}>
        <button className="ghost" onClick={function () {
          saveAsDialog(midiUrl(job.id, settings), job.name + '.mid',
            'MIDI file', 'audio/midi', '.mid')
        }}>
          💾 Save .mid as…
        </button>
        {job.accompaniment && (
          <button className="ghost" onClick={function () {
            saveAsDialog(audioUrl(job.id, 'accompaniment'),
              job.name + ' (no piano).mp3', 'MP3 audio', 'audio/mpeg', '.mp3')
          }}>
            💾 Save .mp3 as…
          </button>
        )}
        {drives.length > 1 && (
          <select value={selDrive ? selDrive.root : ''}
            onChange={function (e) { setDriveSel(e.target.value) }}>
            {drives.map(function (d) {
              return (
                <option key={d.root} value={d.root}>
                  {d.root + ' — ' + d.label}
                </option>
              )
            })}
          </select>
        )}
        {selDrive ? (
          <button className="ghost" disabled={exporting}
            onClick={function () { handleExportHfe(selDrive.root) }}>
            {exporting
              ? 'Writing…'
              : '💾 .hfe → ' + selDrive.root + ' (' + selDrive.label + ')'}
          </button>
        ) : (
          <span className="meta" style={{ alignSelf: 'center' }}>
            No USB drive detected — plug one in and save buttons appear here.
          </span>
        )}
      </div>

      {usbResult && (
        <div className="notice" style={{ borderColor: 'var(--green)' }}>
          ✓ Written to <strong>{usbResult.filename}</strong> on {usbResult.drive} —
          fully flushed to the stick, safe to unplug now.
          <br />
          The Nalbantov scans the stick <strong>at power-on</strong>: after adding
          a new disk, move the stick to the piano and <strong>power-cycle the
          emulator/piano</strong> so it re-indexes, then select disk{' '}
          <strong>{usbResult.slot}</strong> and press play. A freshly added slot
          won't appear until that re-scan.
        </div>
      )}

      {exportResult && (
        <div className="notice" style={{ borderColor: 'var(--green)' }}>
          ✓ Saved <strong>{exportResult.filename}</strong>
          {exportResult.path ? ' to ' + exportResult.path : ''}
        </div>
      )}

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
