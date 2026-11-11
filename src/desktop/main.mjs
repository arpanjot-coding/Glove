// SPDX-License-Identifier: MIT
import { app, BrowserWindow, Menu, dialog, ipcMain, clipboard, shell, powerMonitor } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { AndroidService } from './android.mjs';
import { ShareService } from '../sharing/service.mjs';
import { ViewService } from '../viewing/service.mjs';
import { PersonalService } from '../personal/service.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let window, android, sharing, viewing, personal, settings;
let installerShare = null;
let quitting = false;
let toolsReady = false;
let companionApkReady = false;
let settingsWrite = Promise.resolve();
let fileAction = Promise.resolve();
const fileActions = new Set(['chooseReceiveFolder', 'startSharing', 'stopSharing', 'shareCompanionApk', 'addFiles', 'removeFile']);
const devUrl = !app.isPackaged && process.env.GLOVE_DEV_URL === 'http://127.0.0.1:5190' ? process.env.GLOVE_DEV_URL : null;
const companionApk = app.isPackaged
  ? join(process.resourcesPath, 'Glove-Companion.apk')
  : join(here, '../../android/out/Glove-Companion.apk');
const settingsPath = () => join(app.getPath('userData'), 'settings.json');
const activeSharing = () => installerShare || sharing;
const state = () => ({
  version: app.getVersion(),
  window: { maximized: window?.isMaximized() || false },
  settings, toolsReady, companionApkReady, installerSharing: Boolean(installerShare),
  personal: personal.snapshot(),
  android: android.snapshot(),
  sharing: activeSharing().snapshot(),
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
function saveSettings() {
  const data = JSON.stringify(settings, null, 2);
  const previous = settingsWrite;
  settingsWrite = previous.catch(() => {}).then(async () => {
    const target = settingsPath();
    const temporary = target + '.tmp';
    try {
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  });
  return settingsWrite;
}

function runAction(name, data) {
  const run = () => {
    if (quitting) throw new Error('Glove is closing.');
    return action(name, data);
  };
  if (!fileActions.has(name)) return run();
  const pending = fileAction.then(run);
  fileAction = pending.catch(() => {});
  return pending;
}

async function updateToolsReady() {
  const toolsFolder = settings.toolsFolder;
  const ready = await android.ready();
  if (settings.toolsFolder === toolsFolder) {
    toolsReady = ready;
    push();
  }
}
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
      if (selected && !quitting && selected !== settings.toolsFolder) {
        settings.toolsFolder = selected;
        android.toolsChanged();
        toolsReady = false;
        push();
        await Promise.all([updateToolsReady(), saveSettings()]);
      }
      return state();
    }
    case 'chooseReceiveFolder': {
      if (activeSharing().snapshot().running) throw new Error('Stop file sharing before changing the receive folder.');
      const selected = await folder('Choose where phone uploads are saved', settings.receiveFolder);
      if (selected && !quitting) {
        await sharing.setReceiveDir(selected);
        settings.receiveFolder = selected;
        push();
        await saveSettings();
      }
      return state();
    }
    case 'openReceiveFolder': {
      await mkdir(settings.receiveFolder, { recursive: true });
      const error = await shell.openPath(settings.receiveFolder);
      if (error) throw new Error(error);
      return;
    }
    case 'openToolGuide': return shell.openExternal('https://github.com/Genymobile/scrcpy/blob/master/doc/windows.md');
    case 'startPersonalPairing': return personal.startPairing();
    case 'stopPersonalPairing': return personal.stopPairing();
    case 'denyPersonalPairing': {
      if (typeof data?.id !== 'string') throw new Error('Choose the current pairing request.');
      return personal.stopPairing(data.id);
    }
    case 'approvePersonalPairing': return personal.approvePairing(data?.id);
    case 'setPersonalPaused': return personal.setPaused(data?.paused);
    case 'forgetPersonalDevice': return personal.forget();
    case 'sendPersonalReply': return personal.sendReply(data?.id, data?.text);
    case 'shareCompanionApk': {
      if (!companionApkReady) throw new Error('The Android companion installer is unavailable in this build.');
      if (installerShare || sharing.snapshot().running) throw new Error('Stop the current file-sharing session before sharing the Android installer.');
      const session = new ShareService({ receiveDir: settings.receiveFolder, onChange: push, allowUploads: false });
      installerShare = session;
      try {
        await session.start();
        return await session.addFiles([companionApk]);
      } catch (error) {
        await session.stop();
        if (installerShare === session) installerShare = null;
        push();
        throw error;
      }
    }
    case 'refreshAndroid': return android.refresh();
    case 'pairAndroid': return android.pair(data?.address, data?.code);
    case 'connectAndroid': return android.connect(data?.address);
    case 'startAndroidQr': return android.startQr();
    case 'stopAndroidQr': return android.stopQr();
    case 'mirrorAndroid': return android.start(data?.serial);
    case 'stopAndroid': return android.stop();
    case 'startSharing': {
      const session = activeSharing();
      await session.start();
      return session.snapshot();
    }
    case 'stopSharing': {
      const session = activeSharing();
      await session.stop();
      if (installerShare === session) installerShare = null;
      push();
      return activeSharing().snapshot();
    }
    case 'addFiles': {
      if (installerShare) throw new Error('Stop sharing the Android installer before starting a file transfer.');
      const result = await dialog.showOpenDialog(window, { title: 'Choose files to send to your phone', properties: ['openFile', 'multiSelections'] });
      if (!result.canceled && !quitting) return sharing.addFiles(result.filePaths);
      return sharing.snapshot();
    }
    case 'removeFile': if (typeof data?.id !== 'string') throw new Error('Invalid file.'); return activeSharing().remove(data.id);
    case 'startViewing': return viewing.start();
    case 'stopViewing': return viewing.stop();
    case 'answerViewing': return viewing.answer(data);
    case 'viewingConnected': return viewing.setConnected(data);
    case 'copyMcpConfig': {
      if (typeof data?.serial !== 'string' || !['codex', 'json'].includes(data?.format)) {
        throw new Error('Choose an Android device and an MCP client format.');
      }
      const toolsFolder = settings.toolsFolder;
      const devices = await android.refresh();
      if (quitting || settings.toolsFolder !== toolsFolder ||
          !devices.some(device => device.serial === data.serial && device.status === 'device')) {
        throw new Error('This Android device is no longer connected. Refresh the device list.');
      }
      const entry = app.isPackaged
        ? join(process.resourcesPath, 'mcp', 'main.mjs')
        : join(here, '..', 'mcp', 'main.mjs');
      const args = [entry, '--adb', join(toolsFolder, 'adb.exe'), '--device', data.serial];
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
    personal = new PersonalService({ dataDir: join(app.getPath('userData'), 'personal'), onChange: push });
    powerMonitor.on('lock-screen', () => personal.setLocked(true));
    powerMonitor.on('unlock-screen', () => personal.setLocked(false));
    const idleState = powerMonitor.getSystemIdleState(60);
    if (idleState === 'locked') personal.setLocked(true);
    await Promise.all([
      personal.restore(),
      stat(companionApk).then(info => { companionApkReady = info.isFile(); }).catch(() => {}),
    ]);
    window = new BrowserWindow({ width: 1280, height: 880, minWidth: 980, minHeight: 720, show: false, frame: false, title: 'Glove', backgroundColor: '#f4f6fa', icon: join(here, '../../assets/glove.ico'), webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    window.on('maximize', push); window.on('unmaximize', push);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.handle('glove:action', async (event, name, data) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: 'Untrusted sender.' };
      try { return { ok: true, value: await runAction(name, data) }; } catch (error) { return { ok: false, error: String(error.message || error).slice(0, 2000) }; }
    });
    Menu.setApplicationMenu(null);
    if (devUrl) await window.loadURL(devUrl); else await window.loadFile(join(here, '../../dist/index.html'));
    window.show();
    await updateToolsReady();
  }).catch(error => { dialog.showErrorBox('Glove could not start', error.stack || error.message); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    android?.stop();
    Promise.allSettled([sharing?.stop(), installerShare?.stop(), viewing?.stop(), personal?.stop(), settingsWrite]).finally(() => app.quit());
  });
}
