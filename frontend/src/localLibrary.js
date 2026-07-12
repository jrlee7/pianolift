// Customer local song library. In the packaged app this is an on-device store
// under Electron's userData (see main.js lib-* handlers); in the browser dev
// build it falls back to localStorage (metadata only — no MP3 bytes) so the UI
// still works while developing.
const desk = (typeof window !== 'undefined' && window.desktop && window.desktop.localLibrary)
  ? window.desktop.localLibrary
  : null

const LS_KEY = 'pf_local_library'

function lsList() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch (e) { return [] }
}
function lsWrite(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)) }

export const localLibraryOnDisk = Boolean(desk)

export async function localList() {
  if (desk) return desk.list()
  return lsList()
}

// meta: { title, noteCount, pedalCount, settings, midiBase64, sourceUrl }
export async function localSave(meta, mp3Blob) {
  const bytes = mp3Blob ? new Uint8Array(await mp3Blob.arrayBuffer()) : null
  if (desk) return desk.save(meta, bytes)
  const rec = { ...meta, id: crypto.randomUUID(), hasMp3: false, createdAt: Date.now() }
  const list = lsList(); list.unshift(rec); lsWrite(list)
  return rec
}

export async function localRename(id, title) {
  if (desk) return desk.rename(id, title)
  const list = lsList().map((s) => (s.id === id ? { ...s, title: title } : s))
  lsWrite(list)
}

export async function localDelete(id) {
  if (desk) return desk.delete(id)
  lsWrite(lsList().filter((s) => s.id !== id))
}

// Object URL for the stored accompaniment MP3, or null. Caller revokes it.
export async function localMp3Url(id) {
  if (!desk) return null
  const bytes = await desk.mp3(id)
  if (!bytes || !bytes.length) return null
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
}

// Raw MP3 bytes (Uint8Array) for USB copy / disk build, or null.
export async function localMp3Bytes(id) {
  if (!desk) return null
  const bytes = await desk.mp3(id)
  return bytes && bytes.length ? bytes : null
}
