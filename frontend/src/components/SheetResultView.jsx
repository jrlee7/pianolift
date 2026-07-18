import { useEffect, useRef, useState } from 'react'
import {
  fetchSheetMusicXml, resetSheetJob, sheetExportUrl, saveSheetMusicXml
} from '../api.js'

export default function SheetResultView({ job, onChanged }) {
  const containerRef = useRef(null)
  const fileInputRef = useRef(null)
  const osmdRef = useRef(null)
  const [error, setError] = useState(null)
  const [resetting, setResetting] = useState(false)
  const [reuploading, setReuploading] = useState(false)

  useEffect(function () {
    let cancelled = false
    setError(null)
    async function render() {
      try {
        const xml = await fetchSheetMusicXml(job.id)
        if (cancelled) return
        if (!osmdRef.current) {
          const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay')
          if (cancelled) return
          osmdRef.current = new OpenSheetMusicDisplay(containerRef.current, {
            autoResize: true,
            drawingParameters: 'compact',
            backend: 'svg'
          })
        }
        await osmdRef.current.load(xml)
        if (cancelled) return
        osmdRef.current.render()
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not render score')
      }
    }
    render()
    return function () { cancelled = true }
  }, [job.id, job.edited])

  async function handleReset() {
    if (!confirm('Discard edits and restore the auto-suggested marks?')) return
    setResetting(true)
    try {
      await resetSheetJob(job.id)
      if (onChanged) onChanged()
    } catch (err) {
      alert(err.message)
    }
    setResetting(false)
  }

  // Closes the export -> fix in MuseScore -> bring it back loop: swap in a
  // hand-edited MusicXML file as this job's working score.
  async function handleReupload(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setReuploading(true)
    try {
      const text = await file.text()
      await saveSheetMusicXml(job.id, text)
      if (onChanged) onChanged()
    } catch (err) {
      alert(err.message)
    }
    setReuploading(false)
  }

  if (job.status === 'error') {
    return <div className="notice warn">{job.error}</div>
  }

  return (
    <div className="card" style={{ marginTop: -8 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="meta" style={{ margin: 0 }}>
          Pedal and dynamics marks below are auto-suggested — check them
          against your own judgment before performing from this score.
        </span>
        <div className="row" style={{ gap: 8 }}>
          {job.edited && (
            <button className="ghost" disabled={resetting} onClick={handleReset}>
              {resetting ? 'Resetting…' : '↺ Reset to suggested'}
            </button>
          )}
          <button className="ghost" disabled={reuploading}
            onClick={function () { fileInputRef.current.click() }}>
            {reuploading ? 'Uploading…' : '⬆ Re-upload edited file'}
          </button>
          <input
            ref={fileInputRef} type="file" accept=".musicxml,.xml,.mxl" hidden
            onChange={handleReupload}
          />
          <a className="primary" style={{ textDecoration: 'none' }}
            href={sheetExportUrl(job.id)} download>
            ⬇ Export MusicXML
          </a>
        </div>
      </div>
      {error && <div className="notice warn">{error}</div>}
      <div
        ref={containerRef}
        style={{ background: '#fff', borderRadius: 8, padding: 16, overflowX: 'auto' }}
      />
      <div className="meta">
        Need to fine-tune individual marks? Export, open in MuseScore
        (free), fix the marks, then Re-upload edited file above to bring it
        back — in-app editing of individual marks isn't built yet.
      </div>
    </div>
  )
}
