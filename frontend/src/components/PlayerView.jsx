// Watch the source video (TV over HDMI) while the Disklavier plays the
// transcription live over USB-MIDI. The <video> element is the master clock;
// videoMidiPlayer schedules the notes against it, so pause/seek/speed all
// keep picture and piano locked.

import { useEffect, useRef, useState } from 'react'
import {
  getEvents, decodeMidi, saveJobSettings, jobVideoUrl, mediaVideoUrl,
  autoSyncJob, autoSyncMedia
} from '../api.js'
import { createMidiOut } from '../midiOut.js'
import { createMockMidiOut, mockMidiEnabled } from '../devMockMidi.js'
import { updateSongSettings } from '../firebase.js'
import { localMp3Bytes } from '../localLibrary.js'
import { loadCalibration, saveCalibration, effectiveCalibration } from '../calibrate.js'
import { createLiveSyncMonitor } from '../liveSync.js'
import CalibrationWizard from './CalibrationWizard.jsx'
import VisualTest from './VisualTest.jsx'
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

// Sync is two numbers added together:
//  * align — per song, automatic: how far the MIDI must move to sit on the
//    video's own timeline (backend auto_sync; exact audio match when the
//    song's source audio or accompaniment exists). Measured once and saved.
//  * trim — the room: TV/HDMI delay and piano feel left over after
//    calibration. Same for every song (⭐ Use as default), or saved per song.
// The player gets align + trim.
const MIN_AUTO_CONF = 0.5

// Local (customer) library songs can't take a settings write, so their sync
// lives here, keyed by song id.
function readLocalSync(id) {
  try { return JSON.parse(localStorage.getItem('pf_lib_sync_' + id) || 'null') } catch (e) { return null }
}
function writeLocalSync(id, patch) {
  try {
    const next = { ...(readLocalSync(id) || {}), ...patch }
    localStorage.setItem('pf_lib_sync_' + id, JSON.stringify(next))
  } catch (e) { /* storage full / blocked: re-measures next time */ }
}

// The library list is big (every song's MIDI); keep one copy across tab
// switches instead of refetching on every visit.
let libCache = null
const LIB_CACHE_MS = 5 * 60 * 1000

function fmt(sec) {
  if (!Number.isFinite(sec)) return '0:00'
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return m + ':' + String(s % 60).padStart(2, '0')
}

export default function PlayerView({ jobs, initial, loadLibrary, isFamily }) {
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
  const libSongRef = useRef(libSong)
  libSongRef.current = libSong
  // every library song, for the song picker (null until loaded)
  const [libList, setLibList] = useState(null)
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

  // piano — see the align/trim note at the top of the file
  const [trimMs, setTrimMs] = useState(function () { return lsNum(LS.sync, 0) })
  const [alignMs, setAlignMs] = useState(0)
  // {state: 'measuring'|'ok'|'low'|'failed'|'manual', ms, conf, method, msg}
  const [alignInfo, setAlignInfo] = useState(null)
  const alignReqRef = useRef(0) // drops a measurement that finishes after the song changed
  const syncMs = alignMs + trimMs
  const [pedalMs, setPedalMs] = useState(function () { return lsNum(LS.pedal, 0) })
  const [velScale, setVelScale] = useState(function () { return lsNum(LS.vel, 1) })
  const [pedalOn, setPedalOn] = useState(true)
  const [notesSent, setNotesSent] = useState(0)
  const [saveMsg, setSaveMsg] = useState(null)
  const [, setMidiTick] = useState(0) // re-render on device hot-plug

  // sync aids
  const [tapArmed, setTapArmed] = useState(false)
  const [tapMsg, setTapMsg] = useState(null)
  const autoSyncBusy = Boolean(alignInfo && alignInfo.state === 'measuring')
  // hardware calibration (velocity->latency curve + TV latency), persisted in
  // localStorage; applied to every scheduler so notes fire early by the right
  // per-note amount.
  const [calibration, setCalibration] = useState(function () { return loadCalibration() })
  const [showCalibrate, setShowCalibrate] = useState(false)
  const [showVisual, setShowVisual] = useState(false)
  // live closed-loop residual (only populated if the piano echoes its sensors
  // during playback); {medianErr, matches, samples}
  const [liveSyncInfo, setLiveSyncInfo] = useState(null)
  const liveMonitorRef = useRef(null)
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
    const onMidiChange = function () { setMidiTick(function (t) { return t + 1 }) }
    // ?mockmidi (or window.__PF_MOCK_MIDI) swaps in a hardware-free simulator so
    // the sync UI can be exercised without a piano. No-op in normal use.
    midiRef.current = mockMidiEnabled()
      ? createMockMidiOut(onMidiChange)
      : createMidiOut(onMidiChange)
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

  // Library list for the song picker (family: cloud library; customers: the
  // on-device one). Cached across tab switches; refreshed when stale.
  useEffect(function () {
    if (!loadLibrary) return
    const fam = Boolean(isFamily)
    if (libCache && libCache.family === fam && Date.now() - libCache.at < LIB_CACHE_MS) {
      setLibList(libCache.list)
      return
    }
    let dead = false
    Promise.resolve(loadLibrary()).then(function (list) {
      const songs = (list || []).filter(function (s) { return s && s.midiBase64 })
      songs.sort(function (a, b) { return (a.title || '').localeCompare(b.title || '') })
      libCache = { at: Date.now(), list: songs, family: fam }
      if (!dead) setLibList(songs)
    }).catch(function () { /* picker just lists Convert songs */ })
    return function () { dead = true }
  }, [loadLibrary, isFamily])

  // Settings for a library song, with the local per-song overrides customers'
  // on-device songs keep in localStorage.
  function libSettings(song) {
    const st = { ...(song.settings || {}) }
    if (!isFamily) Object.assign(st, readLocalSync(song.id) || {})
    return st
  }

  function applyAlign(r) {
    if (r && r.confidence >= MIN_AUTO_CONF) {
      const ms = Math.round(r.offsetMs)
      setAlignMs(ms)
      setAlignInfo({ state: 'ok', ms: ms, conf: r.confidence, method: r.method })
      return true
    }
    setAlignMs(0)
    setAlignInfo({ state: 'low', conf: r ? r.confidence : 0, method: r && r.method })
    return false
  }

  async function measureJob(id, force, req) {
    setAlignInfo({ state: 'measuring' })
    try {
      const r = await autoSyncJob(id, force)
      if (req === alignReqRef.current) applyAlign(r) // backend saved it on the job
    } catch (e) {
      if (req === alignReqRef.current) setAlignInfo({ state: 'failed', msg: e.message })
    }
  }

  async function measureLib(song, req) {
    setAlignInfo({ state: 'measuring' })
    try {
      const st = libSettings(song)
      // The accompaniment is the same audio as a backing-track video, on the
      // MIDI's own timeline: with it the match is exact.
      let audioBlob = null
      try {
        if (song.mp3Url) {
          const res = await fetch(song.mp3Url)
          if (res.ok) audioBlob = await res.blob()
        } else if (song.hasMp3) {
          const bytes = await localMp3Bytes(song.id)
          if (bytes) audioBlob = new Blob([bytes], { type: 'audio/mpeg' })
        }
      } catch (e) { /* note match only */ }
      const r = await autoSyncMedia({
        filename: song.localVideo,
        midiBase64: song.midiBase64,
        offsetMs: st.offsetMs || 0,
        startSec: st.videoStartSec || 0,
        // songs moved before videoStartSec existed can be seconds off
        searchSec: st.videoStartSec != null ? 3 : 20,
        audioBlob: audioBlob
      })
      if (req !== alignReqRef.current) return
      if (applyAlign(r)) saveLibSync(song, { videoAlignMs: Math.round(r.offsetMs) })
    } catch (e) {
      if (req === alignReqRef.current) setAlignInfo({ state: 'failed', msg: e.message })
    }
  }

  // Persist sync keys on a library song without reloading it.
  async function saveLibSync(song, patch) {
    if (!isFamily) {
      writeLocalSync(song.id, patch)
      return
    }
    const settings = await updateSongSettings(song.id, song.settings, patch)
    if (libSongRef.current && libSongRef.current.id === song.id) {
      setLibSong(function (s) { return s ? { ...s, settings: settings } : s })
    }
    if (libCache) {
      libCache.list = libCache.list.map(function (s) {
        return s.id === song.id ? { ...s, settings: settings } : s
      })
    }
    return settings
  }

  // Load + prepare the selected song's events; auto-load its saved video and
  // line it up with the video automatically.
  const libKey = libSong ? libSong.id : null
  useEffect(function () {
    let dead = false
    const req = ++alignReqRef.current
    setPerf(null)
    setSongJob(null)
    setLoadErr(null)
    setNotesSent(0)
    setLoop(null)
    tapsRef.current = []
    setTapArmed(false)
    setTapMsg(null)
    setAlignMs(0)
    setAlignInfo(null)
    // A song saved by hand before auto-align existed keeps its one number as
    // the whole offset (it already included the alignment).
    function startTrim(st) {
      const legacy = st.videoSyncMs != null && st.videoTrimMs == null &&
        st.videoAlignMs == null
      setTrimMs(st.videoTrimMs != null ? st.videoTrimMs
        : legacy ? st.videoSyncMs : lsNum(LS.sync, 0))
      setPedalMs(st.pedalLagMs != null ? st.pedalLagMs : lsNum(LS.pedal, 0))
      if (legacy) setAlignInfo({ state: 'manual' })
      return legacy
    }
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
        const legacy = startTrim(st)
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
          if (legacy) return
          const cached = job.videoAlign && job.videoAlign.video === job.videoFile
            ? job.videoAlign : null
          if (cached) applyAlign(cached)
          else measureJob(id, false, req)
        }
      } else if (sel === 'lib' && libSongRef.current) {
        const song = libSongRef.current
        const ev = await decodeMidi(song.midiBase64)
        const st = libSettings(song)
        // Library MIDI is a baked render: velocities mapped, release/cap
        // applied, and it sits on the accompaniment's timeline (dead space
        // cut, codec delay added). videoStartSec puts MIDI time 0 back where
        // it falls in the video; songs moved before that existed get it from
        // the measured alignment instead.
        const p = prepareEvents(ev, { releaseMs: 0, capSustain: false }, true,
          st.videoStartSec || 0)
        if (dead) return
        setPerf(p)
        const legacy = startTrim(st)
        if (song.localVideo) {
          const isBg = Boolean(song.videoIsBacking)
          setVideoSrc(mediaVideoUrl(song.localVideo),
            isBg ? '🎵 backing track (piano removed)' : '🎞 ' + song.localVideo,
            isBg)
          if (legacy) return
          if (st.videoAlignMs != null) {
            applyAlign({ offsetMs: st.videoAlignMs, confidence: 1, method: 'saved' })
          } else {
            measureLib(song, req)
          }
        }
      }
    }
    if (sel) {
      load().catch(function (e) { if (!dead) setLoadErr(e.message || String(e)) })
    }
    return function () { dead = true }
  }, [sel, libKey])

  // Bind the scheduler once both the song and a video are loaded.
  useEffect(function () {
    const v = videoRef.current
    if (!v || !perf || !videoUrl) return
    const eff = effectiveCalibration(calibration)
    const player = createVideoMidiPlayer(v, midi, perf, {
      syncMs: syncMs, pedalMs: pedalMs, velScale: velScale, pedalOn: pedalOn,
      latencyCurve: eff.curve, tvLatencyMs: eff.tvLatencyMs, uniformComp: eff.uniformComp
    })
    player.setActivityCallback(setNotesSent)
    // Live sync monitor: hears the piano's key-echo (when it transmits during
    // playback) and reports the residual timing error for an optional trim.
    const monitor = createLiveSyncMonitor(midi, { echoPortId: calibration.echoPortId })
    monitor.setOnUpdate(setLiveSyncInfo)
    player.setOnScheduled(monitor.noteScheduled)
    monitor.start()
    liveMonitorRef.current = monitor
    setLiveSyncInfo(null)
    player.attach()
    playerRef.current = player
    return function () {
      monitor.stop()
      liveMonitorRef.current = null
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
    if (playerRef.current) {
      const eff = effectiveCalibration(calibration)
      playerRef.current.setCalibration(eff.curve, eff.tvLatencyMs, { uniformComp: eff.uniformComp })
    }
  }, [calibration])
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
    setTrimMs(function (s) { return Math.round(s + ms) })
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
    setTrimMs(function (m) { return Math.round(m + med) })
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

  // --- Auto sync runs by itself on load (see the load effect) and is saved.
  // The button re-measures from scratch and drops a hand-saved per-song
  // offset back to the room trim, since the alignment now covers that part.
  function runAutoSync() {
    if (autoSyncBusy) return
    const req = ++alignReqRef.current
    setTrimMs(lsNum(LS.sync, 0))
    setSaveMsg(null)
    if (sel === 'lib' && libSong) {
      if (!libSong.localVideo) {
        setAlignInfo({ state: 'failed', msg: 'no video saved for this song' })
        return
      }
      measureLib(libSong, req)
    } else if (songJob) {
      if (!songJob.videoFile) {
        setAlignInfo({ state: 'failed', msg: 'no video kept for this song' })
        return
      }
      measureJob(songJob.id, true, req)
    }
  }

  function alignText() {
    const a = alignInfo
    if (!a) return null
    if (a.state === 'measuring') return '⏳ Lining the piano up with this video…'
    if (a.state === 'ok') {
      return '✓ Lined up with the video automatically: ' +
        (a.ms >= 0 ? '+' : '') + a.ms + ' ms (' +
        (a.method === 'audio' ? 'exact audio match'
          : a.method === 'saved' ? 'saved'
            : 'note match, ' + Math.round((a.conf || 0) * 100) + '%') + ')'
    }
    if (a.state === 'low') {
      return '⚠ Couldn\'t line this video up automatically (match ' +
        Math.round((a.conf || 0) * 100) + '%) — use 👏 Tap sync'
    }
    if (a.state === 'manual') {
      return 'Using the timing saved by hand for this song — ⚡ Auto sync to measure it'
    }
    return '⚠ Auto sync failed: ' + a.msg
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

  // Per-song save: the trim (and pedal lag) on top of the automatic
  // alignment. videoSyncMs (the old single number) is cleared so the song
  // stops being treated as hand-synced.
  async function handleSaveSync() {
    const patch = {
      videoTrimMs: Math.round(trimMs), pedalLagMs: Math.round(pedalMs),
      videoSyncMs: null
    }
    if (alignInfo && alignInfo.state === 'ok') patch.videoAlignMs = alignMs
    try {
      if (sel === 'lib' && libSong) {
        await saveLibSync(libSong, patch)
      } else if (songJob) {
        const jobPatch = { ...patch }
        delete jobPatch.videoAlignMs // the job keeps its own (job.videoAlign)
        const merged = { ...DEFAULTS, ...(songJob.settings || {}), ...jobPatch }
        await saveJobSettings(songJob.id, merged)
      } else {
        return
      }
      setSaveMsg('Saved for this song')
    } catch (e) {
      setSaveMsg('Save failed: ' + e.message)
    }
  }

  // The trim is the room's (TV + piano), not the song's, so it is the default
  // every song starts from.
  function handleSaveDefault() {
    localStorage.setItem(LS.sync, String(Math.round(trimMs)))
    localStorage.setItem(LS.pedal, String(Math.round(pedalMs)))
    setSaveMsg('Saved as the trim every song starts with')
  }

  // Toggle the piano's fixed-delay compensation mode. On = the scheduler assumes
  // the piano's MIDI IN Delay (~500 ms) and shifts every message early by that
  // constant; the wizard is what actually verifies the piano is in that mode.
  function toggleDelayMode(on) {
    setCalibration(function (c) {
      const next = { ...c, delayMode: on }
      saveCalibration(next)
      return next
    })
  }

  // Nudge the offset by the live-measured residual, then reset the monitor so
  // it re-measures against the corrected timing.
  function applyLiveTrim() {
    const info = liveSyncInfo
    if (!info || info.medianErr == null) return
    setTrimMs(function (m) { return Math.round(m - info.medianErr) })
    if (liveMonitorRef.current) liveMonitorRef.current.reset()
    setLiveSyncInfo(null)
    setSaveMsg(null)
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
          value={sel === 'lib' && libSong ? 'lib:' + libSong.id : sel}
          onChange={function (e) {
            const v = e.target.value
            setSaveMsg(null)
            if (v.indexOf('lib:') === 0) {
              const id = v.slice(4)
              const song = (libList || []).find(function (s) { return s.id === id }) ||
                (libSong && libSong.id === id ? libSong : null)
              if (song) { setLibSong(song); setSel('lib') }
            } else {
              setSel(v)
            }
          }}
        >
          <option value="">🎵 Choose a song…</option>
          {sel === 'lib' && libSong && !(libList || []).some(function (s) { return s.id === libSong.id }) && (
            <option value={'lib:' + libSong.id}>☁ {libSong.title}</option>
          )}
          {doneJobs.length > 0 && (
            <optgroup label="Convert tab">
              {doneJobs.map(function (j) {
                return <option key={j.id} value={'job:' + j.id}>
                  {j.videoFile ? '🎞 ' : ''}{j.name}
                </option>
              })}
            </optgroup>
          )}
          {libList && libList.length > 0 && (
            <optgroup label="Library (🎞 = has its video)">
              {libList.map(function (s) {
                return <option key={s.id} value={'lib:' + s.id}>
                  {s.localVideo ? '🎞 ' : ''}{s.title}
                </option>
              })}
            </optgroup>
          )}
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
            Room trim <strong>{Math.round(trimMs)} ms</strong>
            <span className="meta"> (your TV + piano · − earlier · + later)</span>
          </label>
          <div className="row">
            <button onClick={function () { nudge(-50) }}>−50</button>
            <button onClick={function () { nudge(-10) }}>−10</button>
            <input
              type="range" min="-2000" max="2000" step="10" value={trimMs}
              onChange={function (e) { setTrimMs(parseFloat(e.target.value)); setSaveMsg(null) }}
            />
            <button onClick={function () { nudge(10) }}>+10</button>
            <button onClick={function () { nudge(50) }}>+50</button>
          </div>
          {alignInfo && <div className="meta" style={{ marginTop: 4 }}>{alignText()}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className={alignInfo && alignInfo.state !== 'ok' ? 'primary' : ''}
              disabled={!ready || autoSyncBusy}
              title="Measure this song's alignment with its video again (it runs by itself when a song loads)"
              onClick={runAutoSync}>
              {autoSyncBusy ? '⏳ Measuring…' : '⚡ Auto sync'}
            </button>
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
          <div className="row" style={{ marginTop: 6 }}>
            <button disabled={!midi.connected}
              title="Measure the piano's timing so every note fires early by the right amount"
              onClick={function () { setShowCalibrate(true) }}>
              ⚡ Calibrate piano{(calibration.delayMode ? calibration.delayVerified : calibration.curve.length) ? ' ✓' : ''}
            </button>
            <button disabled={!midi.connected}
              title="Play a hymn on an on-screen keyboard (show it on the TV) while the piano plays it live, and fine-tune the offset"
              onClick={function () { setShowVisual(true) }}>
              🎹 Visual sync test
            </button>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <label className="row" style={{ gap: 4 }}
              title="The piano's MIDI IN Delay makes timing exact and velocity-independent. Enable it on the piano, then verify with Calibrate.">
              <input type="checkbox" checked={Boolean(calibration.delayMode)}
                onChange={function (e) { toggleDelayMode(e.target.checked) }} />
              500 ms delay mode
            </label>
            {calibration.delayMode && !calibration.delayVerified && (
              <span className="meta">unverified — run ⚡ Calibrate to confirm</span>
            )}
          </div>
          {liveSyncInfo && liveSyncInfo.matches >= 5 && liveSyncInfo.medianErr != null && (
            <div className="row" style={{ marginTop: 6 }}>
              <span className="meta">
                🎧 Live: piano running {Math.abs(Math.round(liveSyncInfo.medianErr))} ms
                {liveSyncInfo.medianErr >= 0 ? ' late' : ' early'} ({liveSyncInfo.samples} notes)
              </span>
              <button className="primary" onClick={applyLiveTrim}>
                Trim {liveSyncInfo.medianErr >= 0 ? '−' : '+'}{Math.abs(Math.round(liveSyncInfo.medianErr))} ms
              </button>
            </div>
          )}
          {tapMsg && <div className="meta">{tapMsg}</div>}
          {!tapMsg && (
            <div className="meta">
              Each song lines itself up with its video. The trim is what your
              TV and piano add — set it once (⭐ Use as default). Nudge live with
              , and . while watching.
            </div>
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
            <button disabled={!songJob && !(sel === 'lib' && libSong)} onClick={handleSaveSync}
              title="Remember these offsets for this song">
              💾 Save timing for “{songLabel || 'song'}”
            </button>
            <button onClick={handleSaveDefault}
              title="Every song starts with this room trim and pedal timing">
              ⭐ Use as default
            </button>
          </div>
          {saveMsg && <div className="meta">{saveMsg}</div>}
        </div>
      </div>

      <div className="meta player-help">
        Space play/pause · ←/→ skip 5s · , / . nudge piano ±10 ms · t tap sync ·
        m mute video · f fullscreen. HDMI the laptop to the TV, USB to the
        piano's USB TO HOST port, press play. Best sync: turn on the piano's
        <strong> MIDI IN Delay</strong> and tick <strong>500 ms delay mode</strong>,
        run <strong>⚡ Calibrate</strong> once (verifies the delay and measures your
        TV), then set the room trim once with 🎹 Visual sync test and ⭐ Use as
        default. Every song lines itself up with its own video automatically.
      </div>

      {showCalibrate && (
        <CalibrationWizard
          midi={midi}
          current={calibration}
          onApply={function (cal) {
            setCalibration(cal)
            setShowCalibrate(false)
          }}
          onClose={function () { setShowCalibrate(false) }}
          onLaunchVisual={function () { setShowCalibrate(false); setShowVisual(true) }}
        />
      )}

      {showVisual && (
        <VisualTest
          midi={midi}
          syncMs={trimMs}
          pedalMs={pedalMs}
          velScale={velScale}
          pedalOn={pedalOn}
          calibration={calibration}
          onSyncChange={function (ms) { setTrimMs(ms); setSaveMsg(null) }}
          onClose={function () { setShowVisual(false) }}
        />
      )}
    </div>
  )
}
