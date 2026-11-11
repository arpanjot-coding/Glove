// Original Glove code. MIT licensed. No AirPlay receiver code is included.
import http from 'node:http';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {setupPage, screenPage, screenScript} from './pages.mjs';

const token = () => randomBytes(32).toString('hex');
const MAX_BODY = 256 * 1024;
const MAX_RETIRED_SESSIONS = 128;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const sdpIs = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_BODY - 200 && value.startsWith('v=0') && !value.includes('\0');
const sessionIs = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
const serverSockets = new WeakMap();
function trackSockets(server) {
  const sockets = new Set();
  serverSockets.set(server,sockets);
  server.on('connection',socket => {
    sockets.add(socket);
    socket.once('close',()=>sockets.delete(socket));
  });
}
const listen = (server, port, host) => new Promise((resolve,reject) => {
  server.once('error',reject);
  server.listen(port,host,() => {server.removeListener('error',reject);resolve(server.address().port);});
});
const close = server => new Promise(resolve => {
  if (!server) return resolve();
  server.close(resolve);
  // HTTP's closeAllConnections does not include sockets still negotiating TLS.
  for (const socket of serverSockets.get(server)) socket.destroy();
});

function ipsFor(host) {
  const ips = Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal).map(item => item.address);
  if (host && !['0.0.0.0','::'].includes(host) && /^\d+\.\d+\.\d+\.\d+$/.test(host)) ips.push(host);
  return [...new Set([...ips,'127.0.0.1'])];
}

function send(response, code, body, type='application/json; charset=utf-8', extra={}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  response.writeHead(code, {
    'Content-Type':type,
    'Content-Length':Buffer.byteLength(data),
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':CSP,
    ...extra,
  });
  response.end(data);
}

async function json(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw Object.assign(new Error('Use application/json.'),{status:415});
  const length = Number(request.headers['content-length']);
  if (length > MAX_BODY) throw Object.assign(new Error('Request is too large.'),{status:413});
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request is too large.'),{status:413});
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {throw Object.assign(new Error('Invalid JSON.'),{status:400});}
}

export class ViewService {
  constructor({dataDir,onChange=()=>{},leaseMs=20_000}) {
    if (!dataDir) throw new Error('A private dataDir is required.');
    if (!Number.isFinite(leaseMs) || leaseMs < 50) throw new Error('leaseMs must be at least 50 milliseconds.');
    this.dataDir = dataDir;
    this.onChange = onChange;
    this.leaseMs = leaseMs;
    this.sessionLastSeen = 0;
    this.leaseTimer = null;
    this.retiredSessions = new Set();
    this.state = {running:false,port:null,setupPort:null,urls:[],setupUrls:[],fingerprint:null,rootName:null,offer:null,sessionId:null,connected:false,status:'stopped'};
    this.answerValue = null;
  }
  snapshot() {return structuredClone(this.state);}
  changed() {
    try {this.onChange(this.snapshot());} catch { /* A desktop observer does not own the session. */ }
  }
  async start({host='0.0.0.0',port=0,setupPort=0}={}) {
    if (this.stopPromise) await this.stopPromise;
    if (this.state.running) return this.snapshot();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startServers({host,port,setupPort});
    try {return await this.startPromise;} finally {this.startPromise = null;}
  }
  async startServers({host,port,setupPort}) {
    const [https, {prepareCertificates, configurationProfile}] = await Promise.all([
      import('node:https'),
      import('./certificates.mjs'),
    ]);
    const ips = ipsFor(host);
    const certs = await prepareCertificates(this.dataDir,ips);
    this.screenToken = token();
    this.setupToken = token();
    this.profile = configurationProfile(certs);
    this.secureHosts = new Set(ips);
    const secure = https.createServer({cert:certs.cert,key:certs.key,minVersion:'TLSv1.2',handshakeTimeout:10000,maxHeaderSize:8192},(req,res) => this.handleSecure(req,res).catch(error => this.failure(res,error)));
    const setup = http.createServer({maxHeaderSize:8192},(req,res) => this.handleSetup(req,res).catch(error => this.failure(res,error)));
    for (const server of [secure,setup]) {
      trackSockets(server);
      server.requestTimeout = 20000;
      server.headersTimeout = 15000;
      server.maxHeadersCount = 40;
      server.maxConnections = 32;
      server.maxRequestsPerSocket = 64;
      server.keepAliveTimeout = 5000;
      server.setTimeout(15000,socket=>socket.destroy());
    }
    this.secureServer = secure;
    this.setupServer = setup;
    try {
      const actualPort = await listen(secure,port,host);
      const actualSetupPort = await listen(setup,setupPort,host);
      const publicIps = host === '127.0.0.1' ? ['127.0.0.1'] : ips.filter(ip => ip !== '127.0.0.1');
      if (!publicIps.length) publicIps.push('127.0.0.1');
      this.state = {...this.state,running:true,port:actualPort,setupPort:actualSetupPort,urls:publicIps.map(ip => `https://${ip}:${actualPort}/s/${this.screenToken}/`),setupUrls:publicIps.map(ip => `http://${ip}:${actualSetupPort}/setup/${this.setupToken}/`),fingerprint:certs.fingerprint,rootName:certs.rootName,offer:null,sessionId:null,connected:false,status:'waiting'};
      this.changed();
      return this.snapshot();
    } catch (error) {await Promise.all([close(secure),close(setup)]);this.secureServer=null;this.setupServer=null;throw error;}
  }
  failure(response,error) {if (!response.headersSent && !response.destroyed) send(response,error.status || 500,{error:error.status ? error.message : 'Local screen service failed.'});else response.destroy();}
  validHost(request,port) {
    try {const url = new URL(`http://${request.headers.host}`);return this.secureHosts.has(url.hostname) && url.port === String(port);}
    catch {return false;}
  }
  async handleSetup(request,response) {
    if (this.stopPromise || !this.state.running) return send(response,410,{error:'This screen session ended.'});
    if (!this.validHost(request,this.state.setupPort)) return send(response,403,{error:'Unrecognized local address.'});
    const url = new URL(request.url,`http://${request.headers.host}`);
    const base = `/setup/${this.setupToken}/`;
    if (request.method !== 'GET') return send(response,405,{error:'Method not allowed.'},'application/json; charset=utf-8',{Allow:'GET'});
    if (url.pathname === base) {
      const host = new URL(`http://${request.headers.host}`).hostname;
      return send(response,200,setupPage({secureUrl:`https://${host}:${this.state.port}/s/${this.screenToken}/`,profilePath:`${base}glove.mobileconfig`,fingerprint:this.state.fingerprint,rootName:this.state.rootName}),'text/html; charset=utf-8');
    }
    if (url.pathname === `${base}glove.mobileconfig`) return send(response,200,this.profile,'application/x-apple-aspen-config',{'Content-Disposition':'attachment; filename="Glove-local-screen.mobileconfig"'});
    return send(response,404,{error:'Not found.'});
  }
  async handleSecure(request,response) {
    if (this.stopPromise || !this.state.running) return send(response,410,{error:'This screen session ended.'});
    if (!this.validHost(request,this.state.port)) return send(response,403,{error:'Unrecognized local address.'});
    const origin = `https://${request.headers.host}`;
    const url = new URL(request.url,origin);
    const screenToken = this.screenToken;
    const base = `/s/${screenToken}/`;
    if (!url.pathname.startsWith(base)) return send(response,404,{error:'Not found.'});
    const route = url.pathname.slice(base.length);
    if (request.method === 'GET' && route === '') return send(response,200,screenPage({scriptPath:`${base}screen.js`}), 'text/html; charset=utf-8');
    if (request.method === 'GET' && route === 'screen.js') return send(response,200,screenScript,'application/javascript; charset=utf-8');
    // Tokenized GET responses cannot be read across origins. Reject explicit
    // cross-origin requests too, rather than issuing permissive CORS headers.
    if (request.headers.origin && request.headers.origin !== origin) return send(response,403,{error:'Origin does not match this screen page.'});
    if (request.method === 'GET' && route === 'answer') {
      this.expireSession();
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || sessionId !== this.state.sessionId) return send(response,410,{error:'This screen session ended. Tap Start to reconnect.'});
      this.refreshLease();
      return send(response,200,{answer:this.answerValue,connected:this.state.connected});
    }
    if (request.method !== 'POST' || !['offer','stop'].includes(route)) return send(response,404,{error:'Not found.'});
    if (request.headers.origin !== origin) return send(response,403,{error:'A same-origin screen page is required.'});
    const body = await json(request);
    if (this.stopPromise || !this.state.running || screenToken !== this.screenToken) return send(response,410,{error:'This screen session ended.'});
    if (!body || typeof body !== 'object' || !sessionIs(body.sessionId)) return send(response,400,{error:'Invalid session.'});
    this.expireSession();
    if (route === 'offer') {
      if (!sdpIs(body.sdp)) return send(response,400,{error:'Invalid screen offer.'});
      if (this.retiredSessions.has(body.sessionId)) return send(response,410,{error:'This screen session already ended. Tap Start to reconnect.'});
      if (this.state.sessionId && this.state.sessionId !== body.sessionId) return send(response,409,{error:'Another screen session is active. Stop it in Glove first.'});
      if (this.state.sessionId === body.sessionId) return send(response,409,{error:'This screen session already has an offer.'});
      this.answerValue = null;
      this.state = {...this.state,offer:{type:'offer',sdp:body.sdp},sessionId:body.sessionId,connected:false,status:'offer'};
      this.refreshLease();
      this.changed();
      return send(response,200,{accepted:true,sessionId:body.sessionId});
    }
    // A stop can arrive while the phone's offer is still in transit. Retire
    // that ID so the delayed offer cannot take over the active slot.
    if (body.sessionId !== this.state.sessionId) {
      this.retireSession(body.sessionId);
      return send(response,410,{error:'This screen session already ended.'});
    }
    this.clearSession();
    return send(response,200,{stopped:true});
  }
  async answer({sessionId,sdp} = {}) {
    this.expireSession();
    if (this.stopPromise || !this.state.running || !sessionIs(sessionId) || sessionId !== this.state.sessionId) throw new Error('The screen session is no longer active.');
    const text = typeof sdp === 'string' ? sdp : sdp?.sdp;
    if (!sdpIs(text) || (typeof sdp === 'object' && sdp?.type !== 'answer')) throw new Error('Invalid WebRTC answer.');
    if (this.answerValue) {
      if (this.answerValue.sdp === text) return this.snapshot();
      throw new Error('This screen session already has an answer.');
    }
    this.answerValue = {type:'answer',sdp:text};
    this.state.status = 'connecting';
    this.changed();
    return this.snapshot();
  }
  setConnected({sessionId,connected} = {}) {
    this.expireSession();
    if (this.stopPromise || !sessionIs(sessionId) || sessionId !== this.state.sessionId || (connected === true && !this.answerValue)) return this.snapshot();
    this.state.connected = connected === true;
    this.state.status = this.state.connected ? 'streaming' : (this.answerValue ? 'connecting' : 'offer');
    this.changed();
    return this.snapshot();
  }
  clearSession() {
    if (this.state.sessionId) this.retireSession(this.state.sessionId);
    clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.sessionLastSeen = 0;
    this.answerValue = null;
    this.state = {...this.state,offer:null,sessionId:null,connected:false,status:this.state.running?'waiting':'stopped'};
    this.changed();
    return this.snapshot();
  }
  retireSession(id) {
    this.retiredSessions.add(id);
    if (this.retiredSessions.size > MAX_RETIRED_SESSIONS) {
      this.retiredSessions.delete(this.retiredSessions.values().next().value);
    }
  }
  refreshLease() {
    clearTimeout(this.leaseTimer);
    this.sessionLastSeen = performance.now();
    this.leaseTimer = setTimeout(()=>this.expireSession(),this.leaseMs);
    this.leaseTimer.unref?.();
  }
  expireSession() {
    if (!this.state.sessionId) return false;
    const remaining = this.sessionLastSeen + this.leaseMs - performance.now();
    if (remaining <= 0) {this.clearSession();return true;}
    // Timers can fire slightly early. Keep a deadline rather than leaving a
    // session live forever when that happens.
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(()=>this.expireSession(),remaining);
    this.leaseTimer.unref?.();
    return false;
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = Promise.resolve().then(() => this.stopServers());
    try {return await this.stopPromise;} finally {this.stopPromise = null;}
  }
  async stopServers() {
    if (this.startPromise) await this.startPromise.catch(()=>{});
    clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.sessionLastSeen = 0;
    this.state = {...this.state,running:false,port:null,setupPort:null,urls:[],setupUrls:[],offer:null,sessionId:null,connected:false,status:'stopped'};
    this.screenToken = null;
    this.setupToken = null;
    this.profile = null;
    this.answerValue = null;
    this.retiredSessions.clear();
    await Promise.all([close(this.secureServer),close(this.setupServer)]);
    this.secureServer = null;
    this.setupServer = null;
    this.changed();
    return this.snapshot();
  }
}
