import { useEffect, useState, useCallback, useRef } from 'react'
import UploadZone from './components/UploadZone.jsx'
import JobCard from './components/JobCard.jsx'
import ResultView from './components/ResultView.jsx'
import LibraryView from './components/LibraryView.jsx'
import LocalLibraryView from './components/LocalLibraryView.jsx'
import SourcesView from './components/SourcesView.jsx'
import PlayerView from './components/PlayerView.jsx'
import GotekView from './components/GotekView.jsx'
import AuthView from './components/AuthView.jsx'
import ActivationModal from './components/ActivationModal.jsx'
import SheetUploadZone from './components/SheetUploadZone.jsx'
import SheetJobCard from './components/SheetJobCard.jsx'
import SheetResultView from './components/SheetResultView.jsx'
import {
  listJobs, uploadMp3, submitUrl, deleteJob, verifyJob,
  midiUrl, audioUrl, fetchMidiBase64, archiveVideo, buildDiskFromJobs,
  listSheetJobs, uploadSheet
} from './api.js'
import {
  firebaseReady, saveSong, saveSourceUrl, listSongs, isSameSong, findExistingSong,
  onAuth, getAccount, isFamilyUser, signOut, recordConversion
} from './firebase.js'
import { localSave } from './localLibrary.js'

// Slider settings used for bulk export/move. Per-song tuning happens in the
// open editor; batch actions render with the pipeline defaults.
const DEFAULTS = {
  velMin: 20, velMax: 112, gamma: 1.0, offsetMs: 0, pedal: true,
  releaseMs: 0, capSustain: true
}

// Strip characters Windows/FAT (USB stick) filesystems reject.
function fsSafe(name) {
  // Windows-illegal chars, plus '&' (the Enspire's USB song indexer silently
  // skips any file whose name contains it), then cap length — the Enspire also
  // drops very long names from the list. Trim trailing space/dot after slicing.
  const cleaned = (name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f&]/g, '_')
    .replace(/[ .]+$/, '')
    .slice(0, 60)
    .replace(/[ .]+$/, '')
  return cleaned || 'song'
}

async function writeInto(dir, filename, data) {
  const fh = await dir.getFileHandle(filename, { create: true })
  const w = await fh.createWritable()
  await w.write(data)
  await w.close()
}

export default function App() {
  const [tab, setTab] = useState('convert')
  const [jobs, setJobs] = useState([])
  const [openJobId, setOpenJobId] = useState(null)
  const [backendUp, setBackendUp] = useState(true)
  const [cleanAllBusy, setCleanAllBusy] = useState(null) // "3/15" while running
  const [selected, setSelected] = useState(function () { return new Set() })
  const [batch, setBatch] = useState(null) // null | { done, total, verb }
  const [batchResult, setBatchResult] = useState(null)
  const [search, setSearch] = useState('')
  // Play tab target: {jobId} (Convert song) or {libSong} (library song).
  // A fresh object per click so PlayerView re-targets even for the same song.
  const [playerInit, setPlayerInit] = useState(null)

  // ---- Sheet tab: PDF/MusicXML -> pedal + dynamics suggestions ----
  const [sheetJobs, setSheetJobs] = useState([])
  const [openSheetJobId, setOpenSheetJobId] = useState(null)
  const [sheetUploading, setSheetUploading] = useState(false)

  const refreshSheet = useCallback(async function () {
    try {
      setSheetJobs(await listSheetJobs())
    } catch (e) { /* backend blip — next refresh reconciles */ }
  }, [])

  useEffect(function () {
    refreshSheet()
    // PDF jobs run OMR in the background (can take a while), so poll like
    // the Convert tab does for its audio jobs.
    const t = setInterval(refreshSheet, 2000)
    return function () { clearInterval(t) }
  }, [refreshSheet])

  async function handleSheetFiles(files) {
    setSheetUploading(true)
    let lastId = null
    for (let i = 0; i < files.length; i++) {
      try {
        const job = await uploadSheet(files[i])
        lastId = job.id
      } catch (e) {
        alert('Upload failed: ' + e.message)
      }
    }
    setSheetUploading(false)
    if (lastId) setOpenSheetJobId(lastId)
    refreshSheet()
  }

  // ---- Accounts & the 5-song free tier ----
  const [user, setUser] = useState(null)
  const [account, setAccount] = useState(null) // { family, activated, conversions, remaining }
  const [authChecked, setAuthChecked] = useState(!firebaseReady) // no Firebase → no gate
  const [showActivation, setShowActivation] = useState(false)
  const accountRef = useRef(null)
  useEffect(function () { accountRef.current = account }, [account])

  useEffect(function () {
    if (!firebaseReady) return undefined
    return onAuth(async function (u) {
      setUser(u)
      setAuthChecked(true)
      try { setAccount(u ? await getAccount(u) : null) } catch (e) { setAccount(null) }
    })
  }, [])

  const isFamily = account ? account.family : false

  // A conversion may proceed when there's no gate (Firebase off), the account is
  // family/activated, or a free credit remains — consuming one in that case.
  function consumeCredit() {
    if (!firebaseReady) return true
    const a = accountRef.current
    if (!a || a.family || a.activated) return true
    if (a.remaining <= 0) { setShowActivation(true); return false }
    const next = { ...a, conversions: a.conversions + 1, remaining: a.remaining - 1 }
    accountRef.current = next
    setAccount(next)
    recordConversion(user).catch(function () { /* best-effort counter */ })
    return true
  }

  async function reloadAccount() {
    if (user) { try { setAccount(await getAccount(user)) } catch (e) { /* keep */ } }
  }

  const refresh = useCallback(async function () {
    try {
      const items = await listJobs()
      setJobs(items)
      setBackendUp(true)
    } catch (e) {
      setBackendUp(false)
    }
  }, [])

  useEffect(function () {
    refresh()
    const t = setInterval(function () {
      refresh()
    }, 2000)
    return function () { clearInterval(t) }
  }, [refresh])

  async function handleFiles(files, pianoOnly) {
    for (let i = 0; i < files.length; i++) {
      if (!consumeCredit()) break // free tier exhausted → activation modal
      try {
        await uploadMp3(files[i], pianoOnly)
      } catch (e) {
        alert('Upload failed: ' + e.message)
      }
    }
    refresh()
  }

  async function handleUrl(url, pianoOnly, includeVideo) {
    if (!consumeCredit()) return // free tier exhausted → activation modal
    if (firebaseReady) {
      try {
        const dup = await findExistingSong(null, url)
        if (dup && !confirm(
          '"' + (dup.title || 'This song') + '" is already in your library. '
          + 'Convert it again anyway?'
        )) return
      } catch (e) { /* best-effort — a lookup failure must not block converting */ }
    }
    try {
      await submitUrl(url, pianoOnly, includeVideo)
      // Keep a history of every converted link so the source video can be
      // found again later (see the Links tab). Best-effort — a Firebase blip
      // must not block the conversion that already started.
      if (firebaseReady) saveSourceUrl(url).catch(function () { /* best-effort */ })
    } catch (e) {
      alert('Could not start download: ' + e.message)
    }
    refresh()
  }

  // Songs converted before the pipeline verified notes against the audio.
  // Library imports have no stem to check against, so they never qualify.
  const cleanable = jobs.filter(function (j) {
    return j.status === 'done' && j.pianoStem && !j.verified
  })

  async function handleCleanAll() {
    if (!confirm('Clean up ' + cleanable.length + ' song(s)? Removes ghost '
      + 'notes and trims over-held notes — about 20 seconds per song. '
      + 'Reset to original in the editor undoes it per song.')) return
    let ghosts = 0
    let trimmed = 0
    const failed = []
    for (let i = 0; i < cleanable.length; i++) {
      setCleanAllBusy((i + 1) + '/' + cleanable.length)
      try {
        const r = await verifyJob(cleanable[i].id)
        ghosts += r.ghostCount
        trimmed += r.trimmedCount
      } catch (e) {
        failed.push(cleanable[i].name)
      }
      refresh()
    }
    setCleanAllBusy(null)
    alert('Clean-up done: removed ' + ghosts + ' ghost notes, trimmed '
      + trimmed + ' over-held note endings across ' + (cleanable.length - failed.length)
      + ' songs.' + (failed.length ? ' Failed: ' + failed.join(', ') : ''))
  }

  // Library → editor: the imported job already lives in the backend, so jump
  // to Convert, open it, and refresh so it appears in the list.
  const handleEditFromLibrary = useCallback(async function (jobId) {
    setTab('convert')
    setOpenJobId(jobId)
    await refresh()
  }, [refresh])

  // Open the video-sync player targeting a Convert-tab job.
  const handlePlayJob = useCallback(function (jobId) {
    setPlayerInit({ jobId: jobId })
    setTab('play')
  }, [])

  // Open the player on a library song (played straight from its baked MIDI —
  // the library copy stays put, no import).
  const handleWatchFromLibrary = useCallback(function (song) {
    setPlayerInit({ libSong: song })
    setTab('play')
  }, [])

  // Save-to-library succeeded: the song now lives in the cloud library, so
  // drop the finished job off the Convert tab and collapse the editor.
  async function handleArchived(jobId) {
    try {
      await deleteJob(jobId)
    } catch (e) {
      // already gone / backend blip — refresh will reconcile
    }
    setOpenJobId(null)
    refresh()
  }

  const doneJobs = jobs.filter(function (j) { return j.status === 'done' })

  // Newest first (backend sorts oldest-first by creation time); the search
  // box narrows by name, case-insensitive.
  const shownJobs = jobs.slice().reverse().filter(function (j) {
    return !search ||
      (j.name || '').toLowerCase().includes(search.toLowerCase())
  })

  function toggleSelect(id) {
    setSelected(function (prev) {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllDone() {
    setSelected(new Set(doneJobs.map(function (j) { return j.id })))
  }

  function clearSelection() {
    setSelected(new Set())
  }

  function chosenJobs() {
    return jobs.filter(function (j) {
      return selected.has(j.id) && j.status === 'done'
    })
  }

  // A job's saved editor tuning, falling back to pipeline defaults for songs
  // never opened/tuned.
  function jobSettings(job) {
    return job.settings ? { ...DEFAULTS, ...job.settings } : DEFAULTS
  }

  // Copy every selected finished song (rendered .mid + accompaniment .mp3) into
  // a folder the user picks — typically the ENSPIRE USB stick. Runs in-browser:
  // the MIDI/MP3 are fetched from the backend render endpoints.
  async function handleCopyToUsb() {
    const chosen = chosenJobs()
    if (!chosen.length) return
    // Desktop shell: native OS folder browser + Node file write. Browser:
    // File System Access API. `native` unifies both behind write(name, blob).
    let native
    if (window.desktop) {
      let dirPath
      try {
        dirPath = await window.desktop.pickFolder()
      } catch (e) {
        alert('Could not open folder: ' + e.message)
        return
      }
      if (!dirPath) return // user cancelled
      native = {
        write: async (name, blob) =>
          window.desktop.writeFile(dirPath, name, new Uint8Array(await blob.arrayBuffer()))
      }
    } else {
      if (!window.showDirectoryPicker) {
        alert('Your browser can\'t pick a folder. Use Chrome/Edge or the desktop app.')
        return
      }
      let dir
      try {
        dir = await window.showDirectoryPicker({ mode: 'readwrite' })
      } catch (e) {
        if (e && e.name === 'AbortError') return // user cancelled the picker
        alert('Could not open folder: ' + e.message)
        return
      }
      native = { write: (name, blob) => writeInto(dir, name, blob) }
    }
    setBatchResult(null)
    setBatch({ done: 0, total: chosen.length, verb: 'Copying' })
    const errors = []
    let done = 0
    for (const job of chosen) {
      const base = fsSafe(job.name)
      try {
        const midiRes = await fetch(midiUrl(job.id, jobSettings(job)))
        if (!midiRes.ok) throw new Error('MIDI render failed (' + midiRes.status + ')')
        await native.write(base + '.mid', await midiRes.blob())
        if (job.accompaniment) {
          const mp3Res = await fetch(audioUrl(job.id, 'accompaniment'))
          if (!mp3Res.ok) throw new Error('MP3 fetch failed (' + mp3Res.status + ')')
          await native.write(base + ' (no piano).mp3', await mp3Res.blob())
        }
      } catch (e) {
        errors.push(job.name + ' — ' + (e.message || String(e)))
      }
      done++
      setBatch({ done: done, total: chosen.length, verb: 'Copying' })
    }
    setBatch(null)
    setBatchResult({ verb: 'Copied', ok: chosen.length - errors.length, total: chosen.length, errors: errors })
    clearSelection()
  }

  // Move every selected finished song to the cloud library (MIDI + accompaniment
  // MP3), then drop it from the Convert list so each song lives in one place.
  async function handleMoveToLibrary() {
    if (!firebaseReady) return
    const chosen = chosenJobs()
    if (!chosen.length) return
    // Flag songs already in the library (same source link or title). Let the
    // user add them again or skip just those. A lookup failure skips the check
    // rather than blocking the move.
    let toMove = chosen
    if (isFamily) try {
      const existing = await listSongs()
      const dups = chosen.filter(function (j) {
        return existing.some(function (s) { return isSameSong(s, j.name, j.sourceUrl) })
      })
      if (dups.length) {
        const names = dups.map(function (j) { return j.name }).join(', ')
        const addAnyway = confirm(
          dups.length + ' of these are already in your library:\n' + names +
          '\n\nOK = add them again anyway.\nCancel = skip those, move only the new ones.')
        if (!addAnyway) {
          toMove = chosen.filter(function (j) {
            return !existing.some(function (s) { return isSameSong(s, j.name, j.sourceUrl) })
          })
        }
      }
    } catch (e) { /* dedupe best-effort */ }
    if (!toMove.length) {
      alert('All selected songs are already in the library — nothing moved.')
      return
    }
    if (!confirm('Move ' + toMove.length + ' song' + (toMove.length === 1 ? '' : 's') +
      ' to the library? They leave the Convert list. Renders use each song\'s ' +
      'saved editor tuning (defaults if never opened).')) return
    setBatchResult(null)
    setBatch({ done: 0, total: toMove.length, verb: 'Moving' })
    const errors = []
    let done = 0
    for (const job of toMove) {
      try {
        const b64 = await fetchMidiBase64(job.id, jobSettings(job))
        if (isFamily && b64.length > 900000) throw new Error('MIDI too large for cloud (>900KB)')
        let mp3Blob = null
        if (job.accompaniment) {
          try {
            const res = await fetch(audioUrl(job.id, 'accompaniment'))
            if (res.ok) mp3Blob = await res.blob()
          } catch (e) { /* archive MIDI-only if audio fetch fails */ }
        }
        // Videos are too big for the cloud: park the file in the backend's
        // local media folder (it would die with the job otherwise) and store
        // only its filename on the song.
        let localVideo = null
        if (job.videoFile) {
          try {
            localVideo = (await archiveVideo(job.id)).file
          } catch (e) { /* video archive best-effort — song still moves */ }
        }
        const songMeta = {
          title: job.name,
          noteCount: job.noteCount,
          pedalCount: job.pedalCount,
          settings: jobSettings(job),
          midiBase64: b64,
          sourceUrl: job.sourceUrl || null,
          localVideo: localVideo,
          videoIsBacking: job.videoFile === 'video_bg.mp4'
        }
        // Family → shared cloud library; customers → on-device local library.
        if (isFamily) await saveSong(songMeta, mp3Blob)
        else await localSave(songMeta, mp3Blob)
        await deleteJob(job.id)
        if (openJobId === job.id) setOpenJobId(null)
      } catch (e) {
        errors.push(job.name + ' — ' + (e.message || String(e)))
      }
      done++
      setBatch({ done: done, total: toMove.length, verb: 'Moving' })
    }
    setBatch(null)
    setBatchResult({ verb: 'Moved', ok: toMove.length - errors.length, total: toMove.length, errors: errors })
    clearSelection()
    refresh()
  }

  // Pack every selected finished song onto ONE floppy image (many songs per
  // Gotek slot, instead of one song per slot). Writes to the next free slot by
  // default, or a slot the user names — overwriting an occupied one on confirm.
  async function handleBuildDisk() {
    const chosen = chosenJobs()
    if (!chosen.length) return
    const raw = window.prompt(
      'Write ' + chosen.length + ' song' + (chosen.length === 1 ? '' : 's') +
      ' onto ONE floppy slot.\n\n' +
      'Gotek slot number to write, or leave blank for the next free slot:', '')
    if (raw === null) return // cancelled
    const t = raw.trim()
    let slot = null
    if (t !== '') {
      slot = parseInt(t, 10)
      if (Number.isNaN(slot) || slot < 0 || slot > 999) {
        alert('Slot must be a number 0–999 (or blank for the next free slot).')
        return
      }
    }
    const ids = chosen.map(function (j) { return j.id })
    setBatchResult(null)
    setBatch({ done: 0, total: chosen.length, verb: 'Building' })
    try {
      let res
      try {
        res = await buildDiskFromJobs(ids, { slot: slot })
      } catch (e) {
        if (e.status === 409 &&
          confirm('Slot ' + slot + ' already holds a song. Overwrite it?')) {
          res = await buildDiskFromJobs(ids, { slot: slot, overwrite: true })
        } else {
          throw e
        }
      }
      setBatch(null)
      setBatchResult({
        verb: 'Wrote', ok: chosen.length, total: chosen.length, errors: [],
        note: 'onto slot ' + res.slot + ' (' + res.filename + '). '
          + 'Power-cycle the piano/emulator so it re-indexes, then pick disk '
          + res.slot + ' — all ' + chosen.length + ' songs are on it.'
      })
      clearSelection()
    } catch (e) {
      setBatch(null)
      setBatchResult({
        verb: 'Wrote', ok: 0, total: chosen.length,
        errors: [e.message || String(e)]
      })
    }
  }

  // Same multi-song floppy image, but hand back the .hfe file to save/drop on
  // the stick manually (no plugged-in Gotek required).
  async function handleDownloadDisk() {
    const chosen = chosenJobs()
    if (!chosen.length) return
    const ids = chosen.map(function (j) { return j.id })
    setBatchResult(null)
    setBatch({ done: 0, total: chosen.length, verb: 'Building' })
    try {
      const blob = await buildDiskFromJobs(ids, { download: true })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'PIANODISK.hfe'
      a.click()
      URL.revokeObjectURL(url)
      setBatch(null)
      setBatchResult({
        verb: 'Built', ok: chosen.length, total: chosen.length, errors: [],
        note: 'as PIANODISK.hfe — rename it DSKAxxxx.hfe on the stick to fill a slot.'
      })
      clearSelection()
    } catch (e) {
      setBatch(null)
      setBatchResult({
        verb: 'Built', ok: 0, total: chosen.length,
        errors: [e.message || String(e)]
      })
    }
  }

  // Auth gate: with Firebase on, require sign-in before the app is usable.
  if (firebaseReady && !authChecked) {
    return <div className="auth-wrap"><div className="meta">Loading…</div></div>
  }
  if (firebaseReady && !user) {
    return <AuthView />
  }

  return (
    <div>
      <h1><img src="./pianoforge.png" alt="PianoForge" className="logo" /></h1>

      {firebaseReady && user && (
        <div className="account-bar">
          <span className="acct-email">{user.email}</span>
          {account && account.family && <span className="acct-badge family">Family · unlimited</span>}
          {account && !account.family && (account.activated
            ? <span className="acct-badge activated">Activated · unlimited</span>
            : <span className="acct-badge">
                {account.remaining} free conversion{account.remaining === 1 ? '' : 's'} left
                <button className="linklike" onClick={function () { setShowActivation(true) }}> · Activate</button>
              </span>)}
          <button className="ghost acct-signout" onClick={function () { signOut() }}>Sign out</button>
        </div>
      )}

      <div className="tabs">
        <button
          className={tab === 'convert' ? 'active' : ''}
          onClick={function () { setTab('convert') }}
        >Convert</button>
        <button
          className={tab === 'library' ? 'active' : ''}
          onClick={function () { setTab('library') }}
        >Library</button>
        <button
          className={tab === 'play' ? 'active' : ''}
          onClick={function () { setTab('play') }}
        >Play</button>
        <button
          className={tab === 'disk' ? 'active' : ''}
          onClick={function () { setTab('disk') }}
        >Disk</button>
        <button
          className={tab === 'links' ? 'active' : ''}
          onClick={function () { setTab('links') }}
        >Links</button>
        <button
          className={tab === 'sheet' ? 'active' : ''}
          onClick={function () { setTab('sheet') }}
        >Sheet</button>
      </div>

      {tab === 'convert' && (
        <div>
          {!backendUp && (
            <div className="notice warn">
              Backend not reachable. Start it with <code>run-backend.cmd</code> (or
              <code> uvicorn app.main:app --port 8000</code> in backend/).
            </div>
          )}
          <UploadZone onFiles={handleFiles} onUrl={handleUrl} />

          {doneJobs.length > 0 && (
            <div className="lib-select-bar">
              <button className="ghost" onClick={selectAllDone}>
                Select all ({doneJobs.length})
              </button>
              {selected.size > 0 && (
                <button className="ghost" onClick={clearSelection}>Clear</button>
              )}
              <span className="meta">{selected.size} selected</span>
              <button
                className="primary"
                disabled={selected.size === 0 || Boolean(batch)}
                onClick={handleCopyToUsb}
              >
                {batch && batch.verb === 'Copying'
                  ? 'Copying ' + batch.done + '/' + batch.total + '…'
                  : '💾 Copy ' + (selected.size || '') + ' to USB folder…'}
              </button>
              <button
                className="primary"
                disabled={selected.size === 0 || Boolean(batch)}
                title="Pack every selected song onto ONE 1995-Disklavier floppy slot (Gotek). One slot then holds many songs."
                onClick={handleBuildDisk}
              >
                {batch && batch.verb === 'Building'
                  ? 'Building disk…'
                  : '💿 Build 1 floppy (' + (selected.size || '') + ' songs)'}
              </button>
              <button
                className="ghost"
                disabled={selected.size === 0 || Boolean(batch)}
                title="Download the combined floppy image (.hfe) to drop on the stick yourself — no plugged-in Gotek needed."
                onClick={handleDownloadDisk}
              >⬇ .hfe</button>
              {firebaseReady && (
                <button
                  className="primary"
                  disabled={selected.size === 0 || Boolean(batch)}
                  onClick={handleMoveToLibrary}
                >
                  {batch && batch.verb === 'Moving'
                    ? 'Moving ' + batch.done + '/' + batch.total + '…'
                    : (isFamily ? '☁ Move ' : '📁 Move ') + (selected.size || '') + ' to library'}
                </button>
              )}
            </div>
          )}

          {batchResult && (
            <div className="notice" style={{
              borderColor: batchResult.errors.length ? 'var(--red, #c0392b)' : 'var(--green)'
            }}>
              ✓ {batchResult.verb} <strong>{batchResult.ok}/{batchResult.total}</strong> song
              {batchResult.total === 1 ? '' : 's'}
              {batchResult.note ? ' ' + batchResult.note : '.'}
              {batchResult.errors.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  Failed: {batchResult.errors.join('; ')}
                </div>
              )}
            </div>
          )}

          {cleanable.length > 0 && (
            <div className="row" style={{ margin: '12px 0' }}>
              <button disabled={!!cleanAllBusy} onClick={handleCleanAll}>
                {cleanAllBusy
                  ? 'Cleaning ' + cleanAllBusy + '…'
                  : '✨ Clean up ' + cleanable.length + ' song'
                    + (cleanable.length === 1 ? '' : 's')
                    + ' — remove ghost notes, fix held notes'}
              </button>
            </div>
          )}
          {jobs.length > 3 && (
            <input
              type="text"
              className="url-input"
              style={{ width: '100%', margin: '10px 0 4px', boxSizing: 'border-box' }}
              placeholder="🔍 Search songs by name…"
              value={search}
              onChange={function (e) { setSearch(e.target.value) }}
            />
          )}
          {shownJobs.map(function (job) {
            const isOpen = openJobId === job.id
            return (
              <div key={job.id} className={isOpen ? 'job-open' : ''}>
                <JobCard
                  job={job}
                  open={isOpen}
                  onToggle={function () {
                    setOpenJobId(isOpen ? null : job.id)
                  }}
                  onDeleted={refresh}
                  onCleaned={refresh}
                  selected={selected.has(job.id)}
                  onSelectToggle={toggleSelect}
                />
                {isOpen && job.status === 'done' && (
                  <ResultView
                    job={job}
                    firebaseReady={firebaseReady}
                    onArchived={handleArchived}
                    onPlayVideo={handlePlayJob}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'library' && (
        isFamily
          ? <LibraryView onEdit={handleEditFromLibrary} onWatch={handleWatchFromLibrary} />
          : <LocalLibraryView onWatch={handleWatchFromLibrary} />
      )}

      {tab === 'play' && <PlayerView jobs={jobs} initial={playerInit} />}

      {tab === 'disk' && <GotekView />}

      {tab === 'links' && <SourcesView />}

      {tab === 'sheet' && (
        <div>
          {!backendUp && (
            <div className="notice warn">
              Backend not reachable. Start it with <code>run-backend.cmd</code> (or
              <code> uvicorn app.main:app --port 8000</code> in backend/).
            </div>
          )}
          <SheetUploadZone onFiles={handleSheetFiles} />
          {sheetUploading && <div className="meta">Uploading…</div>}
          {sheetJobs.slice().reverse().map(function (job) {
            const isOpen = openSheetJobId === job.id
            return (
              <div key={job.id}>
                <SheetJobCard
                  job={job}
                  open={isOpen}
                  onToggle={function () { setOpenSheetJobId(isOpen ? null : job.id) }}
                  onDeleted={function () {
                    if (isOpen) setOpenSheetJobId(null)
                    refreshSheet()
                  }}
                />
                {isOpen && (
                  <SheetResultView job={job} onChanged={refreshSheet} />
                )}
              </div>
            )
          })}
        </div>
      )}

      {showActivation && (
        <ActivationModal
          reason="limit"
          onActivated={function () { setShowActivation(false); reloadAccount() }}
          onClose={function () { setShowActivation(false) }}
        />
      )}
    </div>
  )
}
