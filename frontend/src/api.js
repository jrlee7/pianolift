// Dev (vite server): '/api' is proxied to the backend on :8000. Packaged app
// (loaded via file://, no proxy): hit the local backend directly.
const BASE = (typeof location !== 'undefined' && location.protocol === 'file:')
  ? 'http://127.0.0.1:8000/api'
  : '/api'

export async function uploadMp3(file, pianoOnly) {
  const form = new FormData()
  form.append('file', file)
  form.append('piano_only', pianoOnly ? 'true' : 'false')
  const res = await fetch(BASE + '/jobs', { method: 'POST', body: form })
  if (!res.ok) throw new Error('Upload failed (' + res.status + ')')
  return res.json()
}

export async function submitUrl(url, pianoOnly, includeVideo) {
  const res = await fetch(BASE + '/jobs/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: url, pianoOnly: pianoOnly, includeVideo: Boolean(includeVideo)
    })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Fetch failed')
  return data
}

// Re-open a library song in the editor: the backend decodes its baked MIDI
// back into editable events and returns a finished, MIDI-only job. settings
// (the sliders the song was archived with) let the backend invert the
// velocity mapping so re-exports don't compress the dynamic range.
export async function importFromLibrary(name, midiBase64, settings) {
  const res = await fetch(BASE + '/jobs/from-library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name, midiBase64: midiBase64, settings: settings || null
    })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Import failed')
  return data
}

export async function listJobs() {
  const res = await fetch(BASE + '/jobs')
  if (!res.ok) throw new Error('Failed to list jobs')
  return res.json()
}

export async function getJob(id) {
  const res = await fetch(BASE + '/jobs/' + id)
  if (!res.ok) throw new Error('Job not found')
  return res.json()
}

export async function deleteJob(id) {
  const res = await fetch(BASE + '/jobs/' + id, { method: 'DELETE' })
  if (!res.ok) throw new Error('Delete failed')
  return res.json()
}

export async function getEvents(id) {
  // no-store: after a trim/reset the backend rewrites events.json; a cached
  // response would show the pre-trim (dead-space) version.
  const res = await fetch(BASE + '/jobs/' + id + '/events', { cache: 'no-store' })
  if (!res.ok) throw new Error('Events not ready')
  return res.json()
}

export async function saveEvents(id, events) {
  // strip editor-only _id fields before sending
  const notes = []
  for (let i = 0; i < events.notes.length; i++) {
    const n = events.notes[i]
    notes.push({
      onset: n.onset, offset: n.offset,
      pitch: n.pitch, velocity: n.velocity
    })
  }
  const pedals = []
  for (let i = 0; i < events.pedals.length; i++) {
    const p = events.pedals[i]
    pedals.push({ onset: p.onset, offset: p.offset })
  }
  const res = await fetch(BASE + '/jobs/' + id + '/events', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: notes, pedals: pedals })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Save failed')
  return data
}

// Re-check a finished song's notes against its piano stem (ghost-note
// removal + held-note trimming) — for songs converted before the pipeline
// ran this pass itself. Safe to run once per song; a repeat finds nothing.
export async function verifyJob(id) {
  const res = await fetch(BASE + '/jobs/' + id + '/verify', { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Clean-up failed')
  return data
}

// Persist the export sliders on the job so bulk USB-copy / library-move can
// render each song as tuned. Best-effort — callers ignore failures.
export async function saveJobSettings(id, settings) {
  const res = await fetch(BASE + '/jobs/' + id + '/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  })
  if (!res.ok) throw new Error('Settings save failed')
  return res.json()
}

export async function resetEvents(id) {
  const res = await fetch(BASE + '/jobs/' + id + '/events/reset', {
    method: 'POST'
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Reset failed')
  return data
}

export function midiUrl(id, settings) {
  const params = new URLSearchParams({
    vel_min: String(settings.velMin),
    vel_max: String(settings.velMax),
    gamma: String(settings.gamma),
    offset_ms: String(settings.offsetMs),
    pedal: settings.pedal ? 'true' : 'false',
    release_ms: String(settings.releaseMs),
    cap_sustain: settings.capSustain ? 'true' : 'false'
  })
  return BASE + '/jobs/' + id + '/midi?' + params.toString()
}

export function audioUrl(id, which) {
  return BASE + '/jobs/' + id + '/audio/' + which
}

// Set start/end trim (seconds, original timeline). Backend re-encodes the
// accompaniment MP3 and every export honors the same window, keeping sync.
export async function trimJob(id, trimStart, trimEnd) {
  const params = new URLSearchParams({ trim_start: String(trimStart) })
  if (trimEnd != null) params.set('trim_end', String(trimEnd))
  const res = await fetch(BASE + '/jobs/' + id + '/trim?' + params.toString(), {
    method: 'POST'
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Trim failed')
  return data
}

export function hfeUrl(id, settings) {
  const params = new URLSearchParams({
    vel_min: String(settings.velMin),
    vel_max: String(settings.velMax),
    gamma: String(settings.gamma),
    offset_ms: String(settings.offsetMs),
    pedal: settings.pedal ? 'true' : 'false',
    release_ms: String(settings.releaseMs),
    cap_sustain: settings.capSustain ? 'true' : 'false'
  })
  return BASE + '/jobs/' + id + '/hfe?' + params.toString()
}

export async function getDrives() {
  const res = await fetch(BASE + '/drives')
  if (!res.ok) throw new Error('Drive listing failed')
  return res.json()
}

export async function exportToDrive(id, kind, dest, settings) {
  const params = new URLSearchParams({
    kind: kind,
    dest: dest,
    vel_min: String(settings.velMin),
    vel_max: String(settings.velMax),
    gamma: String(settings.gamma),
    offset_ms: String(settings.offsetMs),
    pedal: settings.pedal ? 'true' : 'false',
    release_ms: String(settings.releaseMs),
    cap_sustain: settings.capSustain ? 'true' : 'false'
  })
  const res = await fetch(BASE + '/jobs/' + id + '/export?' + params.toString(), {
    method: 'POST'
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Export failed')
  return data
}

// Full contents of the Gotek stick: every slot with the songs on it. Backend
// decodes each disk's FAT/PIANODIR, so a big stick takes a few seconds.
export async function getGotekCatalog() {
  const res = await fetch(BASE + '/gotek/catalog')
  if (!res.ok) throw new Error('Gotek scan failed (' + res.status + ')')
  return res.json()
}

export async function getUsbStatus() {
  const res = await fetch(BASE + '/usb')
  if (!res.ok) throw new Error('USB status failed')
  return res.json()
}

export async function saveToUsb(id, settings) {
  const params = new URLSearchParams({
    vel_min: String(settings.velMin),
    vel_max: String(settings.velMax),
    gamma: String(settings.gamma),
    offset_ms: String(settings.offsetMs),
    pedal: settings.pedal ? 'true' : 'false',
    release_ms: String(settings.releaseMs),
    cap_sustain: settings.capSustain ? 'true' : 'false'
  })
  const res = await fetch(BASE + '/jobs/' + id + '/usb?' + params.toString(), {
    method: 'POST'
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'USB save failed')
  return data
}

export function eseqUrl(id, settings) {
  const params = new URLSearchParams({
    vel_min: String(settings.velMin),
    vel_max: String(settings.velMax),
    gamma: String(settings.gamma),
    offset_ms: String(settings.offsetMs),
    pedal: settings.pedal ? 'true' : 'false',
    release_ms: String(settings.releaseMs),
    cap_sustain: settings.capSustain ? 'true' : 'false'
  })
  return BASE + '/jobs/' + id + '/eseq?' + params.toString()
}

// Video kept with a conversion (URL fetch with "include video" or an
// uploaded video file), streamed with Range support so seeking works.
export function jobVideoUrl(id) {
  return BASE + '/jobs/' + id + '/video'
}

// Archived video in the backend's local media folder (library songs).
export function mediaVideoUrl(name) {
  return BASE + '/media/' + encodeURIComponent(name)
}

// Move a job's kept video into the local media folder before the job is
// deleted (move-to-library). Returns { file } — store it on the song doc.
export async function archiveVideo(id) {
  const res = await fetch(BASE + '/jobs/' + id + '/archive-video', {
    method: 'POST'
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Video archive failed')
  return data
}

// Decode a library song's baked MIDI into note/pedal events for the
// video-sync player — no throwaway job, the library copy stays put.
export async function decodeMidi(midiBase64) {
  const res = await fetch(BASE + '/midi/decode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ midiBase64: midiBase64 })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'MIDI decode failed')
  return data
}

// --- Multi-song floppy disk (many songs per Gotek slot) -------------------
// One slot = one .hfe = one 720K floppy. These pack several songs onto it.
// `opts`: { slot, overwrite, download }. Save actions return JSON
// { drive, slot, filename }; a 409 (slot occupied) throws an Error whose
// .status is 409 so the caller can offer to overwrite.

async function postDisk(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res
}

async function saveDiskResult(res) {
  const data = await res.json().catch(function () { return {} })
  if (!res.ok) {
    const err = new Error(data.detail || 'Disk build failed')
    err.status = res.status
    throw err
  }
  return data
}

// Build one floppy from converted jobs. jobIds render in the given order
// (song 01, 02, …). Pass { download: true } to get the .hfe as a Blob.
export async function buildDiskFromJobs(jobIds, opts) {
  const o = opts || {}
  const res = await postDisk('/disk/build', {
    jobIds: jobIds, slot: o.slot != null ? o.slot : null,
    overwrite: Boolean(o.overwrite), download: Boolean(o.download)
  })
  if (o.download) {
    if (!res.ok) throw await saveDiskResult(res)
    return res.blob()
  }
  return saveDiskResult(res)
}

// Build one floppy from library songs. `songs`: [{ name, midiBase64, settings }].
export async function buildDiskFromLibrary(songs, opts) {
  const o = opts || {}
  const res = await postDisk('/disk/build-midi', {
    songs: songs, slot: o.slot != null ? o.slot : null,
    overwrite: Boolean(o.overwrite), download: Boolean(o.download)
  })
  if (o.download) {
    if (!res.ok) throw await saveDiskResult(res)
    return res.blob()
  }
  return saveDiskResult(res)
}

// --- Sheet music (PDF/MusicXML -> pedal + dynamics suggestions) ----------

export async function uploadSheet(file) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(BASE + '/sheet-jobs', { method: 'POST', body: form })
  if (!res.ok) throw new Error('Upload failed (' + res.status + ')')
  return res.json()
}

export async function listSheetJobs() {
  const res = await fetch(BASE + '/sheet-jobs')
  if (!res.ok) throw new Error('Failed to list sheet jobs')
  return res.json()
}

export async function deleteSheetJob(id) {
  const res = await fetch(BASE + '/sheet-jobs/' + id, { method: 'DELETE' })
  if (!res.ok) throw new Error('Delete failed')
  return res.json()
}

export function sheetMusicXmlUrl(id) {
  // cache-bust: the working score changes on every edit/reset, and a
  // stale cached copy would show marks that no longer exist.
  return BASE + '/sheet-jobs/' + id + '/musicxml?t=' + Date.now()
}

export async function fetchSheetMusicXml(id) {
  const res = await fetch(BASE + '/sheet-jobs/' + id + '/musicxml', { cache: 'no-store' })
  if (!res.ok) throw new Error('Score not ready')
  return res.text()
}

// xmlText is the whole edited MusicXML document, re-serialized client-side.
export async function saveSheetMusicXml(id, xmlText) {
  const form = new FormData()
  form.append('file', new Blob([xmlText], { type: 'application/xml' }), 'score.musicxml')
  const res = await fetch(BASE + '/sheet-jobs/' + id + '/musicxml', {
    method: 'PUT', body: form
  })
  if (!res.ok) throw new Error('Save failed')
  return res.json()
}

export async function resetSheetJob(id) {
  const res = await fetch(BASE + '/sheet-jobs/' + id + '/reset', { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Reset failed')
  return data
}

export function sheetExportUrl(id) {
  return BASE + '/sheet-jobs/' + id + '/export'
}

export async function fetchMidiBase64(id, settings) {
  const res = await fetch(midiUrl(id, settings))
  if (!res.ok) throw new Error('MIDI render failed')
  const buf = await res.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i])
  }
  return btoa(bin)
}
