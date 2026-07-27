import { useState } from 'react'
import {
  MAX_PIANO_TITLE, sanitizePianoTitle, finalizePianoTitle
} from '../pianoTitle.js'

// Last stop before an .hfe is written: rename each song the way it should read
// on the piano's screen, and (when writing to the stick) pick the slot. Every
// keystroke is run through the piano's own title rules so the box always shows
// exactly what the 1995 Disklavier will display — max 32 chars, printable
// ASCII only, no double spaces.
export default function DiskTitlesModal({ items, mode, onCancel, onConfirm }) {
  const [titles, setTitles] = useState(function () {
    return items.map(function (it) { return sanitizePianoTitle(it.title) })
  })
  const [slot, setSlot] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  function setOne(i, v) {
    const clean = sanitizePianoTitle(v)
    setTitles(function (prev) {
      const next = prev.slice()
      next[i] = clean
      return next
    })
  }

  async function confirm() {
    const clean = titles.map(function (t, i) {
      return finalizePianoTitle(t, items[i].title)
    })
    let n = null
    if (mode === 'write') {
      const t = slot.trim()
      if (t !== '') {
        n = parseInt(t, 10)
        if (Number.isNaN(n) || n < 0 || n > 999) {
          setErr('Slot must be a number 0–999 (or blank for the next free slot).')
          return
        }
      }
    }
    setErr(null)
    setBusy(true)
    try {
      await onConfirm({ titles: clean, slot: n })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop"
      onClick={function (e) { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div className="modal-box" style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>
          {mode === 'write' ? 'Write floppy' : 'Download floppy image'}
        </h3>
        <p className="meta">
          {items.length} song{items.length === 1 ? '' : 's'} on one disk, in this
          play order. These titles are what the piano's screen shows — capped at{' '}
          {MAX_PIANO_TITLE} characters, plain letters/numbers/punctuation only.
          Anything the display can't render is dropped as you type.
        </p>
        <div style={{ maxHeight: 340, overflowY: 'auto', margin: '12px 0' }}>
          {items.map(function (it, i) {
            return (
              <div key={it.key} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0'
              }}>
                <span className="meta" style={{ width: 26, textAlign: 'right' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <input type="text" value={titles[i]} disabled={busy}
                  style={{ flex: 1, fontFamily: 'monospace' }}
                  maxLength={MAX_PIANO_TITLE}
                  onChange={function (e) { setOne(i, e.target.value) }} />
                <span className="meta" style={{ width: 44, textAlign: 'right' }}>
                  {titles[i].length}/{MAX_PIANO_TITLE}
                </span>
              </div>
            )
          })}
        </div>
        {mode === 'write' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ margin: 0 }}>Gotek slot</label>
            <input type="text" value={slot} disabled={busy} style={{ width: 90 }}
              placeholder="next free"
              onChange={function (e) { setSlot(e.target.value) }} />
            <span className="meta">Blank = next free slot.</span>
          </div>
        )}
        {err && <div className="notice warn" style={{ marginTop: 10 }}>{err}</div>}
        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14
        }}>
          <button disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={busy} onClick={confirm}>
            {busy
              ? 'Building…'
              : (mode === 'write' ? '💿 Write disk' : '⬇ Build .hfe')}
          </button>
        </div>
      </div>
    </div>
  )
}
