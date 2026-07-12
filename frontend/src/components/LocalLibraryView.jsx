import { useEffect, useMemo, useState } from 'react'
import {
  localList, localDelete, localRename, localMp3Url, localMp3Bytes,
  localLibraryOnDisk
} from '../localLibrary.js'
import { downloadMidiBase64 } from '../firebase.js'

// Windows/FAT-safe filename (mirrors the cloud library's fsSafe).
function fsSafe(name) {
  const cleaned = (name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f&]/g, '_')
    .replace(/[ .]+$/, '').slice(0, 60).replace(/[ .]+$/, '')
  return cleaned || 'song'
}

export default function LocalLibraryView({ onWatch }) {
  const [songs, setSongs] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  const [audio, setAudio] = useState(null) // { id, url }
  const [selected, setSelected] = useState(() => new Set())
  const [copying, setCopying] = useState(null)
  const [copyResult, setCopyResult] = useState(null)

  async function refresh() {
    setLoading(true)
    try { setSongs(await localList()) } finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])
  // Revoke the playing object URL when it changes/unmounts.
  useEffect(() => () => { if (audio && audio.url) URL.revokeObjectURL(audio.url) }, [audio])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return songs.filter((s) => !q || (s.title || '').toLowerCase().includes(q))
  }, [songs, search])

  async function play(song) {
    if (audio && audio.id === song.id) { setAudio(null); return }
    const url = await localMp3Url(song.id)
    if (!url) { alert('No accompaniment MP3 stored for this song.'); return }
    setAudio({ id: song.id, url })
  }

  async function commitRename(song) {
    const title = draft.trim()
    setEditingId(null)
    if (!title || title === song.title) return
    setSongs((prev) => prev.map((s) => (s.id === song.id ? { ...s, title } : s)))
    try { await localRename(song.id, title) } catch (e) { refresh() }
  }

  async function remove(song) {
    if (!confirm('Delete "' + song.title + '" from this computer?')) return
    try { await localDelete(song.id); setSongs((p) => p.filter((s) => s.id !== song.id)) }
    catch (e) { alert(e.message) }
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function copyToUsb() {
    const chosen = songs.filter((s) => selected.has(s.id))
    if (!chosen.length) return
    let write
    if (window.desktop) {
      const dir = await window.desktop.pickFolder().catch(() => null)
      if (!dir) return
      write = (name, bytes) => window.desktop.writeFile(dir, name, bytes)
    } else if (window.showDirectoryPicker) {
      let dir
      try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }) }
      catch (e) { return }
      write = async (name, bytes) => {
        const fh = await dir.getFileHandle(name, { create: true })
        const w = await fh.createWritable(); await w.write(bytes); await w.close()
      }
    } else { alert('Folder picker unavailable in this browser.'); return }

    setCopyResult(null)
    setCopying({ done: 0, total: chosen.length })
    const errors = []
    let done = 0
    for (const song of chosen) {
      const base = fsSafe(song.title)
      try {
        if (song.midiBase64) {
          const bin = atob(song.midiBase64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          await write(base + '.mid', bytes)
        }
        if (song.hasMp3) {
          const mp3 = await localMp3Bytes(song.id)
          if (mp3) await write(base + ' (no piano).mp3', mp3)
        }
      } catch (e) { errors.push(song.title + ' — ' + (e.message || e)) }
      done++
      setCopying({ done, total: chosen.length })
    }
    setCopying(null)
    setCopyResult({ ok: chosen.length - errors.length, total: chosen.length, errors })
    setSelected(new Set())
  }

  async function downloadMp3(song) {
    const url = await localMp3Url(song.id)
    if (!url) { alert('No MP3 stored for this song.'); return }
    const a = document.createElement('a')
    a.href = url; a.download = fsSafe(song.title) + ' (no piano).mp3'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  return (
    <div>
      <div className="notice" style={{ marginTop: 0 }}>
        📁 Your library is stored <strong>on this computer</strong>
        {localLibraryOnDisk ? '' : ' (browser preview: metadata only)'}. Move songs
        here from the Convert tab.
      </div>

      <div className="lib-toolbar">
        <input
          className="url-input lib-search"
          placeholder="Search library…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="meta lib-count">{visible.length} song{visible.length === 1 ? '' : 's'}</span>
      </div>

      {!loading && visible.length > 0 && (
        <div className="lib-select-bar">
          <span className="meta">{selected.size} selected</span>
          <button className="primary" disabled={!selected.size || Boolean(copying)} onClick={copyToUsb}>
            {copying ? 'Copying ' + copying.done + '/' + copying.total + '…'
              : '💾 Copy ' + (selected.size || '') + ' to USB folder…'}
          </button>
        </div>
      )}

      {copyResult && (
        <div className="notice" style={{ borderColor: copyResult.errors.length ? 'var(--red,#c0392b)' : 'var(--green)' }}>
          ✓ Copied <strong>{copyResult.ok}/{copyResult.total}</strong> song{copyResult.total === 1 ? '' : 's'} (.mid + .mp3) to the folder.
          {copyResult.errors.length > 0 && <div style={{ marginTop: 6 }}>Failed: {copyResult.errors.join('; ')}</div>}
        </div>
      )}

      {loading && <div className="meta">Loading…</div>}
      {!loading && songs.length === 0 && (
        <div className="notice">No saved songs yet. Convert a song, then hit “Move to library”.</div>
      )}

      <div className="lib-grid">
        {visible.map((song) => {
          const editing = editingId === song.id
          const isSel = selected.has(song.id)
          return (
            <div className={'card lib-card' + (isSel ? ' lib-card-sel' : '')} key={song.id}>
              <label className="lib-select">
                <input type="checkbox" checked={isSel} onChange={() => toggle(song.id)} />
                <span>Select</span>
              </label>
              <div className="lib-card-head">
                {editing ? (
                  <input
                    className="url-input lib-rename" autoFocus value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitRename(song)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(song); if (e.key === 'Escape') setEditingId(null) }}
                  />
                ) : (
                  <h3 className="lib-title" title="Click to rename"
                    onClick={() => { setEditingId(song.id); setDraft(song.title || '') }}>{song.title}</h3>
                )}
                <div className="meta">
                  {song.noteCount} notes · {song.pedalCount} pedal
                  {song.createdAt ? ' · ' + new Date(song.createdAt).toLocaleDateString() : ''}
                </div>
              </div>
              {audio && audio.id === song.id && (
                <div className="lib-audio"><audio controls autoPlay src={audio.url} /></div>
              )}
              <div className="lib-card-actions">
                <button className="primary" onClick={() => downloadMidiBase64(song.midiBase64, song.title + '.mid')}>⬇ .mid</button>
                {song.hasMp3 && <button className="ghost" onClick={() => downloadMp3(song)}>⬇ .mp3</button>}
                {song.hasMp3 && <button className="ghost" onClick={() => play(song)}>{audio && audio.id === song.id ? '⏸' : '▶'} Play</button>}
                {onWatch && song.midiBase64 && (
                  <button className="ghost" title="Watch the video while the Disklavier plays live" onClick={() => onWatch(song)}>🎬 Watch</button>
                )}
                <button className="ghost" onClick={() => { setEditingId(song.id); setDraft(song.title || '') }}>✎</button>
                <button className="ghost danger" onClick={() => remove(song)}>✕</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
