import { useState } from 'react'

function fmt(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m + ':' + String(s).padStart(2, '0')
}

// Shown when a pasted link's video carries chapter markers (an album
// uploaded as one file, chaptered by track) — offers to convert each
// chapter as its own song instead of one giant file.
export default function ChapterSplitModal({ title, chapters, remainingCredits, onConfirm, onSingle, onCancel }) {
  const [checked, setChecked] = useState(function () {
    return chapters.map(function () { return true })
  })
  const [busy, setBusy] = useState(false)

  function toggle(i) {
    setChecked(function (prev) {
      const next = prev.slice()
      next[i] = !next[i]
      return next
    })
  }

  const selectedCount = checked.filter(Boolean).length

  async function confirmSplit() {
    setBusy(true)
    const selected = chapters.filter(function (_, i) { return checked[i] })
    await onConfirm(selected)
  }

  async function confirmSingle() {
    setBusy(true)
    await onSingle()
  }

  return (
    <div className="modal-backdrop" onClick={function (e) { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div className="modal-box" style={{ maxWidth: 520 }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p className="meta">
          This video has {chapters.length} chapter markers — looks like an album.
          Convert each chapter as its own song?
        </p>
        {remainingCredits !== null && remainingCredits !== undefined && (
          <p className="meta" style={{
            color: selectedCount > remainingCredits ? '#c0392b' : undefined,
            fontWeight: selectedCount > remainingCredits ? 600 : undefined
          }}>
            {remainingCredits <= 0
              ? 'Free tier used up — activate to convert any more songs.'
              : selectedCount > remainingCredits
                ? 'Only ' + remainingCredits + ' free conversion' + (remainingCredits === 1 ? '' : 's')
                  + ' left — the batch will stop partway and prompt you to activate.'
                : remainingCredits + ' free conversion' + (remainingCredits === 1 ? '' : 's') + ' left.'}
          </p>
        )}
        <div style={{ maxHeight: 320, overflowY: 'auto', margin: '12px 0' }}>
          {chapters.map(function (ch, i) {
            return (
              <div key={i} className="check" style={{ padding: '4px 0' }}>
                <input
                  id={'ch-' + i}
                  type="checkbox"
                  checked={checked[i]}
                  disabled={busy}
                  onChange={function () { toggle(i) }}
                />
                <label htmlFor={'ch-' + i} style={{ margin: 0, flex: 1 }}>
                  {ch.title || ('Track ' + (i + 1))}
                  <span className="meta" style={{ marginLeft: 8 }}>
                    {fmt(ch.start)}–{fmt(ch.end)}
                  </span>
                </label>
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={onCancel}>Cancel</button>
          <button disabled={busy} onClick={confirmSingle}>Convert as one file</button>
          <button className="primary" disabled={busy || selectedCount === 0} onClick={confirmSplit}>
            {busy ? 'Starting…' : 'Split into ' + selectedCount + ' track' + (selectedCount === 1 ? '' : 's')}
          </button>
        </div>
      </div>
    </div>
  )
}
