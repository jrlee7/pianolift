import { initializeApp } from 'firebase/app'
import {
  getFirestore, collection, addDoc, getDocs, deleteDoc, doc, updateDoc,
  query, orderBy, where, serverTimestamp
} from 'firebase/firestore'
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from 'firebase/storage'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
}

export const firebaseReady = Boolean(config.apiKey && config.projectId)

let db = null
let storage = null
if (firebaseReady) {
  const app = initializeApp(config)
  db = getFirestore(app)
  // Storage holds the source MP3s — too big for a Firestore doc (1 MiB cap).
  // Only usable if a storageBucket is set in the web config.
  if (config.storageBucket) storage = getStorage(app)
}

function extFromType(type) {
  if (type === 'audio/wav' || type === 'audio/x-wav') return '.wav'
  if (type === 'audio/mp4' || type === 'audio/x-m4a') return '.m4a'
  if (type === 'audio/flac' || type === 'audio/x-flac') return '.flac'
  if (type === 'audio/ogg') return '.ogg'
  return '.mp3'
}

const SONGS = 'songs'
const FOLDERS = 'folders'
const SOURCES = 'sources'

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e) {
    return ''
  }
}

// Record a converted link so its source video can be found again later.
// De-duplicates on the exact URL: a repeat conversion bumps the timestamp and
// count instead of adding a second row. Best-effort — callers ignore failures.
export async function saveSourceUrl(url, title) {
  if (!db || !url) return null
  const existing = await getDocs(
    query(collection(db, SOURCES), where('url', '==', url)))
  if (!existing.empty) {
    const d = existing.docs[0]
    const prev = d.data()
    await updateDoc(doc(db, SOURCES, d.id), {
      lastConvertedAt: serverTimestamp(),
      count: (prev.count || 1) + 1,
      title: title || prev.title || null
    })
    return d.id
  }
  const ref = await addDoc(collection(db, SOURCES), {
    url: url,
    host: hostOf(url),
    title: title || null,
    count: 1,
    createdAt: serverTimestamp(),
    lastConvertedAt: serverTimestamp()
  })
  return ref.id
}

export async function listSourceUrls() {
  if (!db) return []
  const q = query(collection(db, SOURCES), orderBy('lastConvertedAt', 'desc'))
  const snap = await getDocs(q)
  const out = []
  snap.forEach(function (d) {
    const data = d.data()
    data.id = d.id
    out.push(data)
  })
  return out
}

export async function deleteSourceUrl(id) {
  if (!db) throw new Error('Firebase not configured')
  await deleteDoc(doc(db, SOURCES, id))
}

// Upload the source MP3 to Storage, then write the song doc (MIDI stays in
// Firestore, the audio lives in Storage as a URL). If the audio upload fails
// the song is still saved MIDI-only so the library isn't lost. Returns
// { id, mp3Uploaded, mp3Error }.
export async function saveSong(song, mp3Blob) {
  if (!db) throw new Error('Firebase not configured')
  let mp3Url = null
  let mp3Path = null
  let mp3Error = null
  if (mp3Blob && storage) {
    try {
      const ext = extFromType(mp3Blob.type)
      mp3Path = 'songs/' + crypto.randomUUID() + '/source' + ext
      const dest = storageRef(storage, mp3Path)
      await uploadBytes(dest, mp3Blob, {
        contentType: mp3Blob.type || 'audio/mpeg'
      })
      mp3Url = await getDownloadURL(dest)
    } catch (e) {
      mp3Url = null
      mp3Path = null
      mp3Error = e.message || String(e)
    }
  } else if (mp3Blob && !storage) {
    mp3Error = 'Storage bucket not configured (VITE_FIREBASE_STORAGE_BUCKET).'
  }
  const ref = await addDoc(collection(db, SONGS), {
    title: song.title,
    noteCount: song.noteCount,
    pedalCount: song.pedalCount,
    settings: song.settings,
    midiBase64: song.midiBase64,
    mp3Url: mp3Url,
    mp3Path: mp3Path,
    sourceUrl: song.sourceUrl || null,
    // filename in the backend's local media folder (videos are too big for
    // the cloud) — the Play tab streams it from this computer
    localVideo: song.localVideo || null,
    // that video's audio is the piano-removed backing track (leave unmuted)
    videoIsBacking: Boolean(song.videoIsBacking),
    folder: song.folder || null,
    createdAt: serverTimestamp()
  })
  return { id: ref.id, mp3Uploaded: Boolean(mp3Url), mp3Error: mp3Error }
}

export async function listSongs() {
  if (!db) return []
  const q = query(collection(db, SONGS), orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  const out = []
  snap.forEach(function (d) {
    const data = d.data()
    data.id = d.id
    out.push(data)
  })
  return out
}

function norm(s) {
  return (s || '').trim().toLowerCase()
}

// True when an existing library song is the "same" as one being saved:
// identical source link (strong match) or identical title (case-insensitive).
export function isSameSong(existing, title, sourceUrl) {
  if (sourceUrl && existing.sourceUrl && existing.sourceUrl === sourceUrl) {
    return true
  }
  return norm(title) !== '' && norm(existing.title) === norm(title)
}

// Return the first library song that duplicates the given title/source, or
// null. Used to warn before adding a song that's already saved.
export async function findExistingSong(title, sourceUrl) {
  if (!db) return null
  const songs = await listSongs()
  return songs.find(function (s) {
    return isSameSong(s, title, sourceUrl)
  }) || null
}

export async function deleteSong(id, mp3Path) {
  if (!db) throw new Error('Firebase not configured')
  // Delete the Storage object first; a missing/failed audio delete must not
  // block removing the song doc (best-effort cleanup).
  if (mp3Path && storage) {
    try {
      await deleteObject(storageRef(storage, mp3Path))
    } catch (e) {
      /* already gone or rules changed — drop the doc anyway */
    }
  }
  await deleteDoc(doc(db, SONGS, id))
}

export async function renameSong(id, title) {
  if (!db) throw new Error('Firebase not configured')
  await updateDoc(doc(db, SONGS, id), { title: title })
}

// Folders are identified by name (stored on each song's `folder` field). The
// `folders` collection just persists names so empty folders survive reloads.
export async function listFolders() {
  if (!db) return []
  const q = query(collection(db, FOLDERS), orderBy('name'))
  const snap = await getDocs(q)
  const out = []
  snap.forEach(function (d) {
    const data = d.data()
    data.id = d.id
    out.push(data)
  })
  return out
}

export async function createFolder(name) {
  if (!db) throw new Error('Firebase not configured')
  const ref = await addDoc(collection(db, FOLDERS), {
    name: name,
    createdAt: serverTimestamp()
  })
  return ref.id
}

export async function deleteFolder(id) {
  if (!db) throw new Error('Firebase not configured')
  await deleteDoc(doc(db, FOLDERS, id))
}

export async function setSongFolder(id, folder) {
  if (!db) throw new Error('Firebase not configured')
  await updateDoc(doc(db, SONGS, id), { folder: folder || null })
}

export function downloadMidiBase64(b64, filename) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  const blob = new Blob([bytes], { type: 'audio/midi' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
