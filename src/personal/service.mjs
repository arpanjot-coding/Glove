// SPDX-License-Identifier: MIT
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

const PAIR_MS = 120_000;
const ONLINE_MS = 12_000;
const REPLY_MS = 15_000;
const MAX_BODY = 512 * 1024;
const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const idIs = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const textIs = (value, limit) => typeof value === 'string' && value.length <= limit && !value.includes('\0');
const matches = (secretHash, candidate) => Boolean(secretHash && candidate && timingSafeEqual(Buffer.from(secretHash, 'hex'), Buffer.from(digest(candidate), 'hex')));
const httpError = (status, message) => Object.assign(new Error(message), { status });

function localIpv4(address) {
  return /^(127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/.test(address || '');
}

function preferredAddress() {
  const adapters = Object.entries(networkInterfaces()).sort(([a], [b]) => {
    const physical = name => /^(?:wi-?fi|ethernet|wlan|eth)/i.test(name);
    return Number(physical(b)) - Number(physical(a));
  });
  return adapters.flatMap(([, addresses]) => addresses || [])
    .find(item => item.family === 'IPv4' && !item.internal && localIpv4(item.address))?.address;
}

function respond(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw httpError(415, 'Use application/json.');
  if (Number(request.headers['content-length']) > MAX_BODY) throw httpError(413, 'Request too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Invalid JSON gets the same response. */ }
  throw httpError(400, 'Invalid JSON.');
}

function readNotifications(payload) {
  if (typeof payload.access !== 'boolean' || !Array.isArray(payload.notifications) || payload.notifications.length > 50) {
    throw httpError(400, 'Invalid notification snapshot.');
  }
  const seen = new Set();
  return payload.notifications.map(item => {
    if (!item || !idIs(item.id) || seen.has(item.id) || !textIs(item.title, 160) ||
        !textIs(item.body, 1200) || !textIs(item.app, 160) || !Number.isSafeInteger(item.time) ||
        item.time < 0 || item.time > 8_640_000_000_000_000 || typeof item.replyable !== 'boolean') {
      throw httpError(400, 'Invalid notification.');
    }
    seen.add(item.id);
    return { id: item.id, title: item.title, body: item.body, app: item.app, time: item.time, replyable: item.replyable };
  }).sort((a, b) => b.time - a.time);
}

export class PersonalService {
  #server = null;
  #sockets = new Set();
  #operations = Promise.resolve();
  #stopping = false;
  #pairing = null;
  #request = null;
  #denial = null;
  #approving = false;
  #device = null;
  #lastSeen = 0;
  #lastSnapshot = '';
  #notifications = [];
  #access = false;
  #paused = false;
  #locked = false;
  #reply = null;
  #timer = null;
  #error = null;
  #syncing = false;

  constructor({ dataDir, onChange = () => {}, port = 43873, host = '0.0.0.0', address = preferredAddress }) {
    this.dataDir = dataDir;
    this.deviceFile = join(dataDir, 'device.json');
    this.onChange = onChange;
    this.port = port;
    this.host = host;
    this.address = address;
  }

  snapshot() {
    const online = Boolean(this.#lastSeen);
    return structuredClone({
      pairing: this.#pairing && { payload: this.#pairing.payload, expiresAt: this.#pairing.expiresAt },
      request: this.#request && { id: this.#request.id, name: this.#request.name, code: this.#request.code },
      device: this.#device && { name: this.#device.name, online, access: online && this.#access },
      notifications: this.#notifications,
      paused: this.#paused,
      reply: this.#reply && { id: this.#reply.id, notificationId: this.#reply.notificationId, status: this.#reply.status },
      error: this.#error,
    });
  }

  #emit() {
    const snapshot = JSON.stringify(this.snapshot());
    if (snapshot === this.#lastSnapshot) return;
    this.#lastSnapshot = snapshot;
    this.onChange();
  }

  #transition(operation) {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => {});
    return result;
  }

  restore() {
    return this.#transition(() => this.#restore());
  }

  async #restore() {
    if (this.#stopping || this.#device) return;
    const saved = await readFile(this.deviceFile, 'utf8').then(JSON.parse).catch(() => null);
    if (!saved || !hex(saved.ticketHash) || !hex(saved.fingerprint) || !textIs(saved.name, 80)) return;
    this.#paused = saved.paused === true;
    try {
      if (!this.#server) await this.#open();
      if (saved.fingerprint !== this.fingerprint) {
        await rm(this.deviceFile, { force: true });
        await this.#close();
        this.#error = 'The PC pairing certificate changed. Pair your phone again.';
      } else {
        this.#device = saved;
      }
    } catch {
      this.#device = saved;
      this.#error = 'Glove could not open the notification connection. Check the network and restart Glove.';
    }
    this.#emit();
  }

  async #open() {
    const [https, { prepareCertificates }] = await Promise.all([import('node:https'), import('../viewing/certificates.mjs')]);
    const { cert, key } = await prepareCertificates(join(this.dataDir, 'tls'), []);
    const server = https.createServer({
      cert, key, minVersion: 'TLSv1.2', maxHeaderSize: 8192, handshakeTimeout: 8_000,
      headersTimeout: 8_000, requestTimeout: 10_000, keepAliveTimeout: 3_000,
    }, (request, response) => {
      this.#handle(request, response).catch(error => {
        if (response.destroyed) return;
        if (response.headersSent) response.destroy();
        else respond(response, error.status || 500, { error: error.status ? error.message : 'Personal connection failed.' });
      });
    });
    server.maxConnections = 16;
    server.maxHeadersCount = 24;
    server.setTimeout(8_000, socket => socket.destroy());
    server.on('connection', socket => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => { server.removeListener('error', reject); resolve(); });
    });
    this.fingerprint = digest(new X509Certificate(cert).raw);
    this.#server = server;
    this.#timer = setInterval(() => this.#expire(), 500);
    this.#timer.unref();
  }

  startPairing() {
    return this.#transition(() => this.#createPairing());
  }

  async #createPairing() {
    if (this.#stopping) throw new Error('Glove is closing.');
    this.#expire();
    if (this.#device) throw new Error('Forget the current phone before pairing another one.');
    if (this.#pairing) return this.snapshot();
    const address = this.address();
    if (!address) throw new Error('Connect this PC to the same private Wi-Fi network as your Android phone.');
    try { if (!this.#server) await this.#open(); }
    catch { throw new Error('Glove could not open the notification connection on this PC. Check that port 43873 is available.'); }
    if (this.#stopping) throw new Error('Glove is closing.');
    const secret = token();
    const payload = JSON.stringify({ v: 1, url: `https://${address}:${this.#server.address().port}`, fingerprint: this.fingerprint, token: secret });
    this.#pairing = { payload, tokenHash: digest(secret), expiresAt: Date.now() + PAIR_MS };
    this.#request = null;
    this.#error = null;
    this.#emit();
    return this.snapshot();
  }

  stopPairing(requestId) {
    return this.#transition(async () => {
      if (requestId !== undefined && this.#request?.id !== requestId) throw new Error('This pairing request has expired.');
      this.#cancelPairing();
      this.#emit();
      await this.#closeIdle();
      return this.snapshot();
    });
  }

  approvePairing(requestId) {
    return this.#transition(async () => {
      this.#expire();
      if (this.#stopping || !this.#request || this.#request.id !== requestId) throw new Error('This pairing request has expired. Scan the current code in Glove Companion.');
      this.#approving = true;
      try { return await this.#approve(this.#request); } finally { this.#approving = false; }
    });
  }

  async #approve(request) {
    const device = { name: request.name, ticketHash: request.ticketHash, fingerprint: this.fingerprint, paused: false };
    await this.#save(device);
    this.#device = device;
    this.#paused = false;
    this.#pairing = this.#request = null;
    this.#emit();
    return this.snapshot();
  }

  async #save(device) {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.deviceFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(device), { mode: 0o600 });
      await rename(temporary, this.deviceFile);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  setPaused(paused) {
    return this.#transition(async () => {
      if (typeof paused !== 'boolean' || !this.#device) throw new Error('Pair a phone first.');
      if (paused) {
        this.#paused = true;
        this.#clearInbox();
        this.#emit();
      }
      const saved = { ...this.#device, paused };
      await this.#save(saved);
      this.#device = saved;
      this.#paused = paused;
      this.#emit();
      return this.snapshot();
    });
  }

  setLocked(locked) {
    this.#locked = locked;
    if (locked) this.#clearInbox();
    this.#emit();
  }

  forget() {
    return this.#transition(() => this.#forget());
  }

  async #forget() {
    const device = this.#device;
    this.#device = null;
    this.#lastSeen = 0;
    this.#access = false;
    this.#clearInbox();
    this.#emit();
    try { await rm(this.deviceFile, { force: true }); }
    catch (error) {
      this.#device = device;
      this.#emit();
      throw error;
    }
    this.#paused = false;
    this.#cancelPairing();
    if (device) this.#denial = { ticketHash: device.ticketHash, expiresAt: Date.now() + ONLINE_MS };
    this.#reply = this.#error = null;
    this.#emit();
    await this.#closeIdle();
    return this.snapshot();
  }

  sendReply(id, text) {
    this.#expire();
    if (this.#stopping || !this.#device || this.#paused || this.#locked || !this.#lastSeen || !this.#notifications.some(item => item.id === id && item.replyable)) {
      throw new Error('This notification is no longer available for reply.');
    }
    if (!textIs(text, 1000) || !text.trim()) throw new Error('Enter a reply of up to 1,000 characters.');
    if (this.#reply?.status === 'pending') throw new Error('Wait for the current reply to finish.');
    this.#reply = { id: randomUUID(), notificationId: id, status: 'pending', text: text.trim(), expiresAt: Date.now() + REPLY_MS };
    this.#emit();
    return this.snapshot();
  }

  #finishReply(status) {
    this.#reply.status = status;
    delete this.#reply.text;
  }

  #clearInbox() {
    this.#notifications = [];
    if (this.#reply?.status === 'pending') this.#finishReply(this.#reply.text ? 'expired' : 'unknown');
  }

  #cancelPairing() {
    if (this.#request) this.#denial = { ticketHash: this.#request.ticketHash, expiresAt: Date.now() + ONLINE_MS };
    this.#pairing = this.#request = null;
  }

  #expire() {
    const now = Date.now();
    let changed = false;
    let closeIdle = false;
    if (!this.#approving && this.#pairing?.expiresAt <= now) {
      this.#cancelPairing();
      closeIdle = true;
      changed = true;
    }
    if (this.#denial?.expiresAt <= now) {
      this.#denial = null;
      closeIdle = true;
    }
    if (this.#lastSeen && this.#lastSeen + ONLINE_MS <= now) {
      this.#lastSeen = 0;
      this.#access = false;
      this.#clearInbox();
      changed = true;
    }
    if (this.#reply?.status === 'pending' && this.#reply.expiresAt <= now) {
      this.#finishReply(this.#reply.text ? 'expired' : 'unknown');
      changed = true;
    }
    if (changed) this.#emit();
    if (closeIdle) void this.#transition(() => this.#closeIdle());
  }

  async #handle(request, response) {
    if (this.#stopping) throw httpError(503, 'Glove is closing.');
    if (!localIpv4(request.socket.remoteAddress) || request.headers.origin) throw httpError(403, 'Use the Glove companion on your private network.');
    if (request.method !== 'POST') throw httpError(405, 'Use POST.');
    const secret = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1];
    this.#expire();
    switch (request.url) {
      case '/v1/pair/request': {
        const active = this.#pairing;
        if (!matches(active?.tokenHash, secret)) throw httpError(401, 'Pairing code expired.');
        if (this.#request) throw httpError(409, 'A phone is already waiting for approval.');
        const { name } = await readJson(request);
        if (!textIs(name, 80) || !name.trim()) throw httpError(400, 'Invalid phone name.');
        if (active !== this.#pairing || Date.now() >= active.expiresAt) throw httpError(401, 'Pairing code expired.');
        if (this.#request) throw httpError(409, 'A phone is already waiting for approval.');
        const ticket = token();
        const code = String(randomInt(1_000_000)).padStart(6, '0');
        this.#request = { id: randomUUID(), name: name.trim(), code, ticketHash: digest(ticket) };
        this.#emit();
        return respond(response, 200, { ticket, code });
      }
      case '/v1/pair/status':
        if (matches(this.#device?.ticketHash, secret)) return respond(response, 200, { state: 'paired' });
        if (matches(this.#request?.ticketHash, secret)) return respond(response, 200, { state: 'pending' });
        if (matches(this.#denial?.ticketHash, secret)) return respond(response, 200, { state: 'denied' });
        return respond(response, 401, { state: 'denied' });
      case '/v1/pair/revoke':
        await this.#transition(async () => {
          if (matches(this.#device?.ticketHash, secret)) {
            await this.#forget();
          } else if (matches(this.#request?.ticketHash, secret)) {
            this.#cancelPairing();
            this.#emit();
          } else if (!matches(this.#denial?.ticketHash, secret)) {
            throw httpError(401, 'This pairing has expired.');
          }
        });
        return respond(response, 200, { state: 'denied' });
      case '/v1/sync': {
        if (!matches(this.#device?.ticketHash, secret)) throw httpError(401, 'Pair your phone again.');
        if (this.#syncing) throw httpError(409, 'A sync is already in progress.');
        this.#syncing = true;
        try {
          const payload = await readJson(request);
          if (this.#stopping || !matches(this.#device?.ticketHash, secret)) throw httpError(401, 'Pair your phone again.');
          return this.#sync(response, payload);
        } finally { this.#syncing = false; }
      }
      default: throw httpError(404, 'Unknown companion endpoint.');
    }
  }

  #sync(response, payload) {
    const notifications = readNotifications(payload);
    const { result } = payload;
    const reply = this.#reply;
    this.#lastSeen = Date.now();
    this.#access = payload.access;
    const paused = this.#paused || this.#locked;
    this.#notifications = payload.access && !paused ? notifications : [];
    let command = null;
    if (reply?.status === 'pending') {
      if (!reply.text && result?.id === reply.id && ['submitted', 'expired', 'failed'].includes(result.status)) {
        this.#finishReply(result.status);
      } else if (reply.text) {
        if (this.#notifications.some(item => item.id === reply.notificationId && item.replyable)) {
          command = { id: reply.id, notificationId: reply.notificationId, text: reply.text };
          delete reply.text;
        } else {
          this.#finishReply('expired');
        }
      }
    }
    this.#emit();
    return respond(response, 200, { command, paused });
  }

  async #close() {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    clearInterval(this.#timer);
    await new Promise(resolve => {
      server.close(resolve);
      for (const socket of this.#sockets) socket.destroy();
    });
  }

  async #closeIdle() {
    if (!this.#device && !this.#pairing && !this.#denial) await this.#close();
  }

  stop() {
    this.#stopping = true;
    return this.#transition(() => this.#close());
  }
}
