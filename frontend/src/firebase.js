import { initializeApp } from 'firebase/app'
import {
  getFirestore, collection, addDoc, getDocs, deleteDoc, doc,
  query, orderBy, serverTimestamp
} from 'firebase/firestore'

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
if (firebaseReady) {
  const app = initializeApp(config)
  db = getFirestore(app)
}

const SONGS = 'songs'

export async function saveSong(song) {
  if (!db) throw new Error('Firebase not configured')
  const ref = await addDoc(collection(db, SONGS), {
    title: song.title,
    noteCount: song.noteCount,
    pedalCount: song.pedalCount,
    settings: song.settings,
    midiBase64: song.midiBase64,
    createdAt: serverTimestamp()
  })
  return ref.id
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

export async function deleteSong(id) {
  if (!db) throw new Error('Firebase not configured')
  await deleteDoc(doc(db, SONGS, id))
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
