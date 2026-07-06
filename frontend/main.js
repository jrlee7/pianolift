import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import isDev from 'electron-is-dev'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow
let backendProcess

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
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
  startBackend()
  createWindow()
})

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
