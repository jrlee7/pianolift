import { useEffect, useState } from 'react'
import { getSlotSongs, rewriteSlot } from '../api.js'
import {
  MAX_PIANO_TITLE, sanitizePianoTitle, finalizePianoTitle
} from '../pianoTitle.js'

// Full control over one Gotek slot's songs. A slot is one floppy that can hold
// many songs; this reorders, renames and deletes them, and adds songs in from
// other slots, this session's conversions, or the library. On save the whole
// slot is rebuilt from the edited list — kept songs are re-extracted losslessly
// (no re-transcode), added songs are rendered fresh.
//
// Each row is tagged by `kind` and carries whatever the backend needs to
// produce that song:
//   keep    -> { fromSlot, index }   pull the exact .FIL back off a slot
//   job     -> { jobId }             render a converted job
//   library -> { name, midiBase64, settings }
// plus an editable piano `title` and its `origTitle` fallback.
let _keySeq = 0
function freshKey() { return 'row' + (_keySeq++) }

export default function SlotEditorModal({
  slot, catalog, jobs, loadLibrary, onClose, onSaved
}) {
  const [rows, setRows] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [adding, setAdding] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [moving, setMoving] = useState(null) // row index being moved, or null

  useEffect(function () {
    let live = true
    getSlotSongs(slot).then(function (data) {
      if (!live) return
      setRows(data.songs.map(function (s, i) {
        return row('keep', { fromSlot: slot, index: i }, s.title)
      }))
    }).catch(function (e) { if (live) setLoadErr(e.message) })
    return function () { live = false }
  }, [slot])

  function row(kind, ref, title) {
    return {
      key: freshKey(), kind: kind, ref: ref,
      title: sanitizePianoTitle(title), origTitle: title,
    }
  }

  function mutate(fn) {
    setRows(function (prev) { return fn(prev.slice()) })
    setDirty(true)
  }

  function move(i, dir) {
    const j = i + dir
    mutate(function (next) {
      if (j < 0 || j >= next.length) return next
      const tmp = next[i]; next[i] = next[j]; next[j] = tmp
      return next
    })
  }

  function remove(i) {
    mutate(function (next) { next.splice(i, 1); return next })
  }

  function rename(i, v) {
    const clean = sanitizePianoTitle(v)
    mutate(function (next) {
      next[i] = Object.assign({}, next[i], { title: clean })
      return next
    })
  }

  function addRows(newRows) {
    mutate(function (next) { return next.concat(newRows) })
    setAdding(false)
  }

  async function save() {
    setErr(null)
    setBusy(true)
    try {
      const songs = rows.map(function (r) {
        const title = finalizePianoTitle(r.title, r.origTitle)
        if (r.kind === 'keep') {
          return { source: 'keep', fromSlot: r.ref.fromSlot,
                   index: r.ref.index, title: title }
        }
        if (r.kind === 'job') {
          return { source: 'job', jobId: r.ref.jobId, title: title }
        }
        return { source: 'library', name: r.ref.name,
                 midiBase64: r.ref.midiBase64, settings: r.ref.settings,
                 title: title }
      })
      await rewriteSlot(slot, songs)
      onSaved()
    } catch (e) {
      setErr(e.message)
      setBusy(false)
    }
  }

  // Move one song to another slot: write the target (its songs + the moved one)
  // then rewrite this slot without it. Two writes, target first so the song is
  // safely on the destination before it leaves the origin. Requires a clean
  // (saved) list so origin indices still line up with what's on the floppy.
  async function doMove(rowIdx, target) {
    setErr(null)
    setBusy(true)
    try {
      const song = rows[rowIdx]
      const t = await getSlotSongs(target)
      const tgtItems = t.songs.map(function (s, j) {
        return { source: 'keep', fromSlot: target, index: j, title: s.title }
      })
      tgtItems.push({
        source: 'keep', fromSlot: slot, index: song.ref.index,
        title: finalizePianoTitle(song.title, song.origTitle),
      })
      await rewriteSlot(target, tgtItems)
      const originItems = rows
        .filter(function (_r, k) { return k !== rowIdx })
        .map(function (r) {
          return { source: 'keep', fromSlot: slot, index: r.ref.index,
                   title: finalizePianoTitle(r.title, r.origTitle) }
        })
      await rewriteSlot(slot, originItems)
      onSaved()
    } catch (e) {
      setErr(e.message)
      setBusy(false)
      setMoving(null)
    }
  }

  const emptying = rows && rows.length === 0
  const badgeText = {
    job: '🎵 new', library: '📚 new',
  }

  return (
    <div className="modal-backdrop"
      onClick={function (e) {
        if (e.target === e.currentTarget && !busy) onClose()
      }}>
      <div className="modal-box" style={{ maxWidth: 640 }}>
        <h3 style={{ marginTop: 0 }}>Edit slot {slot}</h3>

        {loadErr && <div className="notice warn">{loadErr}</div>}
        {!rows && !loadErr && (
          <div className="notice">Reading slot {slot}… decoding the floppy.</div>
        )}

        {rows && (
          <>
            <p className="meta" style={{ marginTop: 0 }}>
              {rows.length} song{rows.length === 1 ? '' : 's'} on this floppy, in
              play order. Reorder, rename or remove them, or add songs from
              another slot, your conversions or the library. Titles follow the
              piano's display rules (max {MAX_PIANO_TITLE} chars).
            </p>

            <div style={{ maxHeight: 320, overflowY: 'auto', margin: '10px 0' }}>
              {rows.map(function (r, i) {
                const fromOther = r.kind === 'keep' && r.ref.fromSlot !== slot
                return (
                  <div key={r.key} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '4px 0'
                  }}>
                    <span className="meta" style={{ width: 24, textAlign: 'right' }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <button className="ghost" disabled={busy || i === 0}
                      title="Move up" onClick={function () { move(i, -1) }}>▲</button>
                    <button className="ghost" disabled={busy || i === rows.length - 1}
                      title="Move down" onClick={function () { move(i, 1) }}>▼</button>
                    <input type="text" value={r.title} disabled={busy}
                      style={{ flex: 1, fontFamily: 'monospace' }}
                      maxLength={MAX_PIANO_TITLE}
                      onChange={function (e) { rename(i, e.target.value) }} />
                    {fromOther && (
                      <span className="meta" title={'copied from slot ' + r.ref.fromSlot}>
                        ⤵{r.ref.fromSlot}
                      </span>
                    )}
                    {badgeText[r.kind] && (
                      <span className="meta" title="added, rendered on save">
                        {badgeText[r.kind]}
                      </span>
                    )}
                    <button className="ghost"
                      disabled={busy || dirty}
                      title={dirty
                        ? 'Save your changes first, then move'
                        : 'Move this song to another slot'}
                      onClick={function () { setMoving(i) }}>⇄</button>
                    <button className="ghost" disabled={busy} title="Remove"
                      onClick={function () { remove(i) }}>🗑</button>
                  </div>
                )
              })}
              {emptying && (
                <div className="notice warn">
                  No songs left — saving now clears slot {slot} back to blank.
                </div>
              )}
            </div>

            <button className="ghost" disabled={busy}
              onClick={function () { setAdding(true) }}>
              ＋ Add songs…
            </button>
          </>
        )}

        {err && <div className="notice warn" style={{ marginTop: 10 }}>{err}</div>}

        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14
        }}>
          <button disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !rows || !dirty}
            onClick={save}>
            {busy ? 'Writing…' : '💾 Save to slot ' + slot}
          </button>
        </div>

        {adding && (
          <AddSongsPicker slot={slot} catalog={catalog} jobs={jobs}
            loadLibrary={loadLibrary} makeRow={row}
            onCancel={function () { setAdding(false) }}
            onAdd={addRows} />
        )}

        {moving !== null && rows && (
          <MoveToSlotPicker slot={slot} catalog={catalog}
            song={rows[moving]}
            onCancel={function () { if (!busy) setMoving(null) }}
            onMove={function (target) { doMove(moving, target) }} />
        )}
      </div>
    </div>
  )
}

// Pick the destination slot for a song being moved out of the current one.
// Any other slot on the stick is a valid target — including blank ones.
function MoveToSlotPicker({ slot, catalog, song, onCancel, onMove }) {
  const targets = (catalog.slots || []).filter(function (s) {
    return s.slot !== slot && !s.error
  })
  return (
    <div className="modal-backdrop"
      onClick={function (e) { if (e.target === e.currentTarget) onCancel() }}>
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <h3 style={{ marginTop: 0 }}>Move “{song.title}” to…</h3>
        <p className="meta" style={{ marginTop: 0 }}>
          It leaves slot {slot} and is appended to the slot you pick.
        </p>
        <div style={{ maxHeight: 320, overflowY: 'auto', margin: '8px 0' }}>
          {targets.length === 0
            ? <div className="notice">No other slots on this stick.</div>
            : targets.map(function (s) {
              return (
                <button key={s.slot} className="ghost"
                  style={{ display: 'block', width: '100%', textAlign: 'left',
                           padding: '6px 8px' }}
                  onClick={function () { onMove(s.slot) }}>
                  <strong>Slot {s.slot}</strong>{' '}
                  <span className="meta">
                    {s.blank
                      ? '— empty'
                      : '— ' + s.songs.length + ' song'
                        + (s.songs.length === 1 ? '' : 's')}
                  </span>
                </button>
              )
            })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Add songs from three sources: other slots on the stick, this session's
// converted jobs, or the saved library. Everything is picked into one basket
// and appended to the slot in the order it was ticked.
function AddSongsPicker({
  slot, catalog, jobs, loadLibrary, makeRow, onCancel, onAdd
}) {
  const [source, setSource] = useState('slots')
  const [pick, setPick] = useState(function () { return [] }) // ordered rows
  const [library, setLibrary] = useState(null)
  const [libErr, setLibErr] = useState(null)
  const [libLoading, setLibLoading] = useState(false)

  const slotSources = (catalog.slots || []).filter(function (s) {
    return s.slot !== slot && !s.blank && !s.error && s.songs.length
  })
  const jobSources = (jobs || []).filter(function (j) {
    return j.status === 'done'
  })

  useEffect(function () {
    if (source !== 'library' || library !== null || !loadLibrary) return
    setLibLoading(true)
    Promise.resolve(loadLibrary()).then(function (items) {
      setLibrary((items || []).filter(function (s) { return s.midiBase64 }))
    }).catch(function (e) { setLibErr(e.message) })
      .finally(function () { setLibLoading(false) })
  }, [source, library, loadLibrary])

  function has(key) { return pick.some(function (p) { return p.key === key }) }

  function toggle(key, makeRowFn) {
    setPick(function (prev) {
      if (prev.some(function (p) { return p.key === key })) {
        return prev.filter(function (p) { return p.key !== key })
      }
      return prev.concat([{ key: key, build: makeRowFn }])
    })
  }

  function confirm() {
    onAdd(pick.map(function (p) { return p.build() }))
  }

  const tab = function (id, label) {
    return (
      <button className={source === id ? 'primary' : 'ghost'}
        onClick={function () { setSource(id) }}>{label}</button>
    )
  }

  return (
    <div className="modal-backdrop"
      onClick={function (e) { if (e.target === e.currentTarget) onCancel() }}>
      <div className="modal-box" style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>Add songs to slot {slot}</h3>

        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {tab('slots', 'Other slots')}
          {tab('jobs', 'Conversions')}
          {tab('library', 'Library')}
        </div>

        <div style={{ maxHeight: 340, overflowY: 'auto' }}>
          {source === 'slots' && (
            slotSources.length === 0
              ? <div className="notice">No other slots hold songs to copy.</div>
              : slotSources.map(function (s) {
                return (
                  <div key={s.slot} style={{ marginBottom: 10 }}>
                    <div className="meta" style={{ fontWeight: 600 }}>Slot {s.slot}</div>
                    {s.songs.map(function (song, i) {
                      const key = 'slot:' + s.slot + ':' + i
                      return (
                        <Pick key={key} label={song.title} checked={has(key)}
                          onToggle={function () {
                            toggle(key, function () {
                              return makeRow('keep',
                                { fromSlot: s.slot, index: i }, song.title)
                            })
                          }} />
                      )
                    })}
                  </div>
                )
              })
          )}

          {source === 'jobs' && (
            jobSources.length === 0
              ? <div className="notice">No finished conversions this session.</div>
              : jobSources.map(function (j) {
                const key = 'job:' + j.id
                return (
                  <Pick key={key} label={j.name} checked={has(key)}
                    onToggle={function () {
                      toggle(key, function () {
                        return makeRow('job', { jobId: j.id }, j.name || 'Song')
                      })
                    }} />
                )
              })
          )}

          {source === 'library' && (
            libErr ? <div className="notice warn">{libErr}</div>
              : libLoading || library === null
                ? <div className="notice">Loading library…</div>
                : library.length === 0
                  ? <div className="notice">No library songs with stored MIDI.</div>
                  : library.map(function (s) {
                    const key = 'lib:' + s.id
                    return (
                      <Pick key={key} label={s.title} checked={has(key)}
                        onToggle={function () {
                          toggle(key, function () {
                            return makeRow('library', {
                              name: s.title, midiBase64: s.midiBase64,
                              settings: s.settings,
                            }, s.title)
                          })
                        }} />
                    )
                  })
          )}
        </div>

        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12
        }}>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={pick.length === 0}
            onClick={confirm}>
            Add {pick.length || ''} song{pick.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Pick({ label, checked, onToggle }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', margin: 0
    }}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span>{label}</span>
    </label>
  )
}
