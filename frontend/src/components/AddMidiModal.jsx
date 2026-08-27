import { useEffect, useRef, useState } from 'react'
import { inspectMidi, getSlotSongs, rewriteSlot } from '../api.js'
import {
  MAX_PIANO_TITLE, sanitizePianoTitle, finalizePianoTitle
} from '../pianoTitle.js'

// Put MIDI files from anywhere — hard drive, a plain USB stick, a download —
// onto a Gotek slot the 1995 Disklavier can play. Each file is decoded to
// note/pedal events and rendered as E-SEQ, the same format converted songs are
// written in, so the piano can't tell the difference.
//
// A floppy image can't be edited in place afterwards (the whole slot is
// rebuilt on every write), so every file is preflighted before anything is
// committed: how many notes survive, how long it runs, and what had to be
// dropped — a drum track, or notes past either end of the 88 keys.

const DISK_CAPACITY = 720 * 1024

let _keySeq = 0
function freshKey() { return 'midi' + (_keySeq++) }

// Strip the directory and extension so "C:\Music\Fur Elise.mid" titles itself.
function baseName(filename) {
  const justFile = filename.split(/[\\/]/).pop() || filename
  return justFile.replace(/\.(mid|midi|smf|kar)$/i, '')
}

function readAsBase64(file) {
  return new Promise(function (resolve, reject) {
    const fr = new FileReader()
    fr.onerror = function () { reject(new Error('Could not read ' + file.name)) }
    fr.onload = function () {
      // readAsDataURL gives "data:<type>;base64,<payload>"
      const s = String(fr.result)
      const comma = s.indexOf(',')
      resolve(comma < 0 ? '' : s.slice(comma + 1))
    }
    fr.readAsDataURL(file)
  })
}

function kb(n) { return (n / 1024).toFixed(1) + ' KB' }

function clock(sec) {
  const s = Math.max(0, Math.round(sec))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

export default function AddMidiModal({ catalog, onClose, onSaved }) {
  const inputRef = useRef(null)
  const [rows, setRows] = useState([])
  const [scanning, setScanning] = useState(0)  // files still being inspected
  const [slot, setSlot] = useState('')
  const [mode, setMode] = useState('append')   // append | replace
  const [existing, setExisting] = useState(null)
  const [existErr, setExistErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const slots = catalog.slots || []

  // Default to the first blank slot so the common "put these somewhere new"
  // case needs no thought; fall back to the first slot on the stick.
  useEffect(function () {
    if (slot !== '' || slots.length === 0) return
    const blank = slots.find(function (s) { return s.blank && !s.error })
    setSlot(String((blank || slots[0]).slot))
  }, [slots, slot])

  // The catalog can be stale (it's scanned once when the tab opens), so read
  // the chosen slot's real contents before offering to merge into it.
  useEffect(function () {
    if (slot === '') return
    let live = true
    setExisting(null)
    setExistErr(null)
    const target = slots.find(function (s) { return String(s.slot) === slot })
    if (target && target.blank) {
      setExisting([])
      return
    }
    getSlotSongs(Number(slot)).then(function (data) {
      if (live) setExisting(data.songs || [])
    }).catch(function (e) { if (live) setExistErr(e.message) })
    return function () { live = false }
  }, [slot, slots])

  async function pick(fileList) {
    const files = []
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i]
      if (/\.(mid|midi|smf|kar)$/i.test(f.name)) files.push(f)
    }
    if (files.length === 0) {
      setErr('Pick MIDI files (.mid or .midi).')
      return
    }
    setErr(null)
    setScanning(function (n) { return n + files.length })
    for (const f of files) {
      const key = freshKey()
      const title = baseName(f.name)
      // Show the row immediately, fill in its stats as the scan lands, so a
      // folder of files doesn't look frozen while they decode one by one.
      setRows(function (prev) {
        return prev.concat([{
          key: key, file: f.name, title: sanitizePianoTitle(title),
          origTitle: title, midiBase64: null, info: null, error: null,
        }])
      })
      try {
        const b64 = await readAsBase64(f)
        const info = await inspectMidi(title, b64)
        setRows(function (prev) {
          return prev.map(function (r) {
            return r.key === key ? Object.assign({}, r, {
              midiBase64: b64, info: info,
              // Prefer the file's own embedded track name only when the
              // filename is a generic dump like "track1".
              title: r.title || sanitizePianoTitle(info.suggestedTitle || ''),
            }) : r
          })
        })
      } catch (e) {
        setRows(function (prev) {
          return prev.map(function (r) {
            return r.key === key ? Object.assign({}, r, { error: e.message }) : r
          })
        })
      } finally {
        setScanning(function (n) { return n - 1 })
      }
    }
  }

  function rename(key, v) {
    const clean = sanitizePianoTitle(v)
    setRows(function (prev) {
      return prev.map(function (r) {
        return r.key === key ? Object.assign({}, r, { title: clean }) : r
      })
    })
  }

  function remove(key) {
    setRows(function (prev) {
      return prev.filter(function (r) { return r.key !== key })
    })
  }

  function move(i, dir) {
    const j = i + dir
    setRows(function (prev) {
      if (j < 0 || j >= prev.length) return prev
      const next = prev.slice()
      const tmp = next[i]; next[i] = next[j]; next[j] = tmp
      return next
    })
  }

  const usable = rows.filter(function (r) {
    return r.midiBase64 && r.info && r.info.noteCount > 0 && !r.error
  })
  const addedBytes = usable.reduce(function (sum, r) {
    return sum + (r.info.eseqBytes || 0)
  }, 0)
  const keeping = mode === 'append' && existing ? existing.length : 0
  const totalSongs = keeping + usable.length
  const target = slots.find(function (s) { return String(s.slot) === slot })
  const targetHasSongs = existing !== null && existing.length > 0

  async function write() {
    setErr(null)
    setBusy(true)
    try {
      const items = []
      if (mode === 'append' && existing) {
        existing.forEach(function (s, i) {
          items.push({ source: 'keep', fromSlot: Number(slot), index: i,
                       title: s.title })
        })
      }
      usable.forEach(function (r) {
        items.push({
          source: 'midi', name: r.origTitle, midiBase64: r.midiBase64,
          title: finalizePianoTitle(r.title, r.origTitle),
        })
      })
      const res = await rewriteSlot(Number(slot), items)
      onSaved(res)
    } catch (e) {
      setErr(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop"
      onClick={function (e) {
        if (e.target === e.currentTarget && !busy) onClose()
      }}>
      <div className="modal-box" style={{ maxWidth: 660 }}>
        <h3 style={{ marginTop: 0 }}>Add MIDI from a folder</h3>
        <p className="meta" style={{ marginTop: 0 }}>
          Pick MIDI files from anywhere — your hard drive, a USB stick, a
          download — and write them onto a floppy slot the piano can play.
          Titles follow the piano's display rules (max {MAX_PIANO_TITLE} chars).
        </p>

        <input ref={inputRef} type="file" multiple hidden
          accept=".mid,.midi,.smf,.kar,audio/midi"
          onChange={function (e) { pick(e.target.files); e.target.value = '' }} />

        <button className={rows.length ? 'ghost' : 'primary'} disabled={busy}
          onClick={function () { inputRef.current.click() }}>
          📂 Choose MIDI files…
        </button>

        {rows.length > 0 && (
          <div style={{ maxHeight: 260, overflowY: 'auto', margin: '10px 0' }}>
            {rows.map(function (r, i) {
              const info = r.info
              const warns = []
              if (info) {
                if (info.droppedDrumNotes) {
                  warns.push(info.droppedDrumNotes + ' drum notes dropped')
                }
                if (info.droppedOutOfRange) {
                  warns.push(info.droppedOutOfRange + ' notes outside the 88 keys')
                }
              }
              return (
                <div key={r.key} style={{ padding: '5px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="meta" style={{ width: 24, textAlign: 'right' }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <button className="ghost" disabled={busy || i === 0}
                      title="Move up"
                      onClick={function () { move(i, -1) }}>▲</button>
                    <button className="ghost"
                      disabled={busy || i === rows.length - 1}
                      title="Move down"
                      onClick={function () { move(i, 1) }}>▼</button>
                    <input type="text" value={r.title} disabled={busy}
                      style={{ flex: 1, fontFamily: 'monospace' }}
                      maxLength={MAX_PIANO_TITLE}
                      onChange={function (e) { rename(r.key, e.target.value) }} />
                    <button className="ghost" disabled={busy} title="Remove"
                      onClick={function () { remove(r.key) }}>🗑</button>
                  </div>
                  <div className="meta" style={{ paddingLeft: 30, fontSize: 12 }}>
                    {r.error
                      ? <span style={{ color: 'var(--red)' }}>{r.error}</span>
                      : !info
                        ? 'reading…'
                        : info.noteCount === 0
                          ? <span style={{ color: 'var(--red)' }}>
                              no playable piano notes — this file won't be added
                            </span>
                          : (info.noteCount + ' notes · ' + clock(info.durationSec)
                             + ' · ' + kb(info.eseqBytes)
                             + (warns.length ? ' · ' + warns.join(', ') : ''))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {scanning > 0 && (
          <div className="meta">Reading {scanning} more file{scanning === 1 ? '' : 's'}…</div>
        )}

        {rows.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                          marginTop: 10 }}>
              <label style={{ margin: 0 }}>Write to</label>
              <select value={slot} disabled={busy}
                onChange={function (e) { setSlot(e.target.value) }}>
                {slots.map(function (s) {
                  return (
                    <option key={s.slot} value={String(s.slot)}>
                      {'Slot ' + s.slot + (s.error
                        ? ' — unreadable'
                        : s.blank
                          ? ' — empty'
                          : ' — ' + s.songs.length + ' song'
                            + (s.songs.length === 1 ? '' : 's'))}
                    </option>
                  )
                })}
              </select>
              {existing === null && !existErr && slot !== '' && (
                <span className="meta">reading slot…</span>
              )}
            </div>

            {existErr && (
              <div className="notice warn" style={{ marginTop: 8 }}>
                Could not read slot {slot}: {existErr}
              </div>
            )}

            {targetHasSongs && (
              <div style={{ marginTop: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6,
                                margin: 0 }}>
                  <input type="radio" checked={mode === 'append'} disabled={busy}
                    onChange={function () { setMode('append') }} />
                  <span>
                    Add to the {existing.length} song
                    {existing.length === 1 ? '' : 's'} already on this slot
                  </span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6,
                                margin: 0 }}>
                  <input type="radio" checked={mode === 'replace'} disabled={busy}
                    onChange={function () { setMode('replace') }} />
                  <span>Replace everything on this slot</span>
                </label>
              </div>
            )}

            {target && target.error && (
              <div className="notice warn" style={{ marginTop: 8 }}>
                Slot {slot} is unreadable. Writing to it replaces whatever is
                there with just these files.
              </div>
            )}

            <div className="meta" style={{ marginTop: 8 }}>
              {totalSongs} song{totalSongs === 1 ? '' : 's'} on the floppy
              afterwards · {kb(addedBytes)} added
              {addedBytes > DISK_CAPACITY && (
                <span style={{ color: 'var(--red)' }}>
                  {' '}— too big for one 720 KB floppy, remove some
                </span>
              )}
            </div>
          </>
        )}

        {err && <div className="notice warn" style={{ marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end',
                      marginTop: 14 }}>
          <button disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary" onClick={write}
            disabled={busy || scanning > 0 || usable.length === 0
                      || slot === '' || existing === null}>
            {busy
              ? 'Writing…'
              : '💿 Write ' + usable.length + ' song'
                + (usable.length === 1 ? '' : 's') + ' to slot ' + slot}
          </button>
        </div>
      </div>
    </div>
  )
}
