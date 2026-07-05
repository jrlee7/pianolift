const BASE = '/api'

export async function uploadMp3(file) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(BASE + '/jobs', { method: 'POST', body: form })
  if (!res.ok) throw new Error('Upload failed (' + res.status + ')')
  return res.json()
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
  const res = await fetch(BASE + '/jobs/' + id + '/events')
  if (!res.ok) throw new Error('Events not ready')
  return res.json()
}

export function midiUrl(id, settings) {
  const params = new URLSearchParams({
    vel_min: String(settings.velMin),
    vel_max: String(settings.velMax),
    gamma: String(settings.gamma),
    offset_ms: String(settings.offsetMs),
    pedal: settings.pedal ? 'true' : 'false'
  })
  return BASE + '/jobs/' + id + '/midi?' + params.toString()
}

export function audioUrl(id, which) {
  return BASE + '/jobs/' + id + '/audio/' + which
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
