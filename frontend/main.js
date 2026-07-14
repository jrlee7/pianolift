import { app, BrowserWindow, ipcMain, dialog, session, shell } from 'electron'
import { spawn } from 'child_process'
import { writeFile, mkdir, readdir, readFile, rm } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'node:http'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Dev vs packaged: use Electron's own flag rather than the electron-is-dev
// package — it's a devDependency and isn't bundled into the packaged asar
// (importing it crashed the installed app with ERR_MODULE_NOT_FOUND).
const isDev = !app.isPackaged

// Native folder browser + file write for "Save to USB" (the renderer's
// window.showDirectoryPicker is not dependable inside the packaged shell).
ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the folder on your Enspire USB',
    properties: ['openDirectory', 'createDirectory']
  })
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
})

ipcMain.handle('write-file', async (_e, dir, name, bytes) => {
  await writeFile(path.join(dir, name), Buffer.from(bytes))
})

// ---------------------------------------------------------------------------
// Google sign-in (desktop): system-browser OAuth with a loopback redirect +
// PKCE. Firebase's popup sign-in is unreliable in Electron (Google rejects
// embedded/webview flows), so the renderer calls this, gets a Google id_token
// back, and finishes with signInWithCredential. Requires a Google Cloud
// "Desktop app" OAuth client — set PF_GOOGLE_CLIENT_ID / PF_GOOGLE_CLIENT_SECRET
// at build time (a desktop client's secret is not confidential per the OAuth
// installed-app spec; PKCE is the real protection).
// ---------------------------------------------------------------------------
// Desktop OAuth client for Google sign-in. The id/secret live in an untracked
// frontend/oauth.config.json (gitignored — this repo is public) and get bundled
// into the app at build time. A desktop client secret is non-confidential per
// RFC 8252, but keeping it out of version control is still good hygiene. Missing
// config → Google sign-in stays hidden and email/password still works.
let GOOGLE_CLIENT_ID = ''
let GOOGLE_CLIENT_SECRET = ''
try {
  const cfg = JSON.parse(readFileSync(path.join(__dirname, 'oauth.config.json'), 'utf8'))
  GOOGLE_CLIENT_ID = cfg.clientId || ''
  GOOGLE_CLIENT_SECRET = cfg.clientSecret || ''
} catch (e) { /* no oauth config present */ }

const googleConfigured = Boolean(GOOGLE_CLIENT_ID)
ipcMain.handle('app-config', () => ({ googleConfigured }))

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

ipcMain.handle('google-oauth', async () => {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const state = b64url(crypto.randomBytes(16))

  // Loopback server on an ephemeral port catches Google's redirect.
  const server = http.createServer()
  const codeReceived = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;'
        + 'text-align:center;padding-top:48px;background:#0f1115;color:#eee">'
        + '<h2>PianoForge — signed in ✓</h2><p>You can close this tab and '
        + 'return to the app.</p>')
      const err = u.searchParams.get('error')
      if (err) return reject(new Error('Google sign-in was denied (' + err + ')'))
      if (u.searchParams.get('state') !== state) return reject(new Error('OAuth state mismatch'))
      const code = u.searchParams.get('code')
      if (code) resolve(code)
    })
    server.on('error', reject)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const redirectUri = 'http://127.0.0.1:' + server.address().port

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: state,
    prompt: 'select_account'
  }).toString()
  await shell.openExternal(authUrl)

  let code
  try {
    code = await Promise.race([
      codeReceived,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('Sign-in timed out')), 300000))
    ])
  } finally {
    server.close()
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier
    }).toString()
  })
  const tok = await resp.json()
  if (!tok.id_token) {
    throw new Error('Token exchange failed: ' + (tok.error_description || tok.error || 'no id_token'))
  }
  return tok.id_token
})

// ---------------------------------------------------------------------------
// Local song library (paying customers). The cloud library is family-only, so
// customers keep songs on their own machine under userData/library/<id>/:
//   song.json   metadata + baked MIDI (base64)
//   source.mp3  the accompaniment audio (optional)
// ---------------------------------------------------------------------------
function libDir() {
  return path.join(app.getPath('userData'), 'library')
}

ipcMain.handle('lib-list', async () => {
  let entries = []
  try {
    entries = await readdir(libDir(), { withFileTypes: true })
  } catch (e) {
    return [] // no library yet
  }
  const out = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    try {
      out.push(JSON.parse(await readFile(path.join(libDir(), ent.name, 'song.json'), 'utf8')))
    } catch (e) { /* skip unreadable song */ }
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return out
})

ipcMain.handle('lib-save', async (_e, meta, mp3Bytes) => {
  const id = crypto.randomUUID()
  const songDir = path.join(libDir(), id)
  await mkdir(songDir, { recursive: true })
  const hasMp3 = Boolean(mp3Bytes && mp3Bytes.length > 0)
  const record = { ...meta, id: id, hasMp3: hasMp3, createdAt: Date.now() }
  await writeFile(path.join(songDir, 'song.json'), JSON.stringify(record))
  if (hasMp3) await writeFile(path.join(songDir, 'source.mp3'), Buffer.from(mp3Bytes))
  return record
})

ipcMain.handle('lib-mp3', async (_e, id) => {
  try {
    return new Uint8Array(await readFile(path.join(libDir(), id, 'source.mp3')))
  } catch (e) {
    return null
  }
})

ipcMain.handle('lib-rename', async (_e, id, title) => {
  const p = path.join(libDir(), id, 'song.json')
  const meta = JSON.parse(await readFile(p, 'utf8'))
  meta.title = title
  await writeFile(p, JSON.stringify(meta))
  return meta
})

ipcMain.handle('lib-delete', async (_e, id) => {
  await rm(path.join(libDir(), id), { recursive: true, force: true })
})

let mainWindow
let backendProcess

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    // dist/ is bundled next to main.js inside app.asar; loadFile resolves the
    // asar + Windows path correctly (a file:// URL to ../dist was wrong — that
    // points outside the asar and left a blank window).
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'))
  }

  if (isDev) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function startBackend() {
  if (isDev) {
    const backendPath = path.join(__dirname, '../backend')
    backendProcess = spawn('python', ['-m', 'uvicorn', 'app.main:app', '--port', '8000'], {
      cwd: backendPath,
      stdio: 'inherit'
    })
  } else {
    // In production, backend.exe is in the app resources directory
    let exePath
    if (process.platform === 'win32') {
      // Try current directory first, then parent
      const candidates = [
        path.join(process.resourcesPath, 'backend.exe'),
        path.join(__dirname, '../backend.exe'),
        path.join(__dirname, './backend.exe')
      ]
      exePath = candidates.find(p => {
        try {
          require('fs').accessSync(p)
          return true
        } catch {
          return false
        }
      })
      if (!exePath) {
        console.error('backend.exe not found in:', candidates)
        return
      }
    }

    backendProcess = spawn(exePath, {
      stdio: 'inherit'
    })
  }

  backendProcess.on('error', (err) => {
    console.error('Backend failed:', err)
  })
}

app.on('ready', () => {
  // Web MIDI (the video-sync player streaming to the Disklavier's USB TO
  // HOST port) needs the 'midi' permission. Electron grants requests by
  // default, but be explicit so a future Electron default-flip can't
  // silently kill live playback.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(true)
  })
  session.defaultSession.setPermissionCheckHandler(() => true)
  startBackend()
  createWindow()
  if (!isDev) checkForUpdates()
})

// Auto-update: on launch (production only) check the public releases feed and,
// once a newer version has downloaded, prompt to restart & install. The feed is
// configured by the "publish" block in package.json (github jrlee7/pianolift-releases);
// updates trigger only when package.json "version" is bumped for a new release.
function checkForUpdates() {
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      title: 'Update ready',
      message: 'PianoForge ' + info.version + ' has been downloaded.',
      detail: 'Restart to install the update.'
    }).then((res) => { if (res.response === 0) autoUpdater.quitAndInstall() })
  })
  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err ? (err.stack || err).toString() : 'unknown')
  })
  autoUpdater.checkForUpdates().catch((e) => console.error('checkForUpdates failed:', e))
}

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill()
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})
