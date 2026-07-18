import { useRef, useState } from 'react'

export default function SheetUploadZone({ onFiles }) {
  const inputRef = useRef(null)
  const [drag, setDrag] = useState(false)

  function pick(fileList) {
    const files = []
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i]
      if (/\.(musicxml|xml|mxl|pdf)$/i.test(f.name)) files.push(f)
    }
    if (files.length === 0) {
      alert('Drop a score file: MusicXML (.musicxml/.xml/.mxl) or PDF')
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
      <div className="big">Drop a score file here</div>
      <div>
        or click to browse — MusicXML (.musicxml/.xml/.mxl) or PDF.
        PDF goes through optical music recognition first and can take a
        while on a real score; MusicXML is near-instant.
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".musicxml,.xml,.mxl,.pdf"
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
