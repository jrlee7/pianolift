import { initializeApp } from 'firebase/app'
import {
  getFirestore, collection, addDoc, getDocs, deleteDoc, doc, getDoc, setDoc,
  updateDoc, runTransaction, increment, query, orderBy, where, serverTimestamp
} from 'firebase/firestore'
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from 'firebase/storage'
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithCredential, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, signOut as fbSignOut
} from 'firebase/auth'

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
let auth = null
if (firebaseReady) {
  const app = initializeApp(config)
  db = getFirestore(app)
  auth = getAuth(app)
  // Storage holds the source MP3s — too big for a Firestore doc (1 MiB cap).
  // Only usable if a storageBucket is set in the web config.
  if (config.storageBucket) storage = getStorage(app)
}

// ---------------------------------------------------------------------------
// Accounts & licensing
//
// The single shared "family" account (you + Dad) gets unlimited conversions and
// the cloud library. Everyone else is a paying customer: 5 free conversions,
// then a single-use activation key unlocks unlimited. Enforcement is
// server-verified via Firestore rules (single-use key claim, per-user state),
// but because the ML runs locally a determined user can still patch the client
// — this stops casual sharing, not a cracked build.
// ---------------------------------------------------------------------------
const FAMILY_EMAIL = 'justin.lee025@gmail.com'
export const FREE_LIMIT = 5
const USERS = 'users'
const LICENSES = 'licenses'

export function authReady() { return Boolean(auth) }

// Subscribe to sign-in state. Returns an unsubscribe fn.
export function onAuth(cb) {
  if (!auth) { cb(null); return function () {} }
  return onAuthStateChanged(auth, cb)
}

export function currentUser() { return auth ? auth.currentUser : null }

export async function signInWithGoogle() {
  if (!auth) throw new Error('Firebase not configured')
  // Packaged desktop app: system-browser OAuth via the main process (the popup
  // is unreliable in Electron). Browser/dev: fall back to Firebase's popup.
  if (typeof window !== 'undefined' && window.desktop && window.desktop.googleSignIn) {
    const idToken = await window.desktop.googleSignIn()
    const res = await signInWithCredential(auth, GoogleAuthProvider.credential(idToken))
    return res.user
  }
  const res = await signInWithPopup(auth, new GoogleAuthProvider())
  return res.user
}

export async function signInEmail(email, password) {
  if (!auth) throw new Error('Firebase not configured')
  const res = await signInWithEmailAndPassword(auth, email.trim(), password)
  return res.user
}

export async function signUpEmail(email, password) {
  if (!auth) throw new Error('Firebase not configured')
  const res = await createUserWithEmailAndPassword(auth, email.trim(), password)
  try { await sendEmailVerification(res.user) } catch (e) { /* non-fatal */ }
  return res.user
}

export async function signOut() { if (auth) await fbSignOut(auth) }

// The family account is identified by a verified email match — must line up
// with isFamily() in firestore.rules / storage.rules.
export function isFamilyUser(user) {
  return Boolean(user && user.email === FAMILY_EMAIL && user.emailVerified)
}

// Snapshot of a user's entitlement. Family = unlimited; customers get their
// server-side conversion counter + activation flag. Creates the user doc on
// first call so the counter has somewhere to live.
export async function getAccount(user) {
  if (!user) return null
  if (isFamilyUser(user)) {
    return { family: true, activated: true, conversions: 0, remaining: Infinity }
  }
  const uref = doc(db, USERS, user.uid)
  const snap = await getDoc(uref)
  if (!snap.exists()) {
    await setDoc(uref, { conversions: 0, activated: false, createdAt: serverTimestamp() })
    return { family: false, activated: false, conversions: 0, remaining: FREE_LIMIT }
  }
  const d = snap.data()
  const activated = Boolean(d.activated)
  const conversions = d.conversions || 0
  return {
    family: false, activated: activated, conversions: conversions,
    remaining: activated ? Infinity : Math.max(0, FREE_LIMIT - conversions)
  }
}

// Count one conversion against the free tier (no-op for family / activated).
export async function recordConversion(user) {
  if (!user || isFamilyUser(user)) return
  await setDoc(doc(db, USERS, user.uid), { conversions: increment(1) }, { merge: true })
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf)).map(function (b) {
    return b.toString(16).padStart(2, '0')
  }).join('')
}

// Claim an activation key (single-use, enforced by rules), then flag the
// account activated. Idempotent if the same user re-enters a key they already
// own (covers a retry after a mid-activation failure).
export async function activateKey(user, rawKey) {
  if (!user) throw new Error('Sign in first')
  const key = (rawKey || '').trim().toUpperCase()
  if (!key) throw new Error('Enter an activation key')
  const hash = await sha256Hex(key)
  const lref = doc(db, LICENSES, hash)
  await runTransaction(db, async function (tx) {
    const snap = await tx.get(lref)
    if (!snap.exists()) throw new Error('Invalid activation key')
    const d = snap.data()
    if (d.used && d.usedBy !== user.uid) {
      throw new Error('This key has already been used')
    }
    if (!d.used) {
      tx.update(lref, { used: true, usedBy: user.uid, usedAt: serverTimestamp() })
    }
  })
  await setDoc(doc(db, USERS, user.uid),
    { activated: true, licenseHash: hash }, { merge: true })
  return true
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
