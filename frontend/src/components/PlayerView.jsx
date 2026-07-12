// Watch the source video (TV over HDMI) while the Disklavier plays the
// transcription live over USB-MIDI. The <video> element is the master clock;
// videoMidiPlayer schedules the notes against it, so pause/seek/speed all
// keep picture and piano locked.

import { useEffect, useRef, useState } from 'react'
import {
  getEvents, decodeMidi, saveJobSettings, jobVideoUrl, mediaVideoUrl
} from '../api.js'
import { createMidiOut } from '../midiOut.js'
import { prepareEvents, createVideoMidiPlayer } from '../videoMidiPlayer.js'

const DEFAULTS = {
  velMin: 20, velMax: 112, gamma: 1.0, offsetMs: 0, pedal: true,
  releaseMs: 0, capSustain: true
}

const LS = {
  sync: 'pf_default_sync_ms',
  pedal: 'pf_default_pedal_ms',
  vol: 'pf_video_volume',
  vel: 'pf_vel_scale'
}

function lsNum(key, fallback) {
  const v = parseFloat(localStorage.getItem(key))
  return Number.isFinite(v) ? v : fallback
}

function fmt(sec) {
  if (!Number.isFinite(sec)) return '0:00'
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return m + ':' + String(s % 60).padStart(2, '0')
}

export default function PlayerView({ jobs, initial }) {
  const doneJobs = jobs.filter(function (j) { return j.status === 'done' })
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs

  // song selection: 'job:<id>' from the Convert list, 'lib' = library song
  // handed in via the Watch button
  const [sel, setSel] = useState(function () {
    return initial && initial.jobId ? 'job:' + initial.jobId : ''
  })
  const [libSong, setLibSong] = useState(
    initial && initial.libSong ? initial.libSong : null)
  const [perf, setPerf] = useState(null)       // prepared note/pedal events
  const [songJob, setSongJob] = useState(null) // backing job when sel=job:*
  const [loadErr, setLoadErr] = useState(null)

  // video
  const [videoUrl, setVideoUrl] = useState(null)
  const [videoName, setVideoName] = useState('')
  // true when the loaded video's audio is the piano-removed backing track —
  // don't mute it (that IS the accompaniment for the room)
  const [bgVideo, setBgVideo] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(function () { return lsNum(LS.vol, 1) })
  const [isFs, setIsFs] = useState(false)
  const [fsIdle, setFsIdle] = useState(false)

  // piano
  const [syncMs, setSyncMs] = useState(function () { return lsNum(LS.sync, 0) })
  const [pedalMs, setPedalMs] = useState(function () { return lsNum(LS.pedal, 0) })
  const [velScale, setVelScale] = useState(function () { return lsNum(LS.vel, 1) })
  const [pedalOn, setPedalOn] = useState(true)
  const [notesSent, setNotesSent] = useState(0)
  const [saveMsg, setSaveMsg] = useState(null)
  const [, setMidiTick] = useState(0) // re-render on device hot-plug

  // sync aids
  const [tapArmed, setTapArmed] = useState(false)
  const [tapMsg, setTapMsg] = useState(null)
  const tapsRef = useRef([])
  const tapNowRef = useRef(null)
  const [loop, setLoop] = useState(null) // {a, b} video-time loop window

  const videoRef = useRef(null)
  const stageRef = useRef(null)
  const fileRef = useRef(null)
  const playerRef = useRef(null)
  const idleTimer = useRef(null)
  const midiRef = useRef(null)
  if (!midiRef.current) {
    midiRef.current = createMidiOut(function () {
      setMidiTick(function (t) { return t + 1 })
    })
  }
  const midi = midiRef.current

  useEffect(function () { midi.init() }, [])

  // Entry buttons elsewhere in the app can retarget an already-open player.
  useEffect(function () {
    if (initial && initial.jobId) {
      setLibSong(null)
      setSel('job:' + initial.jobId)
    } else if (initial && initial.libSong) {
      setLibSong(initial.libSong)
      setSel('lib')
    }
  }, [initial])

  // Load + prepare the selected song's events; auto-load its saved video.
  useEffect(function () {
    let dead = false
    setPerf(null)
    setSongJob(null)
    setLoadErr(null)
    setNotesSent(0)
    setLoop(null)
    tapsRef.current = []
    setTapArmed(false)
    setTapMsg(null)
    async function load() {
      if (sel.indexOf('job:') === 0) {
        const id = sel.slice(4)
        const job = jobsRef.current.find(function (j) { return j.id === id })
        if (!job) throw new Error('song no longer in the Convert list')
        const ev = await getEvents(id)
        const st = { ...DEFAULTS, ...(job.settings || {}) }
        const p = prepareEvents(ev, st, false, job.srcStartSec || 0)
        if (dead) return
        setPerf(p)
        setSongJob(job)
        setSyncMs(st.videoSyncMs != null ? st.videoSyncMs : lsNum(LS.sync, 0))
        setPedalMs(st.pedalLagMs != null ? st.pedalLagMs : lsNum(LS.pedal, 0))
        // Conversion kept its video (URL fetch with "include video" or an
        // uploaded video file): load it straight away, no picking. When the
        // pipeline swapped in the piano-removed backing track, note that so
        // its audio stays on.
        if (job.videoFile) {
          const isBg = job.videoFile === 'video_bg.mp4'
          setVideoSrc(jobVideoUrl(id),
            isBg ? '🎵 backing track (piano removed)'
              : '🎞 saved with this conversion',
            isBg)
        }
      } else if (sel === 'lib' && libSong) {
        const ev = await decodeMidi(libSong.midiBase64)
        // Library MIDI is a baked render: velocities mapped, release/cap
        // applied. Play it verbatim.
        const p = prepareEvents(ev, { releaseMs: 0, capSustain: false }, true, 0)
        if (dead) return
        setPerf(p)
        setSyncMs(lsNum(LS.sync, 0))
        setPedalMs(lsNum(LS.pedal, 0))
        if (libSong.localVideo) {
          const isBg = Boolean(libSong.videoIsBacking)
          setVideoSrc(mediaVideoUrl(libSong.localVideo),
            isBg ? '🎵 backing track (piano removed)' : '🎞 ' + libSong.localVideo,
            isBg)
        }
      }
    }
    if (sel) {
      load().catch(function (e) { if (!dead) setLoadErr(e.message || String(e)) })
    }
    return function () { dead = true }
  }, [sel, libSong])

  // Bind the scheduler once both the song and a video are loaded.
  useEffect(function () {
    const v = videoRef.current
    if (!v || !perf || !videoUrl) return
    const player = createVideoMidiPlayer(v, midi, perf, {
      syncMs: syncMs, pedalMs: pedalMs, velScale: velScale, pedalOn: pedalOn
    })
    player.setActivityCallback(setNotesSent)
    player.attach()
    playerRef.current = player
    return function () {
      player.detach()
      playerRef.current = null
    }
    // sync/pedal/vel/pedalOn reach the live player through setters below
  }, [perf, videoUrl])

  // Live parameter pushes.
  useEffect(function () {
    if (playerRef.current) playerRef.current.setSyncMs(syncMs)
  }, [syncMs])
  useEffect(function () {
    if (playerRef.current) playerRef.current.setPedalLagMs(pedalMs)
  }, [pedalMs])
  useEffect(function () {
    if (playerRef.current) playerRef.current.setVelScale(velScale)
    localStorage.setItem(LS.vel, String(velScale))
  }, [velScale])
  useEffect(function () {
    if (playerRef.current) playerRef.current.setPedalOn(pedalOn)
  }, [pedalOn])
  useEffect(function () {
    const v = videoRef.current
    if (v) { v.volume = volume; v.muted = muted }
    localStorage.setItem(LS.vol, String(volume))
  }, [volume, muted, videoUrl])
  useEffect(function () {
    const v = videoRef.current
    if (v) v.playbackRate = speed
  }, [speed, videoUrl])

  useEffect(function () {
    function onFs() {
      setIsFs(Boolean(document.fullscreenElement))
      setFsIdle(false)
    }
    document.addEventListener('fullscreenchange', onFs)
    return function () { document.removeEventListener('fullscreenchange', onFs) }
  }, [])

  // objectURL housekeeping (backend-streamed videos are plain http URLs)
  useEffect(function () {
    return function () {
      if (videoUrl && videoUrl.indexOf('blob:') === 0) {
        URL.revokeObjectURL(videoUrl)
      }
    }
  }, [videoUrl])

  // (the effect above revokes the previous blob: URL on change)
  function setVideoSrc(url, name, isBg) {
    setVideoUrl(url)
    setVideoName(name)
    setBgVideo(Boolean(isBg))
    // Backing-track videos: their audio is the accompaniment for the room,
    // so start unmuted. Other videos still carry the recording's own piano —
    // start muted so it doesn't double the Disklavier.
    setMuted(!isBg)
    setTime(0)
    setDuration(0)
    setLoop(null)
  }

  function pickVideo(file) {
    if (!file) return
    setVideoSrc(URL.createObjectURL(file), file.name, false)
  }

  function togglePlay() {
    const v = videoRef.current
    if (!v || !videoUrl) return
    if (v.paused) v.play()
    else v.pause()
  }

  function seekBy(delta) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta))
  }

  function nudge(ms) {
    setSyncMs(function (s) { return Math.round(s + ms) })
    setSaveMsg(null)
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen()
    else if (stageRef.current) stageRef.current.requestFullscreen()
  }

  // --- Tap sync: press T on clear beats while watching; each tap is matched
  // to the nearest scheduled note and the median difference becomes the
  // offset correction. No scrubbing, no guesswork.
  function tapMedianMs() {
    const t = tapsRef.current
    if (!t.length) return 0
    const s = t.slice().sort(function (a, b) { return a - b })
    return Math.round(s[Math.floor(s.length / 2)] * 1000)
  }

  function tapNow() {
    const v = videoRef.current
    if (!v || !perf || v.paused) return
    const vt = v.currentTime
    const syncSec = syncMs / 1000
    let best = null
    for (let i = 0; i < perf.notes.length; i++) {
      const te = perf.notes[i].tOn + syncSec
      if (te > vt + 0.6) break
      if (te >= vt - 0.6) {
        const d = vt - te
        if (best === null || Math.abs(d) < Math.abs(best)) best = d
      }
    }
    if (best === null) {
      setTapMsg('No note near that tap — tap right on a clear beat.')
      return
    }
    tapsRef.current.push(best)
    const n = tapsRef.current.length
    if (n >= 4) {
      const med = tapMedianMs()
      setTapMsg(n + ' taps · piano looks ' + Math.abs(med) + ' ms ' +
        (med >= 0 ? 'early' : 'late') + ' — Apply shifts it ' +
        (med >= 0 ? '+' : '') + med + ' ms')
    } else {
      setTapMsg(n + ' tap' + (n > 1 ? 's' : '') + ' — ' + (4 - n) +
        ' more on clear beats…')
    }
  }
  tapNowRef.current = tapNow

  function toggleTapSync() {
    if (tapArmed) {
      setTapArmed(false)
      setTapMsg(null)
      tapsRef.current = []
      return
    }
    tapsRef.current = []
    setTapArmed(true)
    setTapMsg('Play the video and press T (or the TAP button) each time a ' +
      'clear beat lands.')
  }

  function applyTapSync() {
    if (tapsRef.current.length < 4) return
    const med = tapMedianMs()
    setSyncMs(function (m) { return Math.round(m + med) })
    tapsRef.current = []
    setTapArmed(false)
    setTapMsg('Applied ' + (med >= 0 ? '+' : '') + med +
      ' ms — fine-tune with , and . if needed.')
    setSaveMsg(null)
  }

  // --- Sync loop: jump to the busiest 6 seconds of the song and loop them,
  // so the offset can be dialed in without hunting through the video.
  function toggleLoop() {
    if (loop) { setLoop(null); return }
    const v = videoRef.current
    if (!v || !perf || !perf.notes.length) return
    const syncSec = syncMs / 1000
    let bestStart = perf.notes[0].tOn + syncSec
    let bestCount = 0
    let j = 0
    for (let i = 0; i < perf.notes.length; i++) {
      while (perf.notes[i].tOn - perf.notes[j].tOn > 6) j++
      if (i - j + 1 > bestCount) {
        bestCount = i - j + 1
        bestStart = perf.notes[j].tOn + syncSec
      }
    }
    let a = Math.max(0, bestStart - 0.5)
    // shorter video than the transcription (or busiest bars near the end):
    // keep the loop window inside what's actually watchable
    if (Number.isFinite(v.duration) && a > v.duration - 8) {
      a = Math.max(0, v.duration - 8)
    }
    setLoop({ a: a, b: a + 7 })
    v.currentTime = a
    v.play()
  }

  // In fullscreen the transport bar hides after a moment of stillness.
  function stageMouseMove() {
    if (!isFs) return
    setFsIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(function () { setFsIdle(true) }, 2500)
  }

  // Keyboard transport — skipped while typing in a field.
  useEffect(function () {
    function onKey(e) {
      const tag = (e.target.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'select' || tag === 'textarea' ||
          tag === 'button') return
      if (e.code === 'Space') { e.preventDefault(); togglePlay() }
      else if (e.key === 'ArrowLeft') seekBy(-5)
      else if (e.key === 'ArrowRight') seekBy(5)
      else if (e.key === ',') nudge(-10)
      else if (e.key === '.') nudge(10)
      else if (e.key === 'm') setMuted(function (m) { return !m })
      else if (e.key === 'f') toggleFullscreen()
      else if (e.key === 't' || e.key === 'T') {
        if (tapNowRef.current) tapNowRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return function () { window.removeEventListener('keydown', onKey) }
  }, [videoUrl, isFs])

  async function handleSaveSync() {
    if (!songJob) return
    try {
      const merged = {
        ...DEFAULTS, ...(songJob.settings || {}),
        videoSyncMs: Math.round(syncMs), pedalLagMs: Math.round(pedalMs)
      }
      await saveJobSettings(songJob.id, merged)
      setSaveMsg('Saved for this song')
    } catch (e) {
      setSaveMsg('Save failed: ' + e.message)
    }
  }

  function handleSaveDefault() {
    localStorage.setItem(LS.sync, String(Math.round(syncMs)))
    localStorage.setItem(LS.pedal, String(Math.round(pedalMs)))
    setSaveMsg('Saved as default for new songs')
  }

  const outputs = midi.outputs()
  const songLabel = sel === 'lib' && libSong ? libSong.title
    : songJob ? songJob.name : ''
  const ready = Boolean(perf && videoUrl)

  return (
    <div className="player">
      {midi.error && <div className="notice warn">{midi.error}</div>}
      {!midi.error && !midi.connected && (
        <div className="notice warn">
          No MIDI output found. Connect the computer to the piano's
          <strong> USB TO HOST</strong> port (USB-B, on the box under the
          piano), then plug/replug — the device appears automatically.
        </div>
      )}
      {loadErr && <div className="notice warn">Could not load song: {loadErr}</div>}

      <div className="player-top">
        <select
          value={sel}
          onChange={function (e) { setSel(e.target.value); setSaveMsg(null) }}
        >
          <option value="">🎵 Choose a song…</option>
          {sel === 'lib' && libSong && (
            <option value="lib">☁ {libSong.title}</option>
          )}
          {doneJobs.map(function (j) {
            return <option key={j.id} value={'job:' + j.id}>{j.name}</option>
          })}
        </select>

        <button onClick={function () { fileRef.current.click() }}>
          🎬 {videoName ? videoName : 'Choose video file…'}
        </button>
        <input
          ref={fileRef} type="file" accept="video/*" style={{ display: 'none' }}
          onChange={function (e) { pickVideo(e.target.files[0]) }}
        />

        <span className={'midi-dot' + (midi.connected ? ' on' : '')}
          title={midi.connected ? midi.deviceName : 'no MIDI device'} />
        <select
          value={midi.deviceId || ''}
          onChange={function (e) { midi.select(e.target.value) }}
          disabled={outputs.length === 0}
        >
          {outputs.length === 0 && <option value="">no MIDI device</option>}
          {outputs.map(function (o) {
            return <option key={o.id} value={o.id}>{o.name}</option>
          })}
        </select>
        {perf && (
          <span className="meta">
            {perf.notes.length} notes · {perf.pedals.length} pedal
            {notesSent > 0 ? ' · sent ' + notesSent : ''}
          </span>
        )}
      </div>

      <div
        ref={stageRef}
        className={'player-stage' + (isFs && fsIdle ? ' idle' : '')}
        onMouseMove={stageMouseMove}
        onDragOver={function (e) { e.preventDefault() }}
        onDrop={function (e) {
          e.preventDefault()
          const f = e.dataTransfer.files && e.dataTransfer.files[0]
          if (f && f.type.indexOf('video') === 0) pickVideo(f)
        }}
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            onClick={togglePlay}
            onDoubleClick={toggleFullscreen}
            onTimeUpdate={function (e) {
              const t = e.target.currentTime
              setTime(t)
              if (loop && t > loop.b) e.target.currentTime = loop.a
            }}
            onLoadedMetadata={function (e) { setDuration(e.target.duration) }}
            onPlay={function () { setPlaying(true) }}
            onPause={function () { setPlaying(false) }}
            onEnded={function () { setPlaying(false) }}
          />
        ) : (
          <div className="player-drop" onClick={function () { fileRef.current.click() }}>
            <div>🎬</div>
            <div>Drop the song's video here (mp4), or click to browse</div>
            <div className="meta">
              Use the same video the song was transcribed from — then picture
              and piano line up out of the box.
            </div>
          </div>
        )}

        <div className="player-bar">
          <button className="primary" disabled={!ready} onClick={togglePlay}>
            {playing ? '⏸' : '▶'}
          </button>
          <button disabled={!ready} onClick={function () { seekBy(-5) }}>⏪ 5s</button>
          <button disabled={!ready} onClick={function () { seekBy(5) }}>5s ⏩</button>
          <span className="player-time">{fmt(time)} / {fmt(duration)}</span>
          <input
            className="player-seek" type="range" min="0" step="0.1"
            max={duration || 0} value={time} disabled={!ready}
            onChange={function (e) {
              const v = videoRef.current
              if (v) v.currentTime = parseFloat(e.target.value)
            }}
          />
          <select value={speed}
            onChange={function (e) { setSpeed(parseFloat(e.target.value)) }}>
            <option value="0.5">0.5×</option>
            <option value="0.75">0.75×</option>
            <option value="0.9">0.9×</option>
            <option value="1">1×</option>
          </select>
          <button onClick={function () { setMuted(!muted) }} title="Video sound (m)">
            {muted ? '🔇' : '🔊'}
          </button>
          <button onClick={toggleFullscreen} title="Fullscreen (f)">⛶</button>
          {tapArmed && (
            <button className="primary tap-btn"
              onClick={function () { if (tapNowRef.current) tapNowRef.current() }}>
              👏 TAP (T)
            </button>
          )}
        </div>
      </div>

      <div className="player-controls">
        <div className="player-group">
          <label>
            Piano timing <strong>{Math.round(syncMs)} ms</strong>
            <span className="meta"> (− earlier · + later)</span>
          </label>
          <div className="row">
            <button onClick={function () { nudge(-50) }}>−50</button>
            <button onClick={function () { nudge(-10) }}>−10</button>
            <input
              type="range" min="-2000" max="2000" step="10" value={syncMs}
              onChange={function (e) { setSyncMs(parseFloat(e.target.value)); setSaveMsg(null) }}
            />
            <button onClick={function () { nudge(10) }}>+10</button>
            <button onClick={function () { nudge(50) }}>+50</button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className={tapArmed ? 'primary' : ''} disabled={!ready}
              title="Tap the T key on clear beats while watching — the app measures the offset for you"
              onClick={toggleTapSync}>
              {tapArmed ? '✕ Cancel tap sync' : '👏 Tap sync'}
            </button>
            {tapArmed && (
              <button className="primary"
                disabled={tapsRef.current.length < 4}
                onClick={applyTapSync}>
                ✓ Apply{tapsRef.current.length >= 4
                  ? ' ' + (tapMedianMs() >= 0 ? '+' : '') + tapMedianMs() + ' ms'
                  : ''}
              </button>
            )}
            <button disabled={!ready}
              title="Jump to the busiest bars and loop them while you dial in the timing"
              onClick={toggleLoop}>
              {loop ? '⏹ Stop loop' : '🎯 Loop busiest part'}
            </button>
          </div>
          {tapMsg && <div className="meta">{tapMsg}</div>}
          {!tapMsg && (
            <div className="meta">Nudge live with , and . keys while watching.</div>
          )}
        </div>

        <div className="player-group">
          <label>
            Pedal timing <strong>{Math.round(pedalMs)} ms</strong>
            <span className="meta"> (extra, on top of piano timing)</span>
          </label>
          <div className="row">
            <input
              type="range" min="-500" max="500" step="5" value={pedalMs}
              onChange={function (e) { setPedalMs(parseFloat(e.target.value)); setSaveMsg(null) }}
            />
            <label className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={pedalOn}
                onChange={function (e) { setPedalOn(e.target.checked) }} />
              pedal on
            </label>
          </div>
          <div className="meta">
            The sustain solenoid reacts slower than the keys — pull this
            negative if pedal changes land late.
          </div>
        </div>

        <div className="player-group">
          <label>
            Piano loudness <strong>{Math.round(velScale * 100)}%</strong>
          </label>
          <div className="row">
            <input
              type="range" min="0.5" max="1.5" step="0.05" value={velScale}
              onChange={function (e) { setVelScale(parseFloat(e.target.value)) }}
            />
          </div>
          <label style={{ marginTop: 8 }}>
            Video volume <strong>{Math.round(volume * 100)}%</strong>
          </label>
          <div className="row">
            <input
              type="range" min="0" max="1" step="0.05" value={volume}
              onChange={function (e) { setVolume(parseFloat(e.target.value)) }}
            />
          </div>
          <div className="meta">
            {bgVideo
              ? 'This video\'s audio is the backing track (piano removed) — '
                + 'leave it on; the Disklavier adds the piano.'
              : 'The real piano is the sound — mute the video (m) if hearing '
                + 'the recording\'s piano doubles it.'}
          </div>
        </div>

        <div className="player-group">
          <label>Piano checks</label>
          <div className="row">
            <button disabled={!midi.connected} onClick={function () { midi.testNote() }}>
              🎹 Test note
            </button>
            <button disabled={!midi.connected} onClick={function () { midi.testPedal() }}>
              🦶 Test pedal
            </button>
            <button className="danger" disabled={!midi.connected}
              onClick={function () {
                if (playerRef.current) playerRef.current.panic()
                else midi.panic()
              }}>
              ⏹ Stop all notes
            </button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button disabled={!songJob} onClick={handleSaveSync}
              title={songJob ? 'Remember these offsets for this song'
                : 'Library songs: use the default instead'}>
              💾 Save timing for “{songLabel || 'song'}”
            </button>
            <button onClick={handleSaveDefault}
              title="New songs start with these offsets">
              ⭐ Use as default
            </button>
          </div>
          {saveMsg && <div className="meta">{saveMsg}</div>}
        </div>
      </div>

      <div className="meta player-help">
        Space play/pause · ←/→ skip 5s · , / . nudge piano ±10 ms · t tap sync ·
        m mute video · f fullscreen. HDMI the laptop to the TV, USB to the
        piano's USB TO HOST port, press play. To sync fast: 👏 Tap sync (tap T
        on 4+ beats, apply), then 🎯 loop the busiest part and nudge until the
        hammers match the hands.
      </div>
    </div>
  )
}
