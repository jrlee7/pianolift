import { useEffect, useMemo, useState } from 'react'
import {
  firebaseReady, listSongs, deleteSong, renameSong, downloadMidiBase64,
  listFolders, createFolder, deleteFolder, setSongFolder
} from '../firebase.js'
import { importFromLibrary } from '../api.js'

function millis(song) {
  return song.createdAt && song.createdAt.toMillis ? song.createdAt.toMillis() : 0
}

// Strip characters Windows/FAT (USB stick) filesystems reject.
function fsSafe(name) {
  const cleaned = (name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/, '')
  return cleaned || 'song'
}

function b64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function writeInto(dir, filename, data) {
  const fh = await dir.getFileHandle(filename, { create: true })
  const w = await fh.createWritable()
  await w.write(data)
  await w.close()
}

export default function LibraryView({ onEdit }) {
  const [songs, setSongs] = useState([])
  const [importingId, setImportingId] = useState(null)
  const [folders, setFolders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [folderError, setFolderError] = useState(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('new')
  const [active, setActive] = useState('all') // 'all' | 'unfiled' | folder name
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  const [newFolder, setNewFolder] = useState(null) // null = closed, '' = typing
  const [selected, setSelected] = useState(function () { return new Set() })
  const [copying, setCopying] = useState(null) // null | { done, total }
  const [copyResult, setCopyResult] = useState(null)

  async function refresh() {
    setLoading(true)
    try {
      const items = await listSongs()
      setSongs(items)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
    // Folders are best-effort: if the Firestore rules haven't been updated to
    // allow the `folders` collection yet, songs must still render.
    try {
      setFolders(await listFolders())
      setFolderError(null)
    } catch (e) {
      setFolderError(e.message)
    }
  }

  useEffect(function () {
    refresh()
  }, [])

  const folderNames = useMemo(function () {
    return folders.map(function (f) { return f.name })
  }, [folders])

  // count per folder key for the chip badges
  const counts = useMemo(function () {
    const c = { all: songs.length, unfiled: 0 }
    songs.forEach(function (s) {
      if (!s.folder) c.unfiled++
      else c[s.folder] = (c[s.folder] || 0) + 1
    })
    return c
  }, [songs])

  const visible = useMemo(function () {
    const q = search.trim().toLowerCase()
    const list = songs.filter(function (s) {
      if (active === 'unfiled' && s.folder) return false
      if (active !== 'all' && active !== 'unfiled' && s.folder !== active) return false
      return !q || (s.title || '').toLowerCase().includes(q)
    })
    list.sort(function (a, b) {
      if (sort === 'title') return (a.title || '').localeCompare(b.title || '')
      if (sort === 'old') return millis(a) - millis(b)
      return millis(b) - millis(a) // 'new'
    })
    return list
  }, [songs, search, sort, active])

  if (!firebaseReady) {
    return (
      <div className="notice warn">
        Firebase not configured. Copy <code>.env.example</code> to <code>.env</code> in
        frontend/ and fill in the Firebase web app credentials, then restart the dev server.
      </div>
    )
  }

  async function handleEditInEditor(song) {
    if (!song.midiBase64) {
      alert('This song has no stored MIDI to edit.')
      return
    }
    setImportingId(song.id)
    try {
      const job = await importFromLibrary(song.title, song.midiBase64)
      // Moving back to Convert: drop the library copy so the song lives in one
      // place only (no duplicates). Its stored MP3 goes too — editor imports are
      // MIDI-only anyway. Delete before navigating so it runs while mounted.
      try {
        await deleteSong(song.id, song.mp3Path)
        setSongs(function (prev) {
          return prev.filter(function (s) { return s.id !== song.id })
        })
      } catch (e) {
        alert('Opened in editor, but could not remove the old library copy: '
          + e.message)
      }
      if (onEdit) await onEdit(job.id)
    } catch (e) {
      alert('Could not open in editor: ' + e.message +
        '\n(The Convert backend must be running.)')
    } finally {
      setImportingId(null)
    }
  }

  async function handleDelete(song) {
    if (!confirm('Delete "' + song.title + '" from the library?' +
      (song.mp3Url ? ' Its stored MP3 is deleted too.' : ''))) return
    try {
      await deleteSong(song.id, song.mp3Path)
      refresh()
    } catch (e) {
      alert(e.message)
    }
  }

  function startRename(song) {
    setEditingId(song.id)
    setDraft(song.title || '')
  }

  async function commitRename(song) {
    const title = draft.trim()
    setEditingId(null)
    if (!title || title === song.title) return
    setSongs(function (prev) {
      return prev.map(function (s) {
        return s.id === song.id ? { ...s, title: title } : s
      })
    })
    try {
      await renameSong(song.id, title)
    } catch (e) {
      alert('Rename failed: ' + e.message)
      refresh()
    }
  }

  async function moveSong(song, folder) {
    const next = folder || null
    setSongs(function (prev) {
      return prev.map(function (s) {
        return s.id === song.id ? { ...s, folder: next } : s
      })
    })
    try {
      await setSongFolder(song.id, next)
    } catch (e) {
      alert('Move failed: ' + e.message)
      refresh()
    }
  }

  async function handleCreateFolder() {
    const name = (newFolder || '').trim()
    setNewFolder(null)
    if (!name) return
    if (folderNames.indexOf(name) !== -1) {
      setActive(name)
      return
    }
    try {
      await createFolder(name)
      setActive(name)
      const fold = await listFolders()
      setFolders(fold)
    } catch (e) {
      alert('Could not create folder: ' + e.message)
    }
  }

  function toggleSelect(id) {
    setSelected(function (prev) {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllVisible() {
    setSelected(new Set(visible.map(function (s) { return s.id })))
  }

  function clearSelection() {
    setSelected(new Set())
  }

  // Copy every selected song (baked .mid + accompaniment .mp3) into a folder the
  // user picks — typically a folder on the ENSPIRE USB stick. Runs entirely in
  // the browser: MIDI is decoded from Firestore, the MP3 fetched from Storage.
  async function handleCopyToUsb() {
    const chosen = songs.filter(function (s) { return selected.has(s.id) })
    if (!chosen.length) return
    if (!window.showDirectoryPicker) {
      alert('Your browser can\'t pick a folder. Use Chrome/Edge or the desktop app.')
      return
    }
    let dir
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite' })
    } catch (e) {
      if (e && e.name === 'AbortError') return // user cancelled the picker
      alert('Could not open folder: ' + e.message)
      return
    }
    setCopyResult(null)
    setCopying({ done: 0, total: chosen.length })
    const errors = []
    let done = 0
    for (const song of chosen) {
      const base = fsSafe(song.title)
      try {
        if (song.midiBase64) {
          await writeInto(dir, base + '.mid', b64ToBytes(song.midiBase64))
        }
        if (song.mp3Url) {
          const res = await fetch(song.mp3Url)
          if (!res.ok) throw new Error('MP3 download failed (' + res.status + ')')
          await writeInto(dir, base + ' (no piano).mp3', await res.blob())
        }
      } catch (e) {
        errors.push(song.title + ' — ' + (e.message || String(e)))
      }
      done++
      setCopying({ done: done, total: chosen.length })
    }
    setCopying(null)
    setCopyResult({ ok: chosen.length - errors.length, total: chosen.length, errors: errors })
    clearSelection()
  }

  async function handleDeleteFolder(folder) {
    const inFolder = songs.filter(function (s) { return s.folder === folder.name })
    if (!confirm(
      'Delete folder "' + folder.name + '"?' +
      (inFolder.length
        ? ' Its ' + inFolder.length + ' song(s) move to Unfiled (not deleted).'
        : ''))) return
    try {
      await Promise.all(inFolder.map(function (s) {
        return setSongFolder(s.id, null)
      }))
      await deleteFolder(folder.id)
      if (active === folder.name) setActive('all')
      refresh()
    } catch (e) {
      alert('Delete folder failed: ' + e.message)
    }
  }

  return (
    <div>
      <div className="folder-bar">
        <button
          className={'chip' + (active === 'all' ? ' active' : '')}
          onClick={function () { setActive('all') }}
        >All <span className="chip-count">{counts.all}</span></button>
        <button
          className={'chip' + (active === 'unfiled' ? ' active' : '')}
          onClick={function () { setActive('unfiled') }}
        >Unfiled <span className="chip-count">{counts.unfiled}</span></button>
        {folders.map(function (f) {
          return (
            <span key={f.id} className={'chip-wrap' + (active === f.name ? ' active' : '')}>
              <button
                className={'chip' + (active === f.name ? ' active' : '')}
                onClick={function () { setActive(f.name) }}
              >📁 {f.name} <span className="chip-count">{counts[f.name] || 0}</span></button>
              <button className="chip-x" title="Delete folder"
                onClick={function () { handleDeleteFolder(f) }}>✕</button>
            </span>
          )
        })}
        {newFolder === null ? (
          <button className="chip chip-new"
            onClick={function () { setNewFolder('') }}>+ New folder</button>
        ) : (
          <input
            className="url-input folder-new-input"
            autoFocus
            placeholder="Folder name…"
            value={newFolder}
            onChange={function (e) { setNewFolder(e.target.value) }}
            onBlur={handleCreateFolder}
            onKeyDown={function (e) {
              if (e.key === 'Enter') handleCreateFolder()
              if (e.key === 'Escape') setNewFolder(null)
            }}
          />
        )}
      </div>

      {folderError && (
        <div className="notice warn">
          Folders need a Firestore rules update. Deploy the updated{' '}
          <code>firestore.rules</code> (adds the <code>folders</code> collection),
          then reload. Songs still work meanwhile.
        </div>
      )}

      <div className="lib-toolbar">
        <input
          className="url-input lib-search"
          type="text"
          placeholder="Search library…"
          value={search}
          onChange={function (e) { setSearch(e.target.value) }}
        />
        <select value={sort} onChange={function (e) { setSort(e.target.value) }}>
          <option value="new">Newest first</option>
          <option value="old">Oldest first</option>
          <option value="title">Title A–Z</option>
        </select>
        <span className="meta lib-count">
          {visible.length}{search ? ' of ' + songs.length : ''} song
          {visible.length === 1 ? '' : 's'}
        </span>
      </div>

      {!loading && visible.length > 0 && (
        <div className="lib-select-bar">
          <button className="ghost" onClick={selectAllVisible}>
            Select all ({visible.length})
          </button>
          {selected.size > 0 && (
            <button className="ghost" onClick={clearSelection}>Clear</button>
          )}
          <span className="meta">{selected.size} selected</span>
          <button
            className="primary"
            disabled={selected.size === 0 || Boolean(copying)}
            onClick={handleCopyToUsb}
          >
            {copying
              ? 'Copying ' + copying.done + '/' + copying.total + '…'
              : '💾 Copy ' + (selected.size || '') + ' to USB folder…'}
          </button>
        </div>
      )}

      {copyResult && (
        <div className="notice" style={{
          borderColor: copyResult.errors.length ? 'var(--red, #c0392b)' : 'var(--green)'
        }}>
          ✓ Copied <strong>{copyResult.ok}/{copyResult.total}</strong> song
          {copyResult.total === 1 ? '' : 's'} (.mid + accompaniment .mp3) to the folder.
          {copyResult.errors.length > 0 && (
            <div style={{ marginTop: 6 }}>
              Failed: {copyResult.errors.join('; ')}
            </div>
          )}
        </div>
      )}

      {loading && <div className="meta">Loading…</div>}
      {error && <div className="notice warn">Error: {error}</div>}
      {!loading && songs.length === 0 && !error && (
        <div className="notice">
          No saved songs yet. Convert an MP3, then hit "Move to library".
        </div>
      )}
      {!loading && songs.length > 0 && visible.length === 0 && (
        <div className="notice">
          {search ? 'No songs match “' + search + '”.' : 'This folder is empty.'}
        </div>
      )}

      <div className="lib-grid">
        {visible.map(function (song) {
          const editing = editingId === song.id
          const isSel = selected.has(song.id)
          return (
            <div className={'card lib-card' + (isSel ? ' lib-card-sel' : '')} key={song.id}>
              <label className="lib-select">
                <input type="checkbox" checked={isSel}
                  onChange={function () { toggleSelect(song.id) }} />
                <span>Select</span>
              </label>
              <div className="lib-card-head">
                {editing ? (
                  <input
                    className="url-input lib-rename"
                    autoFocus
                    value={draft}
                    onChange={function (e) { setDraft(e.target.value) }}
                    onBlur={function () { commitRename(song) }}
                    onKeyDown={function (e) {
                      if (e.key === 'Enter') commitRename(song)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <h3
                    className="lib-title"
                    title="Click to rename"
                    onClick={function () { startRename(song) }}
                  >{song.title}</h3>
                )}
                <div className="meta">
                  {song.noteCount} notes · {song.pedalCount} pedal
                  {song.createdAt && song.createdAt.toDate
                    ? ' · ' + song.createdAt.toDate().toLocaleDateString()
                    : ''}
                </div>
                {song.sourceUrl && (
                  <div className="meta">
                    <a href={song.sourceUrl} target="_blank" rel="noreferrer"
                      title="Open the original source video">🔗 source video</a>
                  </div>
                )}
                <select
                  className="lib-folder-sel"
                  value={song.folder || ''}
                  onChange={function (e) { moveSong(song, e.target.value) }}
                >
                  <option value="">📂 Unfiled</option>
                  {folderNames.map(function (n) {
                    return <option key={n} value={n}>📁 {n}</option>
                  })}
                </select>
              </div>
              {song.mp3Url && (
                <div className="lib-audio">
                  <audio controls preload="none" src={song.mp3Url} />
                </div>
              )}
              <div className="lib-card-actions">
                <button
                  className="primary"
                  onClick={function () {
                    downloadMidiBase64(song.midiBase64, song.title + '.mid')
                  }}
                >⬇ .mid</button>
                {song.mp3Url && (
                  <a className="lib-mp3-dl" href={song.mp3Url}
                    download={song.title + ' (no piano).mp3'}
                    title="Download the accompaniment (piano removed) that plays with the MIDI">
                    <button className="ghost">⬇ .mp3</button>
                  </a>
                )}
                <button className="ghost"
                  title="Re-open in the editor to cap sustain, edit notes, re-export"
                  disabled={importingId === song.id}
                  onClick={function () { handleEditInEditor(song) }}>
                  {importingId === song.id ? 'Opening…' : '🎹 Edit'}
                </button>
                <button className="ghost"
                  onClick={function () { startRename(song) }}>✎</button>
                <button className="ghost danger"
                  onClick={function () { handleDelete(song) }}>✕</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
