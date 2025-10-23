// electron/main.js
const { app, BrowserWindow } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'), // ok even if empty
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173'); // Vite dev server
    win.webContents.openDevTools();       // տես React console errors
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  win.on('closed', () => win = null);
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
