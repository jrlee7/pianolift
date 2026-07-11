import { useEffect, useState } from 'react'
import { firebaseReady, listSourceUrls, deleteSourceUrl } from '../firebase.js'

// History of every link fed into the Convert tab, so a source video can be
// found again later even if the song was never moved to the library.
export default function SourcesView() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

  async function refresh() {
    setLoading(true)
    try {
      setItems(await listSourceUrls())
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(function () { refresh() }, [])

  if (!firebaseReady) {
    return (
      <div className="notice warn">
        Firebase not configured — converted links aren't being saved. Fill in the
        Firebase web config in <code>frontend/.env</code> to keep a history of
        source videos.
      </div>
    )
  }

  async function handleDelete(item) {
    if (!confirm('Forget this link?\n' + item.url)) return
    try {
      await deleteSourceUrl(item.id)
      setItems(function (prev) {
        return prev.filter(function (x) { return x.id !== item.id })
      })
    } catch (e) {
      alert('Delete failed: ' + e.message)
    }
  }

  const q = search.trim().toLowerCase()
  const visible = items.filter(function (x) {
    return !q ||
      (x.url || '').toLowerCase().includes(q) ||
      (x.title || '').toLowerCase().includes(q)
  })

  return (
    <div>
      <div className="lib-toolbar">
        <input
          className="url-input lib-search"
          type="text"
          placeholder="Search links…"
          value={search}
          onChange={function (e) { setSearch(e.target.value) }}
        />
        <span className="meta lib-count">
          {visible.length}{search ? ' of ' + items.length : ''} link
          {visible.length === 1 ? '' : 's'}
        </span>
      </div>

      {loading && <div className="meta">Loading…</div>}
      {error && <div className="notice warn">Error: {error}</div>}
      {!loading && items.length === 0 && !error && (
        <div className="notice">
          No converted links yet. Paste a YouTube / Facebook / SoundCloud link on
          the Convert tab and it's saved here so you can find the video again.
        </div>
      )}
      {!loading && items.length > 0 && visible.length === 0 && (
        <div className="notice">No links match “{search}”.</div>
      )}

      <div className="src-list">
        {visible.map(function (item) {
          const when = item.lastConvertedAt && item.lastConvertedAt.toDate
            ? item.lastConvertedAt.toDate().toLocaleDateString()
            : ''
          return (
            <div className="card src-row" key={item.id}>
              <div className="src-main">
                <a className="src-link" href={item.url}
                  target="_blank" rel="noreferrer">
                  {item.title || item.url}
                </a>
                {item.title && <div className="meta src-url">{item.url}</div>}
                <div className="meta">
                  {item.host || ''}
                  {item.count > 1 ? ' · converted ' + item.count + '×' : ''}
                  {when ? ' · ' + when : ''}
                </div>
              </div>
              <button className="ghost danger" title="Forget this link"
                onClick={function () { handleDelete(item) }}>✕</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
