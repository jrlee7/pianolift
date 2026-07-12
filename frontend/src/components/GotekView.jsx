import { useEffect, useState } from 'react'
import { getGotekCatalog } from '../api.js'

// Build a clean standalone HTML document and print it, so the printed catalog
// is just the song list — no app chrome, tabs or buttons.
function printCatalog(data, showEmpty) {
  const when = new Date().toLocaleString()
  const rows = data.slots
    .filter(function (s) { return showEmpty || !s.blank })
    .map(function (s) {
      const songs = s.blank
        ? '<em class="empty">— empty —</em>'
        : (s.error
          ? '<em class="empty">unreadable (' + s.error + ')</em>'
          : '<ol>' + s.songs.map(function (x) {
            return '<li>' + escapeHtml(x.title) + '</li>'
          }).join('') + '</ol>')
      return '<tr><td class="slot">' + s.slot + '</td><td>' + songs + '</td></tr>'
    }).join('')
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>Gotek disk catalog</title>' +
    '<style>' +
    'body{font:13px/1.4 Arial,sans-serif;margin:24px;color:#000}' +
    'h1{font-size:18px;margin:0 0 2px}' +
    '.meta{color:#555;font-size:12px;margin:0 0 14px}' +
    'table{border-collapse:collapse;width:100%}' +
    'th,td{border:1px solid #999;padding:5px 8px;vertical-align:top;text-align:left}' +
    'th{background:#eee}' +
    'td.slot{width:64px;font-weight:bold;text-align:center;font-size:15px}' +
    'ol{margin:0;padding-left:20px}' +
    '.empty{color:#999}' +
    '@media print{body{margin:0}}' +
    '</style></head><body>' +
    '<h1>Gotek disk catalog</h1>' +
    '<p class="meta">' + escapeHtml(data.drive) + ' · ' + data.usedSlots +
    ' filled slot' + (data.usedSlots === 1 ? '' : 's') + ' · ' + data.totalSongs +
    ' song' + (data.totalSongs === 1 ? '' : 's') + ' · ' + when + '</p>' +
    '<table><thead><tr><th>Slot</th><th>Songs</th></tr></thead><tbody>' +
    rows + '</tbody></table></body></html>'
  const w = window.open('', '_blank')
  if (!w) {
    alert('Allow pop-ups to print the catalog.')
    return
  }
  w.document.write(html)
  w.document.close()
  w.focus()
  // Give the new document a tick to lay out before invoking print.
  setTimeout(function () { w.print() }, 250)
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}

export default function GotekView() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showEmpty, setShowEmpty] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setData(await getGotekCatalog())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(function () { load() }, [])

  if (loading && !data) {
    return (
      <div className="notice">
        Scanning the Gotek stick… decoding each slot takes a moment.
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <div className="notice warn">Scan failed: {error}</div>
        <button onClick={load}>↻ Retry</button>
      </div>
    )
  }

  if (data && !data.found) {
    return (
      <div className="notice warn">
        No Gotek/Nalbantov stick detected. Plug in the emulator USB stick (the
        drive full of <code>DSKAxxxx.hfe</code> files) and hit Rescan.
        <div style={{ marginTop: 10 }}>
          <button onClick={load}>↻ Rescan</button>
        </div>
      </div>
    )
  }

  if (!data) return null

  const shown = data.slots.filter(function (s) { return showEmpty || !s.blank })

  return (
    <div>
      <div className="lib-select-bar">
        <span className="meta">
          {data.drive} · <strong>{data.usedSlots}</strong> filled /{' '}
          {data.totalSlots} slots · <strong>{data.totalSongs}</strong> songs
        </span>
        <button className="ghost" disabled={loading} onClick={load}>
          {loading ? 'Scanning…' : '↻ Rescan'}
        </button>
        <label className="meta" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={showEmpty}
            onChange={function (e) { setShowEmpty(e.target.checked) }} />
          Show empty slots
        </label>
        <button className="primary"
          disabled={data.totalSongs === 0}
          onClick={function () { printCatalog(data, showEmpty) }}>
          🖨 Print catalog
        </button>
      </div>

      {shown.length === 0 && (
        <div className="notice">
          {data.usedSlots === 0
            ? 'Every slot is empty. Build a floppy from the Convert or Library tab.'
            : 'No slots to show. Tick “Show empty slots” to see the blanks.'}
        </div>
      )}

      <div className="gotek-grid">
        {shown.map(function (s) {
          return (
            <div key={s.slot} className={'card gotek-slot' + (s.blank ? ' gotek-empty' : '')}>
              <div className="gotek-slot-head">
                <span className="gotek-slot-num">Slot {s.slot}</span>
                <span className="meta">{s.filename}</span>
              </div>
              {s.blank ? (
                <div className="meta">— empty —</div>
              ) : s.error ? (
                <div className="meta">unreadable ({s.error})</div>
              ) : (
                <ol className="gotek-songs">
                  {s.songs.map(function (song, i) {
                    return <li key={i} title={song.name}>{song.title}</li>
                  })}
                </ol>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
