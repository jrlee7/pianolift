import { app, BrowserWindow, ipcMain, dialog, session } from 'electron'
import { spawn } from 'child_process'
import { writeFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import isDev from 'electron-is-dev'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

  const startUrl = isDev
    ? 'http://localhost:5173'
    : `file://${path.join(__dirname, '../dist/index.html')}`

  mainWindow.loadURL(startUrl)

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
