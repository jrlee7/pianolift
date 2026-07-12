// Preload (CommonJS: the package is "type":"module", so a plain .js here would
// be parsed as ESM and `require` would be undefined). Exposes a minimal native
// bridge so the renderer can open a real OS folder browser and write files
// straight to the chosen folder — needed because window.showDirectoryPicker is
// not reliably available inside the packaged Electron shell.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  // Open the native "choose folder" dialog. Resolves to the absolute path, or
  // null if the user cancelled.
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  // Write one file into a previously picked folder. `bytes` is a Uint8Array.
  writeFile: (dir, name, bytes) => ipcRenderer.invoke('write-file', dir, name, bytes),
  // Google sign-in via the system browser (loopback + PKCE). Resolves to a
  // Google id_token the renderer hands to Firebase signInWithCredential.
  googleSignIn: () => ipcRenderer.invoke('google-oauth'),
  // Customer local song library (on-device, under userData/library).
  localLibrary: {
    list: () => ipcRenderer.invoke('lib-list'),
    save: (meta, mp3Bytes) => ipcRenderer.invoke('lib-save', meta, mp3Bytes),
    mp3: (id) => ipcRenderer.invoke('lib-mp3', id),
    rename: (id, title) => ipcRenderer.invoke('lib-rename', id, title),
    delete: (id) => ipcRenderer.invoke('lib-delete', id)
  }
})
