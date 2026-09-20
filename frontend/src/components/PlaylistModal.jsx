import { useState } from 'react'

// Shown when a pasted link resolves to a playlist — offers to convert every
// video on it as its own song, instead of making the user paste each URL by
// hand. `hasSingle` is true when the link also names one video (a
// watch?v=…&list=… link), so we can offer "just this one video" too.
export default function PlaylistModal({ title, entries, hasSingle, remainingCredits, onConfirm, onSingle, onCancel }) {
  const [checked, setChecked] = useState(function () {
    return entries.map(function () { return true })
  })
  const [busy, setBusy] = useState(false)

  function toggle(i) {
    setChecked(function (prev) {
      const next = prev.slice()
      next[i] = !next[i]
      return next
    })
  }

  function setAll(on) {
    setChecked(entries.map(function () { return on }))
  }

  const selectedCount = checked.filter(Boolean).length

  async function confirmAll() {
    setBusy(true)
    const selected = entries.filter(function (_, i) { return checked[i] })
    await onConfirm(selected)
  }

  async function confirmSingle() {
    setBusy(true)
    await onSingle()
  }

  return (
    <div className="modal-backdrop" onClick={function (e) { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div className="modal-box" style={{ maxWidth: 520 }}>
        <h3 style={{ marginTop: 0 }}>{title || 'Playlist'}</h3>
        <p className="meta">
          This link is a playlist with {entries.length} video
          {entries.length === 1 ? '' : 's'}. Convert each one as its own song?
          Each takes a few minutes.
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
        <div className="meta" style={{ display: 'flex', gap: 12, margin: '4px 0' }}>
          <a href="#" onClick={function (e) { e.preventDefault(); if (!busy) setAll(true) }}>Select all</a>
          <a href="#" onClick={function (e) { e.preventDefault(); if (!busy) setAll(false) }}>Select none</a>
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto', margin: '12px 0' }}>
          {entries.map(function (e, i) {
            return (
              <div key={i} className="check" style={{ padding: '4px 0' }}>
                <input
                  id={'pl-' + i}
                  type="checkbox"
                  checked={checked[i]}
                  disabled={busy}
                  onChange={function () { toggle(i) }}
                />
                <label htmlFor={'pl-' + i} style={{ margin: 0, flex: 1 }}>
                  <span className="meta" style={{ marginRight: 8 }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {e.title || e.url}
                </label>
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={onCancel}>Cancel</button>
          {hasSingle && (
            <button disabled={busy} onClick={confirmSingle}>Just this one video</button>
          )}
          <button className="primary" disabled={busy || selectedCount === 0} onClick={confirmAll}>
            {busy ? 'Starting…' : 'Convert ' + selectedCount + ' video' + (selectedCount === 1 ? '' : 's')}
          </button>
        </div>
      </div>
    </div>
  )
}
