import { useEffect, useState, useCallback } from 'react'
import UploadZone from './components/UploadZone.jsx'
import JobCard from './components/JobCard.jsx'
import ResultView from './components/ResultView.jsx'
import LibraryView from './components/LibraryView.jsx'
import { listJobs, uploadMp3, submitUrl, deleteJob } from './api.js'
import { firebaseReady } from './firebase.js'

export default function App() {
  const [tab, setTab] = useState('convert')
  const [jobs, setJobs] = useState([])
  const [openJobId, setOpenJobId] = useState(null)
  const [backendUp, setBackendUp] = useState(true)

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
    } catch (e) {
      alert('Could not start download: ' + e.message)
    }
    refresh()
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
    </div>
  )
}
