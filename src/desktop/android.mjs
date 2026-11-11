// SPDX-License-Identifier: MIT
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);
export function endpoint(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Enter the phone IP address and port, for example 192.168.1.5:37123.');
  const match = value.trim().match(/^(\[[0-9a-fA-F:]+\]|[0-9.]+):([0-9]{1,5})$/);
  if (!match || !isIP(match[1].replace(/^\[|\]$/g, '')) || +match[2] < 1 || +match[2] > 65535) throw new Error('Use a valid IP address and port from Wireless debugging.');
  return `${match[1]}:${Number(match[2])}`;
}
export function parseDevices(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(\S+)\s+(device|offline|unauthorized|no permissions|authorizing|connecting|bootloader|recovery|sideload|rescue|host|unknown)(?:\s+(.*))?$/);
    if (!match) return [];
    const [, serial, status, details] = match;
    const model = details?.match(/\bmodel:(\S+)/)?.[1]?.replaceAll('_', ' ') || serial;
    return [{ serial, status, model }];
  });
}
export function parseMdnsServices(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(\S+)\s+(_adb(?:-tls-(?:pairing|connect))?\._tcp)\.?\s+(\S+)\s*$/);
    if (!match) return [];
    try { return [{ name: match[1], type: match[2], address: endpoint(match[3]) }]; }
    catch { return []; }
  });
}
const QR_CONNECT_HELP = 'Phone paired, but its wireless connection was not established. Use Connect with the IP address and port from the main Wireless debugging screen, not the pairing port. Check that both devices use the same Wi-Fi.';
const QR_MDNS_HELP = 'ADB network discovery is unavailable. Select a current scrcpy tools folder in Settings. Allow adb.exe on your private Wi-Fi network, or use the pairing-code and IP address connection options.';
const qrState = (status = 'idle', error = '') => ({ active: false, value: '', expiresAt: null, status, ...(error ? { error } : {}) });
const transportGuid = serial => serial.replace(/\._adb-tls-connect\._tcp(?:\.local)?\.?$/, '');

export class AndroidService {
  constructor({ getFolder, onChange = () => {}, qrPollMs = 1500, qrTimeoutMs = 120000 }) {
    if (!Number.isFinite(qrPollMs) || qrPollMs < 5 || !Number.isFinite(qrTimeoutMs) || qrTimeoutMs < 20) throw new Error('Invalid QR polling interval or timeout.');
    this.getFolder = getFolder;
    this.onChange = onChange;
    this.devices = [];
    this.mirror = null;
    this.lastError = '';
    this.qr = qrState();
    this.qrPollMs = qrPollMs;
    this.qrTimeoutMs = qrTimeoutMs;
    this.qrGeneration = 0;
    this.qrTimer = null;
    this.qrExpiryTimer = null;
    this.qrController = null;
  }
  async ready() {
    const folder = this.getFolder();
    if (!folder) return false;
    return Promise.all(['adb.exe', 'scrcpy.exe'].map(async name => (await stat(join(folder, name)).catch(() => null))?.isFile() || false)).then(flags => flags.every(Boolean));
  }
  async run(args, { signal } = {}) {
    if (!await this.ready()) throw new Error('Choose an extracted scrcpy tools folder in Settings. It must contain adb.exe and scrcpy.exe.');
    const { stdout, stderr } = await exec(join(this.getFolder(), 'adb.exe'), args, { cwd: this.getFolder(), shell: false, windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024, signal });
    return `${stdout}\n${stderr}`.trim();
  }
  async refresh() {
    this.devices = parseDevices(await this.run(['devices', '-l']));
    this.onChange();
    return this.devices;
  }
  async pair(address, code) {
    const target = endpoint(address);
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('Enter the six-digit pairing code shown on the phone.');
    const result = await this.run(['pair', target, code]);
    if (!/successfully paired/i.test(result)) throw new Error(result.slice(0, 700) || 'Pairing failed. Check the pairing address and code.');
    return 'Phone paired. Now use the IP address and port from the main Wireless debugging screen to connect.';
  }
  async connect(address) {
    const result = await this.run(['connect', endpoint(address)]);
    if (!/(?:^|\n)(?:already )?connected to /i.test(result)) throw new Error(result.slice(0, 700) || 'Connection failed. Check the connection port and Wi-Fi network.');
    await this.refresh();
    return result;
  }
  async startQr() {
    this.stopQr();
    const generation = this.qrGeneration;
    const controller = this.qrController = new AbortController();
    const folder = this.getFolder();
    this.qr = { ...qrState('preparing'), active: true };
    this.onChange();
    try {
      if (!await this.ready()) throw new Error('Choose an extracted scrcpy tools folder in Settings. It must contain adb.exe and scrcpy.exe.');
      if (!this.qrCurrent(generation)) return this.snapshot();
      const mdns = await this.run(['mdns', 'check'], { signal: controller.signal });
      if (!this.qrCurrent(generation)) return this.snapshot();
      if (!/mdns|discovery|openscreen|bonjour|libadbmdns/i.test(mdns) || /(?:unknown|unavailable|disabled|not available|not supported|error|failed)/i.test(mdns)) throw new Error(QR_MDNS_HELP);
      this.qrFolder = folder;
      this.qrServiceName = `studio-${randomBytes(10).toString('hex')}`;
      this.qrSecret = randomBytes(16).toString('hex');
      this.qrPairing = null;
      this.qrConnectAttempts = new Set();
      this.qr = { active: true, value: `WIFI:T:ADB;S:${this.qrServiceName};P:${this.qrSecret};;`, expiresAt: Date.now() + this.qrTimeoutMs, status: 'waiting' };
      this.qrExpiryTimer = setTimeout(() => this.finishQr(generation, this.qrPairing ? 'error' : 'expired', this.qrPairing ? QR_CONNECT_HELP : 'QR code expired. Generate a new code, then scan it from Developer options → Wireless debugging → Pair device with QR code.'), this.qrTimeoutMs);
      this.qrExpiryTimer.unref?.();
      this.onChange();
      this.scheduleQr(generation, 0);
      return this.snapshot();
    } catch (error) {
      if (!this.qrCurrent(generation)) return this.snapshot();
      const message = error.message.startsWith('Choose an extracted') ? error.message : QR_MDNS_HELP;
      this.finishQr(generation, 'error', message);
      throw new Error(message);
    }
  }
  qrCurrent(generation) { return this.qrGeneration === generation && this.qr.active; }
  scheduleQr(generation, delay = this.qrPollMs) {
    if (!this.qrCurrent(generation)) return;
    clearTimeout(this.qrTimer);
    this.qrTimer = setTimeout(() => this.pollQr(generation), delay);
    this.qrTimer.unref?.();
  }
  async pollQr(generation) {
    if (!this.qrCurrent(generation)) return;
    this.qrTimer = null;
    try {
      if (this.getFolder() !== this.qrFolder) return this.finishQr(generation, 'error', 'The tools folder changed. Generate a new QR code to use the selected tools.');
      const options = { signal: this.qrController.signal };
      const output = await this.run(['mdns', 'services'], options);
      if (!this.qrCurrent(generation)) return;
      if (/(?:unknown command|mdns.*(?:unavailable|disabled|not supported)|^error:)/im.test(output)) return this.finishQr(generation, 'error', QR_MDNS_HELP);
      const services = parseMdnsServices(output);
      if (!this.qrPairing) {
        const found = services.find(service => service.name === this.qrServiceName && service.type === '_adb-tls-pairing._tcp');
        if (found) {
          this.qr.status = 'pairing';
          this.onChange();
          const result = await this.run(['pair', found.address, this.qrSecret], options);
          if (!this.qrCurrent(generation)) return;
          if (!/(?:^|\n)Successfully paired to /i.test(result)) return this.finishQr(generation, 'error', 'QR pairing failed. Generate a new QR code, keep the phone pairing screen open, and check the Wi-Fi network.');
          const guid = result.match(/\[guid=([^\]\r\n]+)\]/)?.[1];
          this.qrPairing = { address: found.address, guid };
          this.qr.status = 'connecting';
          this.onChange();
        }
      }
      if (this.qrPairing) {
        const { address: pairingAddress, guid } = this.qrPairing;
        // ADB normally auto-connects by the authenticated GUID returned from
        // pairing. A fallback uses only that GUID's separately advertised TLS
        // connection service, never the QR pairing port or an unrelated phone.
        const connectServices = guid ? services.filter(service => service.name === guid && service.type === '_adb-tls-connect._tcp' && service.address !== pairingAddress) : [];
        let devices = parseDevices(await this.run(['devices', '-l'], options));
        if (!this.qrCurrent(generation)) return;
        let connected = devices.some(device => device.status === 'device' && ((guid && transportGuid(device.serial) === guid) || connectServices.some(service => service.address === device.serial)));
        if (!connected) {
          const fallback = connectServices.find(service => !this.qrConnectAttempts.has(service.address));
          if (fallback) {
            this.qrConnectAttempts.add(fallback.address);
            await this.run(['connect', fallback.address], options);
            if (!this.qrCurrent(generation)) return;
            devices = parseDevices(await this.run(['devices', '-l'], options));
            if (!this.qrCurrent(generation)) return;
            connected = devices.some(device => device.status === 'device' && ((guid && transportGuid(device.serial) === guid) || connectServices.some(service => service.address === device.serial)));
          }
        }
        this.devices = devices;
        if (connected) return this.finishQr(generation, 'connected');
        this.onChange();
      }
      this.scheduleQr(generation);
    } catch {
      // execFile errors can contain its entire command, including the QR
      // password. Never expose those errors in state, logs, or IPC responses.
      if (this.qrCurrent(generation)) this.finishQr(generation, 'error', this.qrPairing ? QR_CONNECT_HELP : 'QR pairing could not continue. Check the tools folder, Wi-Fi network and Windows access for adb.exe, then generate a new code.');
    }
  }
  finishQr(generation, status, error = '') {
    if (!this.qrCurrent(generation)) return this.snapshot();
    return this.stopQr({ status, error });
  }
  stopQr({ status = 'cancelled', error = '' } = {}) {
    this.qrGeneration++;
    clearTimeout(this.qrTimer);
    clearTimeout(this.qrExpiryTimer);
    this.qrTimer = null;
    this.qrExpiryTimer = null;
    this.qrController?.abort();
    this.qrController = null;
    this.qrSecret = null;
    this.qrServiceName = null;
    this.qrPairing = null;
    this.qrConnectAttempts = null;
    this.qr = qrState(status, error);
    this.onChange();
    return this.snapshot();
  }
  async start(serial) {
    if (this.mirror) throw new Error('A mirror is already open. Close it before starting another.');
    await this.refresh();
    if (typeof serial !== 'string' || !this.devices.some(d => d.serial === serial && d.status === 'device')) throw new Error('Refresh devices and select an authorized phone.');
    const child = spawn(join(this.getFolder(), 'scrcpy.exe'), ['--serial', serial, '--window-title=Glove - Android', '--max-size=1920'], { cwd: this.getFolder(), shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.mirror = child;
    this.lastError = '';
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-2000); });
    const finish = (message = '') => {
      if (this.mirror !== child) return;
      this.mirror = null;
      this.lastError = message;
      this.onChange();
    };
    child.on('error', error => finish(error.message));
    child.on('exit', code => finish(code ? errors || `Screen mirror exited (${code}).` : ''));
    this.onChange();
    return 'Opening the Android screen in a separate window.';
  }
  stop() {
    this.stopQr();
    const child = this.mirror;
    this.mirror = null;
    child?.kill();
    this.onChange();
  }
  snapshot() { return { devices: this.devices.map(device => ({ ...device })), mirroring: !!this.mirror, error: this.lastError, qr: { ...this.qr } }; }
}
