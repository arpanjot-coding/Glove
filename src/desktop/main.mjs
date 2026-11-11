// SPDX-License-Identifier: MIT
import { app, BrowserWindow, Menu, dialog, ipcMain, clipboard, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { AndroidService } from './android.mjs';
import { ShareService } from '../sharing/service.mjs';
import { ViewService } from '../viewing/service.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let window, android, sharing, viewing, settings;
let quitting = false;
let toolsReady = false;
const devUrl = !app.isPackaged && process.env.GLOVE_DEV_URL === 'http://127.0.0.1:5190' ? process.env.GLOVE_DEV_URL : null;
const settingsPath = () => join(app.getPath('userData'), 'settings.json');
const state = () => ({
  version: app.getVersion(),
  window: { maximized: window?.isMaximized() || false },
  settings, toolsReady,
  android: android.snapshot(),
  sharing: sharing.snapshot(),
  viewing: viewing.snapshot(),
});
let pushPending = false;
function push() {
  if (pushPending || quitting) return;
  pushPending = true;
  setTimeout(() => {
    pushPending = false;
    try { if (window && !window.isDestroyed()) window.webContents.send('glove:state', state()); } catch (error) { console.error('State update:', error.message); }
  }, 20);
}
async function saveSettings() { await writeFile(settingsPath(), JSON.stringify(settings, null, 2)); }
async function folder(title, defaultPath) {
  const result = await dialog.showOpenDialog(window, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
}
async function action(name, data) {
  switch (name) {
    case 'windowMinimize': window.minimize(); return;
    case 'windowToggleMaximize': if (window.isMaximized()) window.unmaximize(); else window.maximize(); return;
    case 'windowClose': window.close(); return;
    case 'state': return state();
    case 'chooseTools': {
      const selected = await folder('Choose extracted scrcpy tools', settings.toolsFolder || app.getPath('downloads'));
      if (selected) {
        settings.toolsFolder = selected;
        toolsReady = await android.ready();
        await saveSettings();
        push();
      }
      return state();
    }
    case 'chooseReceiveFolder': {
      if (sharing.snapshot().running) throw new Error('Stop file sharing before changing the receive folder.');
      const selected = await folder('Choose where phone uploads are saved', settings.receiveFolder);
      if (selected) { await sharing.setReceiveDir(selected); settings.receiveFolder = selected; await saveSettings(); push(); }
      return state();
    }
    case 'openReceiveFolder': {
      await mkdir(settings.receiveFolder, { recursive: true });
      const error = await shell.openPath(settings.receiveFolder);
      if (error) throw new Error(error);
      return;
    }
    case 'openToolGuide': return shell.openExternal('https://github.com/Genymobile/scrcpy/blob/master/doc/windows.md');
    case 'refreshAndroid': return android.refresh();
    case 'pairAndroid': return android.pair(data?.address, data?.code);
    case 'connectAndroid': return android.connect(data?.address);
    case 'startAndroidQr': return android.startQr();
    case 'stopAndroidQr': return android.stopQr();
    case 'mirrorAndroid': return android.start(data?.serial);
    case 'stopAndroid': return android.stop();
    case 'startSharing': return sharing.start();
    case 'stopSharing': return sharing.stop();
    case 'addFiles': {
      const result = await dialog.showOpenDialog(window, { title: 'Choose files to send to your phone', properties: ['openFile', 'multiSelections'] });
      if (!result.canceled) return sharing.addFiles(result.filePaths);
      return sharing.snapshot();
    }
    case 'removeFile': if (typeof data?.id !== 'string') throw new Error('Invalid file.'); return sharing.remove(data.id);
    case 'startViewing': return viewing.start();
    case 'stopViewing': return viewing.stop();
    case 'answerViewing': return viewing.answer(data);
    case 'viewingConnected': return viewing.setConnected(data);
    case 'copyMcpConfig': {
      if (typeof data?.serial !== 'string' || !['codex', 'json'].includes(data?.format)) {
        throw new Error('Choose an Android device and an MCP client format.');
      }
      const devices = await android.refresh();
      if (!devices.some(device => device.serial === data.serial && device.status === 'device')) {
        throw new Error('This Android device is no longer connected. Refresh the device list.');
      }
      const entry = app.isPackaged
        ? join(process.resourcesPath, 'mcp', 'main.mjs')
        : join(here, '..', 'mcp', 'main.mjs');
      const args = [entry, '--adb', join(settings.toolsFolder, 'adb.exe'), '--device', data.serial];
      const config = data.format === 'codex'
        ? '[mcp_servers.glove]\ncommand = "node"\nargs = ' + JSON.stringify(args) + '\n'
        : JSON.stringify({ mcpServers: { glove: { command: 'node', args } } }, null, 2);
      clipboard.writeText(config);
      return 'Read-only MCP configuration copied.';
    }
    case 'copyText': if (typeof data?.text !== 'string' || data.text.length > 10000) throw new Error('Invalid clipboard text.'); clipboard.writeText(data.text); return;
    default: throw new Error('Unknown action.');
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true });
    const saved = await readFile(settingsPath(), 'utf8').then(JSON.parse).catch(() => ({}));
    settings = { toolsFolder: typeof saved.toolsFolder === 'string' ? saved.toolsFolder : '', receiveFolder: typeof saved.receiveFolder === 'string' ? saved.receiveFolder : join(app.getPath('downloads'), 'Glove') };
    android = new AndroidService({ getFolder: () => settings.toolsFolder, onChange: push });
    sharing = new ShareService({ receiveDir: settings.receiveFolder, onChange: push });
    viewing = new ViewService({ dataDir: join(app.getPath('userData'), 'certificates'), onChange: push });
    window = new BrowserWindow({ width: 1280, height: 880, minWidth: 980, minHeight: 720, show: false, frame: false, title: 'Glove', backgroundColor: '#f4f6fa', icon: join(here, '../../assets/glove.ico'), webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    window.on('maximize', push); window.on('unmaximize', push);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.handle('glove:action', async (event, name, data) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: 'Untrusted sender.' };
      try { return { ok: true, value: await action(name, data) }; } catch (error) { return { ok: false, error: String(error.message || error).slice(0, 2000) }; }
    });
    Menu.setApplicationMenu(null);
    if (devUrl) await window.loadURL(devUrl); else await window.loadFile(join(here, '../../dist/index.html'));
    window.show();
    toolsReady = await android.ready();
    push();
  }).catch(error => { dialog.showErrorBox('Glove could not start', error.stack || error.message); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    android?.stop();
    Promise.allSettled([sharing?.stop(), viewing?.stop()]).finally(() => app.quit());
  });
}
