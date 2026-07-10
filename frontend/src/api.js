const BASE = '/api'

export async function uploadMp3(file, pianoOnly) {
  const form = new FormData()
  form.append('file', file)
  form.append('piano_only', pianoOnly ? 'true' : 'false')
  const res = await fetch(BASE + '/jobs', { method: 'POST', body: form })
  if (!res.ok) throw new Error('Upload failed (' + res.status + ')')
  return res.json()
}

export async function submitUrl(url, pianoOnly) {
  const res = await fetch(BASE + '/jobs/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url, pianoOnly: pianoOnly })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || 'Fetch failed')
  return data
}

// Re-open a library song in the editor: the backend decodes its baked MIDI
// back into editable events and returns a finished, MIDI-only job.
export async function importFromLibrary(name, midiBase64) {
  const res = await fetch(BASE + '/jobs/from-library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, midiBase64: midiBase64 })
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
