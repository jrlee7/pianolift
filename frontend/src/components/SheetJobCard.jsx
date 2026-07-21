import { deleteSheetJob } from '../api.js'

export default function SheetJobCard({ job, open, onToggle, onDeleted }) {
  async function handleDelete(e) {
    e.stopPropagation()
    if (!confirm('Delete "' + job.name + '"?')) return
    try {
      await deleteSheetJob(job.id)
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
              ✓ {job.pedalCount} pedal mark{job.pedalCount === 1 ? '' : 's'},
              {' '}{job.dynamicsCount} dynamics mark{job.dynamicsCount === 1 ? '' : 's'}
              {job.edited ? ' (edited)' : ''}
              {job.warnings && job.warnings.length > 0
                ? ' — ⚠ ' + job.warnings.length + ' warning'
                  + (job.warnings.length === 1 ? '' : 's') : ''}
              {open ? ' — click to close' : ' — click to open'}
            </span>
          )}
          {job.status === 'processing' && (
            <span className="status">
              {job.stage
                ? 'Recognizing PDF… (' + job.stage.replace('recognizing ', '') + ')'
                : 'Recognizing PDF… (can take a minute or more)'}
            </span>
          )}
          {job.status === 'error' && (
            <span className="status error">✗ {job.error}</span>
          )}
          <button className="ghost danger" onClick={handleDelete}>✕</button>
        </div>
      </div>
    </div>
  )
}
