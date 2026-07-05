import { useRef, useState } from 'react'

export default function UploadZone({ onFiles }) {
  const inputRef = useRef(null)
  const [drag, setDrag] = useState(false)

  function pick(fileList) {
    const files = []
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i]
      if (/\.(mp3|wav|m4a|flac|ogg)$/i.test(f.name)) files.push(f)
    }
    if (files.length === 0) {
      alert('Drop an audio file (mp3, wav, m4a, flac, ogg)')
      return
    }
    onFiles(files)
  }

  return (
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
      <div className="big">Drop an MP3 here</div>
      <div>or click to browse — piano extraction takes a few minutes per song</div>
      <input
        ref={inputRef}
        type="file"
        accept=".mp3,.wav,.m4a,.flac,.ogg,audio/*"
        multiple
        hidden
        onChange={function (e) {
          pick(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
