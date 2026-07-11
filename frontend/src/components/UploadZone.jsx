import { useRef, useState } from 'react'

export default function UploadZone({ onFiles, onUrl }) {
  const inputRef = useRef(null)
  const [drag, setDrag] = useState(false)
  const [pianoOnly, setPianoOnly] = useState(false)
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)

  async function submitUrl() {
    const u = url.trim()
    if (!u) return
    if (!/^https?:\/\//i.test(u)) {
      alert('Paste a full link starting with http:// or https://')
      return
    }
    setFetching(true)
    try {
      await onUrl(u, pianoOnly)
      setUrl('')
    } finally {
      setFetching(false)
    }
  }

  function pick(fileList) {
    const files = []
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i]
      // video containers OK too — the backend strips the video stream and
      // converts the audio track
      if (/\.(mp3|wav|m4a|flac|ogg|aac|opus|wma|mp4|m4v|mkv|mov|webm)$/i.test(f.name)) {
        files.push(f)
      }
    }
    if (files.length === 0) {
      alert('Drop an audio or video file (mp3, wav, m4a, flac, ogg, aac, ' +
        'opus, wma, mp4, mkv, mov, webm)')
      return
    }
    onFiles(files, pianoOnly)
  }

  return (
    <div>
      <div
        className={'dropzone' + (drag ? ' drag' : '')}
        onClick={function () { inputRef.current.click() }}
        onDragOver={function (e) { e.preventDefault(); setDrag(true) }}
        onDragLeave={function () { setDrag(false) }}
        onDrop={function (e) {
          e.preventDefault()
          setDrag(false)
          pick(e.dataTransfer.files)
        }}
      >
        <div className="big">Drop an audio or video file here</div>
        <div>or click to browse — piano extraction takes a few minutes per song</div>
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.wav,.m4a,.flac,.ogg,.aac,.opus,.wma,.mp4,.m4v,.mkv,.mov,.webm,audio/*,video/*"
          multiple
          hidden
          onChange={function (e) {
            pick(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      <div className="url-row">
        <input
          type="text"
          className="url-input"
          placeholder="…or paste a link — YouTube, Facebook, Instagram, SoundCloud…"
          value={url}
          disabled={fetching}
          onChange={function (e) { setUrl(e.target.value) }}
          onKeyDown={function (e) { if (e.key === 'Enter') submitUrl() }}
        />
        <button className="primary" disabled={fetching || !url.trim()}
          onClick={submitUrl}>
          {fetching ? 'Starting…' : '⬇ Fetch & convert'}
        </button>
      </div>
      <div className="check" style={{ marginTop: 8 }}>
        <input id="pianoOnly" type="checkbox" checked={pianoOnly}
          onChange={function (e) { setPianoOnly(e.target.checked) }} />
        <label htmlFor="pianoOnly" style={{ margin: 0 }}>
          This file is piano-only — skip separation (much faster)
        </label>
      </div>
    </div>
  )
}
