import { useEffect, useState, useCallback } from 'react'
import UploadZone from './components/UploadZone.jsx'
import JobCard from './components/JobCard.jsx'
import ResultView from './components/ResultView.jsx'
import LibraryView from './components/LibraryView.jsx'
import { listJobs, uploadMp3 } from './api.js'
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

  const openJob = jobs.find(function (j) { return j.id === openJobId })

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
          <UploadZone onFiles={handleFiles} />
          {jobs.slice().reverse().map(function (job) {
            return (
              <JobCard
                key={job.id}
                job={job}
                open={openJobId === job.id}
                onToggle={function () {
                  setOpenJobId(openJobId === job.id ? null : job.id)
                }}
                onDeleted={refresh}
              />
            )
          })}
          {openJob && openJob.status === 'done' && (
            <ResultView job={openJob} firebaseReady={firebaseReady} />
          )}
        </div>
      )}

      {tab === 'library' && <LibraryView />}
    </div>
  )
}
