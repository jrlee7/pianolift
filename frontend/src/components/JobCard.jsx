import { deleteJob } from '../api.js'

const STAGE_LABELS = {
  queued: 'Queued…',
  downloading: 'Downloading audio from link…',
  separating: 'Extracting piano from mix (BS-Roformer-SW)…',
  encoding: 'Encoding piano-less accompaniment MP3…',
  transcribing: 'Transcribing notes, dynamics + pedal…',
  done: 'Ready'
}

// each stage owns a slice of the overall progress bar
const STAGE_SPAN = {
  queued: [0, 0],
  downloading: [0, 15],
  separating: [15, 50],
  encoding: [50, 55],
  transcribing: [55, 100]
}

function barWidth(stage, progress) {
  const span = STAGE_SPAN[stage]
  if (!span) return progress
  return span[0] + (span[1] - span[0]) * progress / 100
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
