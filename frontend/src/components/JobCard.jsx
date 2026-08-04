import { useState } from 'react'
import { deleteJob, verifyJob, renameJob } from '../api.js'

const STAGE_LABELS = {
  queued: 'Queued…',
  downloading: 'Downloading audio from link…',
  separating: 'Extracting piano from mix (BS-Roformer-SW)…',
  encoding: 'Encoding piano-less accompaniment MP3…',
  transcribing: 'Transcribing notes, dynamics + pedal…',
  verifying: 'Checking notes against the audio…',
  done: 'Ready'
}

// each stage owns a slice of the overall progress bar
const STAGE_SPAN = {
  queued: [0, 0],
  downloading: [0, 15],
  separating: [15, 50],
  encoding: [50, 55],
  transcribing: [55, 92],
  verifying: [92, 100]
}

function barWidth(stage, progress) {
  const span = STAGE_SPAN[stage]
  if (!span) return progress
  return span[0] + (span[1] - span[0]) * progress / 100
}

export default function JobCard({ job, open, onToggle, onDeleted, onCleaned, onRenamed, selected, onSelectToggle }) {
  const stageLabel = STAGE_LABELS[job.stage] || job.stage
  const [cleaning, setCleaning] = useState(false)
  // Inline rename of the song title (what the library, USB copy and — unless
  // overridden in the disk dialog — the piano's screen use). Only finished
  // jobs; a title while still transcribing would be overwritten by the pipeline.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function startRename(e) {
    e.stopPropagation()
    setDraft(job.name || '')
    setEditing(true)
  }

  async function commitRename() {
    const name = draft.trim()
    setEditing(false)
    if (!name || name === job.name) return
    try {
      await renameJob(job.id, name)
      if (onRenamed) onRenamed()
    } catch (err) {
      alert('Rename failed: ' + err.message)
    }
  }
  // Songs converted before the pipeline verified notes against the audio
  // can have it run retroactively — needs the piano stem on disk, so
  // library imports (MIDI only) don't qualify.
  const canClean = job.status === 'done' && job.pianoStem && !job.verified

  async function handleClean(e) {
    e.stopPropagation()
    setCleaning(true)
    try {
      const r = await verifyJob(job.id)
      alert('Removed ' + r.ghostCount + ' ghost note' + (r.ghostCount === 1 ? '' : 's')
        + ', trimmed ' + r.trimmedCount + ' over-held note ending' + (r.trimmedCount === 1 ? '' : 's')
        + '. Reset to original in the editor undoes this.')
      if (onCleaned) onCleaned()
    } catch (err) {
      alert(err.message)
    }
    setCleaning(false)
  }

  async function handleDelete(e) {
    e.stopPropagation()
    if (!confirm('Delete "' + job.name + '"?')) return
    try {
      await deleteJob(job.id)
      onDeleted()
    } catch (err) {
      alert(err.message)
    }
  }

  async function handleCancel(e) {
    e.stopPropagation()
    const verb = job.stage === 'queued' ? 'queued' : 'in-progress'
    if (!confirm('Cancel ' + verb + ' "' + job.name + '"?')) return
    try {
      await deleteJob(job.id)
      onDeleted()
    } catch (err) {
      alert(err.message)
    }
  }

  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={onToggle}>
      <div className="row">
        {job.status === 'done' && onSelectToggle && (
          <input
            type="checkbox"
            className="job-select"
            checked={!!selected}
            title="Select for bulk copy / move. Shift-click to select a range."
            // onClick carries shiftKey (onChange doesn't); it drives selection,
            // so onChange is a no-op that just silences React's controlled-input
            // warning. stopPropagation keeps the card from toggling open.
            onClick={function (e) {
              e.stopPropagation()
              onSelectToggle(job.id, e.shiftKey)
            }}
            onChange={function () {}}
          />
        )}
        {editing ? (
          <input
            className="url-input lib-rename"
            autoFocus
            value={draft}
            onClick={function (e) { e.stopPropagation() }}
            onChange={function (e) { setDraft(e.target.value) }}
            onBlur={commitRename}
            onKeyDown={function (e) {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : job.status === 'done' ? (
          <h3 className="lib-title" title="Click to rename"
            onClick={startRename}>{job.name}</h3>
        ) : (
          <h3>{job.name}</h3>
        )}
        <div className="row" style={{ gap: 8 }}>
          {job.status === 'done' && (
            <span className="status done">
              ✓ {job.noteCount} notes
              {job.ghostCount > 0 && ` (${job.ghostCount} ghost${job.ghostCount === 1 ? '' : 's'} removed)`}
              , {job.pedalCount} pedal events
              {open ? ' — click to close' : ' — click to open'}
            </span>
          )}
          {job.status === 'processing' && (
            <span className="status">{stageLabel} {job.progress}%</span>
          )}
          {job.status === 'error' && (
            <span className="status error">✗ {job.error}</span>
          )}
          {canClean && (
            <button className="ghost" disabled={cleaning} onClick={handleClean}>
              {cleaning ? 'Cleaning…' : '✨ Clean up'}
            </button>
          )}
          {job.status === 'processing' && (
            <button className="ghost danger" onClick={handleCancel}>Cancel</button>
          )}
          {job.status !== 'processing' && (
            <button className="ghost danger" onClick={handleDelete}>✕</button>
          )}
        </div>
      </div>
      {job.status === 'processing' && (
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{ width: barWidth(job.stage, job.progress) + '%' }}
          />
        </div>
      )}
    </div>
  )
}
