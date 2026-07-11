import { useEffect, useState, useCallback } from 'react'
import UploadZone from './components/UploadZone.jsx'
import JobCard from './components/JobCard.jsx'
import ResultView from './components/ResultView.jsx'
import LibraryView from './components/LibraryView.jsx'
import SourcesView from './components/SourcesView.jsx'
import {
  listJobs, uploadMp3, submitUrl, deleteJob, verifyJob,
  midiUrl, audioUrl, fetchMidiBase64
} from './api.js'
import {
  firebaseReady, saveSong, saveSourceUrl, listSongs, isSameSong
} from './firebase.js'

// Slider settings used for bulk export/move. Per-song tuning happens in the
// open editor; batch actions render with the pipeline defaults.
const DEFAULTS = {
  velMin: 20, velMax: 112, gamma: 1.0, offsetMs: 0, pedal: true,
  releaseMs: 0, capSustain: true
}

// Strip characters Windows/FAT (USB stick) filesystems reject.
function fsSafe(name) {
  const cleaned = (name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/, '')
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
      try {
        await uploadMp3(files[i], pianoOnly)
      } catch (e) {
        alert('Upload failed: ' + e.message)
      }
    }
    refresh()
  }

  async function handleUrl(url, pianoOnly) {
    try {
      await submitUrl(url, pianoOnly)
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
    setBatchResult(null)
    setBatch({ done: 0, total: chosen.length, verb: 'Copying' })
    const errors = []
    let done = 0
    for (const job of chosen) {
      const base = fsSafe(job.name)
      try {
        const midiRes = await fetch(midiUrl(job.id, jobSettings(job)))
        if (!midiRes.ok) throw new Error('MIDI render failed (' + midiRes.status + ')')
        await writeInto(dir, base + '.mid', await midiRes.blob())
        if (job.accompaniment) {
          const mp3Res = await fetch(audioUrl(job.id, 'accompaniment'))
          if (!mp3Res.ok) throw new Error('MP3 fetch failed (' + mp3Res.status + ')')
          await writeInto(dir, base + ' (no piano).mp3', await mp3Res.blob())
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
    try {
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
        if (b64.length > 900000) throw new Error('MIDI too large for cloud (>900KB)')
        let mp3Blob = null
        if (job.accompaniment) {
          try {
            const res = await fetch(audioUrl(job.id, 'accompaniment'))
            if (res.ok) mp3Blob = await res.blob()
          } catch (e) { /* archive MIDI-only if audio fetch fails */ }
        }
        await saveSong({
          title: job.name,
          noteCount: job.noteCount,
          pedalCount: job.pedalCount,
          settings: jobSettings(job),
          midiBase64: b64,
          sourceUrl: job.sourceUrl || null
        }, mp3Blob)
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

  return (
    <div>
      <h1>Piano<span className="accent">Lift</span> 🎹</h1>
      <p className="tagline">
        MP3 → piano stem → Disklavier ENSPIRE MIDI with dynamics + pedal
      </p>

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
          className={tab === 'links' ? 'active' : ''}
          onClick={function () { setTab('links') }}
        >Links</button>
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
              {firebaseReady && (
                <button
                  className="primary"
                  disabled={selected.size === 0 || Boolean(batch)}
                  onClick={handleMoveToLibrary}
                >
                  {batch && batch.verb === 'Moving'
                    ? 'Moving ' + batch.done + '/' + batch.total + '…'
                    : '☁ Move ' + (selected.size || '') + ' to library'}
                </button>
              )}
            </div>
          )}

          {batchResult && (
            <div className="notice" style={{
              borderColor: batchResult.errors.length ? 'var(--red, #c0392b)' : 'var(--green)'
            }}>
              ✓ {batchResult.verb} <strong>{batchResult.ok}/{batchResult.total}</strong> song
              {batchResult.total === 1 ? '' : 's'}.
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
          {jobs.slice().reverse().map(function (job) {
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
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'library' && <LibraryView onEdit={handleEditFromLibrary} />}

      {tab === 'links' && <SourcesView />}
    </div>
  )
}
