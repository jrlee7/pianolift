import { useEffect, useState } from 'react'
import {
  firebaseReady, listSongs, deleteSong, downloadMidiBase64
} from '../firebase.js'

export default function LibraryView() {
  const [songs, setSongs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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
  }

  useEffect(function () {
    refresh()
  }, [])

  if (!firebaseReady) {
    return (
      <div className="notice warn">
        Firebase not configured. Copy <code>.env.example</code> to <code>.env</code> in
        frontend/ and fill in the Firebase web app credentials, then restart the dev server.
      </div>
    )
  }

  async function handleDelete(song) {
    if (!confirm('Delete "' + song.title + '" from the library?')) return
    try {
      await deleteSong(song.id)
      refresh()
    } catch (e) {
      alert(e.message)
    }
  }

  return (
    <div>
      {loading && <div className="meta">Loading…</div>}
      {error && <div className="notice warn">Error: {error}</div>}
      {!loading && songs.length === 0 && !error && (
        <div className="notice">
          No saved songs yet. Convert an MP3, then hit "Save to library".
        </div>
      )}
      {songs.map(function (song) {
        return (
          <div className="card" key={song.id}>
            <div className="row">
              <div>
                <h3>{song.title}</h3>
                <div className="meta">
                  {song.noteCount} notes · {song.pedalCount} pedal events
                  {song.createdAt && song.createdAt.toDate
                    ? ' · ' + song.createdAt.toDate().toLocaleDateString()
                    : ''}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="primary"
                  onClick={function () {
                    downloadMidiBase64(song.midiBase64, song.title + '.mid')
                  }}
                >⬇ .mid</button>
                <button className="ghost danger"
                  onClick={function () { handleDelete(song) }}>✕</button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
