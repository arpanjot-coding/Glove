// SPDX-License-Identifier: MIT
// Original Glove implementation. Uses only the Node.js standard library.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open, mkdir, realpath, stat, rename, unlink, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { phonePage } from './phone-page.mjs';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ITEMS = 500;
const MAX_UPLOADS = 3;
const MAX_CONNECTIONS = 32;
const MAX_CONNECTIONS_PER_ADDRESS = 8;
const MAX_RATE_ADDRESSES = 128;
const UPLOAD_IDLE_MS = 45_000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function filename(input) {
  let value = String(input || '').normalize('NFKC').split(/[\\/]/).at(-1);
  value = value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/[. ]+$/g, '').replace(/^[. ]+/g, '');
  value = value.slice(0, 160).replace(/[\ud800-\udbff]$/, '');
  if (!value) value = 'phone-file';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  return value;
}

function disposition(name) {
  const plain = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

function sameToken(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicItem(item) {
  return { id: item.id, name: item.name, size: item.size, direction: item.direction, createdAt: item.createdAt };
}

function sameFile(item, info) {
  return info.dev === item.dev && info.ino === item.ino && info.size === item.size &&
    info.mtimeMs === item.mtimeMs && info.ctimeMs === item.ctimeMs;
}

function connectionUrls(host, port, token) {
  let addresses;
  if (host === '0.0.0.0' || host === '::') {
    addresses = Object.values(os.networkInterfaces()).flat().filter(Boolean)
      .filter(address => address.family === 'IPv4' && !address.internal).map(address => address.address);
    addresses.push('127.0.0.1');
  } else {
    addresses = [host === 'localhost' ? '127.0.0.1' : host];
  }
  return [...new Set(addresses)].map(address => `http://${address.includes(':') ? `[${address}]` : address}:${port}/s/${token}/`);
}

/** A temporary, token-protected HTTP handoff on a trusted local network. */
export class ShareService {
  #receiveDir;
  #onChange;
  #allowUploads;
  #server = null;
  #token = null;
  #port = null;
  #urls = [];
  #running = false;
  #items = new Map();
  #sockets = new Set();
  #connections = new Map();
  #rates = new Map();
  #tasks = new Set();
  #uploadSlots = 0;
  #pendingAdds = 0;
  #startPromise = null;
  #stopPromise = null;
  #changingReceiveDir = false;

  constructor({ receiveDir, onChange, allowUploads = true } = {}) {
    if (typeof receiveDir !== 'string' || !receiveDir.trim()) throw new TypeError('receiveDir is required.');
    if (onChange !== undefined && typeof onChange !== 'function') throw new TypeError('onChange must be a function.');
    this.#receiveDir = path.resolve(receiveDir);
    this.#onChange = onChange;
    this.#allowUploads = allowUploads;
  }

  snapshot() {
    return { running: this.#running, port: this.#port, urls: [...this.#urls], items: [...this.#items.values()].map(publicItem) };
  }

  #emit() {
    // A desktop observer must not turn a completed file transfer into a failure.
    try { this.#onChange?.(this.snapshot()); } catch { /* Observer owns its errors. */ }
  }

  /** Changes the destination only between sessions; existing shared entries keep their original paths. */
  async setReceiveDir(directory) {
    if (this.#running || this.#startPromise || this.#stopPromise || this.#changingReceiveDir) {
      throw new Error('Stop file sharing before changing the receive folder.');
    }
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('A receive folder is required.');
    this.#changingReceiveDir = true;
    try {
      const canonical = await realpath(path.resolve(directory));
      if (!(await stat(canonical)).isDirectory()) throw new Error('The receive folder must be a directory.');
      await access(canonical, fsConstants.W_OK);
      if (this.#running || this.#startPromise || this.#stopPromise) {
        throw new Error('Stop file sharing before changing the receive folder.');
      }
      this.#receiveDir = canonical;
      return this.snapshot();
    } finally { this.#changingReceiveDir = false; }
  }

  async start({ host = '0.0.0.0', port = 0 } = {}) {
    if (this.#stopPromise) await this.#stopPromise;
    if (this.#changingReceiveDir) throw new Error('Wait for the receive folder change to finish.');
    if (this.#running) return { port: this.#port, token: this.#token, urls: [...this.#urls] };
    if (this.#startPromise) return this.#startPromise;
    if (typeof host !== 'string' || !host || host.length > 253) throw new TypeError('Invalid listen host.');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid listen port.');
    this.#startPromise = this.#listen(host, port);
    try { return await this.#startPromise; } finally { this.#startPromise = null; }
  }

  async #listen(host, requestedPort) {
    await mkdir(this.#receiveDir, { recursive: true });
    this.#receiveDir = await realpath(this.#receiveDir);
    const token = randomBytes(32).toString('base64url');
    const server = http.createServer({ maxHeaderSize: 16_384 }, (req, res) => {
      const task = this.#handle(req, res, token).catch(error => {
        if (res.destroyed) return;
        if (res.headersSent) { res.destroy(); return; }
        const status = error instanceof HttpError ? error.status : 500;
        this.#send(res, status, { error: status === 500 ? 'The transfer could not be completed.' : error.message }, true);
      });
      this.#tasks.add(task);
      void task.then(() => this.#tasks.delete(task), () => this.#tasks.delete(task));
    });
    server.maxConnections = MAX_CONNECTIONS;
    server.maxRequestsPerSocket = 100;
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;
    server.requestTimeout = 30 * 60_000;
    server.on('connection', socket => {
      const address = socket.remoteAddress || 'unknown';
      const count = (this.#connections.get(address) || 0) + 1;
      if (count > MAX_CONNECTIONS_PER_ADDRESS) { socket.destroy(); return; }
      this.#connections.set(address, count);
      this.#sockets.add(socket);
      socket.on('close', () => {
        this.#sockets.delete(socket);
        const remaining = (this.#connections.get(address) || 1) - 1;
        if (remaining) this.#connections.set(address, remaining); else this.#connections.delete(address);
      });
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(requestedPort, host);
      });
    } catch (error) {
      server.close();
      throw error;
    }
    // Handle later listen/socket errors without an unhandled EventEmitter error.
    server.on('error', () => { void this.stop(); });
    this.#server = server;
    this.#token = token;
    this.#port = server.address().port;
    this.#urls = connectionUrls(host, this.#port, token);
    this.#running = true;
    this.#emit();
    return { port: this.#port, token, urls: [...this.#urls] };
  }

  async stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#close();
    try { await this.#stopPromise; } finally { this.#stopPromise = null; }
  }

  async #close() {
    if (this.#startPromise) { try { await this.#startPromise; } catch { /* Failed start has no session. */ } }
    const server = this.#server;
    this.#running = false;
    this.#server = null;
    this.#token = null;
    this.#port = null;
    this.#urls = [];
    if (server) {
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of this.#sockets) socket.destroy();
      await closed;
      await Promise.allSettled([...this.#tasks]);
    }
    this.#rates.clear();
    this.#emit();
  }

  async addFiles(paths) {
    if (!Array.isArray(paths) || paths.some(file => typeof file !== 'string')) throw new TypeError('Expected an array of file paths.');
    if (this.#items.size + this.#uploadSlots + this.#pendingAdds + paths.length > MAX_ITEMS) throw new Error(`Share up to ${MAX_ITEMS} files at a time.`);
    this.#pendingAdds += paths.length;
    const additions = [];
    try {
      // Validate the whole selection before changing the public list.
      for (const selected of paths) {
        const canonical = await realpath(path.resolve(selected));
        const info = await stat(canonical);
        if (!info.isFile()) throw new Error('Only regular files can be shared.');
        if (!Number.isSafeInteger(info.size)) throw new Error('This file is too large to share.');
        const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
        additions.push({ id: randomBytes(16).toString('hex'), name: filename(path.basename(canonical)), size: info.size,
          direction: 'to-phone', createdAt: new Date().toISOString(), path: canonical, key,
          dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
      }
      const existing = new Map([...this.#items.values()].map(item => [item.key, item]));
      for (const item of additions) {
        const previous = existing.get(item.key);
        if (previous && sameFile(previous, item)) continue;
        if (previous) this.#items.delete(previous.id);
        existing.set(item.key, item);
        this.#items.set(item.id, item);
      }
    } finally { this.#pendingAdds -= paths.length; }
    this.#emit();
    return this.snapshot();
  }

  /** Removes a shared entry; received files remain in the user's receive folder. */
  remove(id) {
    if (this.#items.delete(id)) this.#emit();
    return this.snapshot();
  }

  #allowRate(address) {
    const now = Date.now();
    let bucket = this.#rates.get(address);
    if (!bucket) {
      for (const [key, value] of this.#rates) if (now - value.at > 120_000) this.#rates.delete(key);
      if (this.#rates.size >= MAX_RATE_ADDRESSES) return false;
      bucket = { tokens: 80, at: now };
      this.#rates.set(address, bucket);
    }
    bucket.tokens = Math.min(80, bucket.tokens + (now - bucket.at) / 500);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  #send(res, status, data, close = false) {
    const body = Buffer.from(JSON.stringify(data));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
      ...(close ? { Connection: 'close' } : {}) });
    res.end(body);
  }

  async #handle(req, res, session) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!this.#allowRate(req.socket.remoteAddress || 'unknown')) {
      res.setHeader('Retry-After', '3');
      throw new HttpError(429, 'Too many requests. Please wait a moment.');
    }
    if (!this.#running || !sameToken(this.#token, session)) throw new HttpError(404, 'This sharing link is not active.');
    if (!req.url || req.url.length > 4096 || !req.url.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'Invalid request.');
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    if (parts[1] !== 's' || !sameToken(parts[2], session)) throw new HttpError(404, 'This sharing link is not active.');
    // No permissive CORS. Reject browser writes explicitly originating elsewhere.
    if (req.headers.origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).origin === new URL(`http://${req.headers.host}`).origin; } catch { /* Invalid origin. */ }
      if (!sameOrigin) throw new HttpError(403, 'Use this sharing page to transfer files.');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Open the sharing link directly.');
    const route = parts.slice(3).join('/');
    if (!(req.method === 'POST' && route === 'api/upload') &&
        (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0)) {
      throw new HttpError(400, 'Only file uploads accept a request body.');
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && parts.length === 3) {
      res.writeHead(308, { Location: `/s/${session}/`, 'Content-Length': '0' });
      res.end();
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && route === '') {
      const nonce = randomBytes(18).toString('base64');
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
      const body = Buffer.from(phonePage(nonce, this.#allowUploads));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } else if (req.method === 'GET' && route === 'api/items') {
      this.#send(res, 200, this.snapshot());
    } else if ((req.method === 'GET' || req.method === 'HEAD') && /^files\/[a-f0-9]{32}$/.test(route)) {
      await this.#download(req, res, route.slice(6));
    } else if (req.method === 'POST' && route === 'api/upload') {
      if (!this.#allowUploads) throw new HttpError(405, 'This session only shares the Glove Android installer.');
      await this.#upload(req, res, url, session);
    } else {
      throw new HttpError(req.method === 'OPTIONS' ? 405 : 404, 'This resource is not available.');
    }
  }

  async #download(req, res, id) {
    const item = this.#items.get(id);
    if (!item) throw new HttpError(404, 'This file is no longer shared.');
    let handle;
    try {
      handle = await open(item.path, 'r');
      const info = await handle.stat();
      if (!info.isFile() || !sameFile(item, info)) {
        throw new HttpError(409, 'This file changed. Add it again from the computer.');
      }
      if (!this.#running || this.#items.get(id) !== item) throw new HttpError(404, 'This file is no longer shared.');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size,
        'Content-Disposition': disposition(item.name) });
      if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
      await pipeline(handle.createReadStream({ end: info.size - 1 }), res);
    } catch (error) {
      if (error instanceof HttpError || res.headersSent) throw error;
      throw new HttpError(404, 'This file is no longer available.');
    } finally { await handle?.close().catch(() => {}); }
  }

  async #reserveName(desired) {
    const extension = path.extname(desired);
    const stem = desired.slice(0, desired.length - extension.length) || 'phone-file';
    for (let index = 0; index < 100; index += 1) {
      const name = index === 0 ? desired : `${stem} (${index})${extension}`;
      const target = path.join(this.#receiveDir, name);
      try {
        const reserved = await open(target, 'wx', 0o600);
        await reserved.close();
        return { name, path: target };
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const name = `${stem}-${randomBytes(8).toString('hex')}${extension}`;
    const target = path.join(this.#receiveDir, name);
    const reserved = await open(target, 'wx', 0o600);
    await reserved.close();
    return { name, path: target };
  }

  async #upload(req, res, url, session) {
    const declared = req.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_UPLOAD_BYTES)) throw new HttpError(413, 'Files must be 2 GiB or smaller.');
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Send the original file bytes.');
    if (req.headers['content-type'] && req.headers['content-type'].split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw new HttpError(415, 'Send the original file bytes.');
    if (this.#uploadSlots >= MAX_UPLOADS) throw new HttpError(429, 'Three files are transferring. Please wait.');
    if (this.#items.size + this.#uploadSlots + this.#pendingAdds >= MAX_ITEMS) throw new HttpError(409, `Share up to ${MAX_ITEMS} files at a time.`);
    this.#uploadSlots += 1;
    const temporary = path.join(this.#receiveDir, `.glove-${randomBytes(18).toString('hex')}.part`);
    let handle;
    let reserved;
    let committed = false;
    let total = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(total > MAX_UPLOAD_BYTES ? new HttpError(413, 'Files must be 2 GiB or smaller.') : null, chunk);
    } });
    req.setTimeout(UPLOAD_IDLE_MS, () => req.destroy(new Error('Upload timed out.')));
    try {
      handle = await open(temporary, 'wx', 0o600);
      await pipeline(req, meter, handle.createWriteStream());
      // Ensure Windows has released the handle before replacing the reserved name.
      await handle.close().catch(() => {});
      if (declared !== undefined && Number(declared) !== total) throw new HttpError(400, 'The file was not received completely.');
      if (!this.#running || !sameToken(this.#token, session)) throw new HttpError(404, 'Sharing stopped before the file was received.');
      reserved = await this.#reserveName(filename(url.searchParams.get('name')));
      if (!this.#running || !sameToken(this.#token, session)) throw new HttpError(404, 'Sharing stopped before the file was received.');
      await rename(temporary, reserved.path);
      const info = await stat(reserved.path);
      const item = { id: randomBytes(16).toString('hex'), name: reserved.name, size: total, direction: 'from-phone',
        createdAt: new Date().toISOString(), path: reserved.path, key: process.platform === 'win32' ? reserved.path.toLowerCase() : reserved.path,
        dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
      // No await between the final session check and publishing the entry.
      if (!this.#running || !sameToken(this.#token, session)) throw new HttpError(404, 'Sharing stopped before the file was received.');
      this.#items.set(item.id, item);
      committed = true;
      this.#emit();
      this.#send(res, 201, { item: publicItem(item), snapshot: this.snapshot() });
    } finally {
      req.setTimeout(0);
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      if (reserved && !committed) await unlink(reserved.path).catch(() => {});
      this.#uploadSlots -= 1;
    }
  }
}
