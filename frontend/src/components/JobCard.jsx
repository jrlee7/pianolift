import { deleteJob } from '../api.js'

const STAGE_LABELS = {
  queued: 'Queued…',
  separating: 'Extracting piano from mix (Demucs)…',
  transcribing: 'Transcribing notes, dynamics + pedal…',
  done: 'Ready'
}

export default function JobCard({ job, open, onToggle, onDeleted }) {
  const stageLabel = STAGE_LABELS[job.stage] || job.stage

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

  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={onToggle}>
      <div className="row">
        <h3>{job.name}</h3>
        <div className="row" style={{ gap: 8 }}>
          {job.status === 'done' && (
            <span className="status done">
              ✓ {job.noteCount} notes, {job.pedalCount} pedal events
              {open ? ' — click to close' : ' — click to open'}
            </span>
          )}
          {job.status === 'processing' && (
            <span className="status">{stageLabel} {job.progress}%</span>
          )}
          {job.status === 'error' && (
            <span className="status error">✗ {job.error}</span>
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
            style={{
              width: (job.stage === 'transcribing'
                ? 50 + job.progress / 2
                : job.progress / 2) + '%'
            }}
          />
        </div>
      )}
    </div>
  )
}
