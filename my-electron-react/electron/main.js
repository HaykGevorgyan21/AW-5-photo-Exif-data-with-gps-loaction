// file: electron/main.js  (վստահելի ուղի packaged app-ի համար)
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isDev = !app.isPackaged

async function createWindow () {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (isDev) {
    await win.loadURL('http://localhost:5173')
  } else {
    // ❗ dist/ պետք է լինի APP-ի մեջ, ոչ թե resources/dist
    const indexPath = path.join(app.getAppPath(), 'dist', 'index.html')
    console.log('[main] load:', indexPath)
    await win.loadFile(indexPath)
    // Debug helpers
    win.webContents.on('did-fail-load', (_e,c,d,u)=>console.error('did-fail-load',c,d,u))

  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
ipcMain.handle('ping', () => 'pong')
