// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PhoneDesktop24Regular, Desktop24Regular, Folder24Regular, Settings24Regular, ArrowRight24Regular, Wifi124Regular, Checkmark24Regular, Copy24Regular, Add24Regular, Dismiss24Regular, Phone24Regular, ArrowSync24Regular, ArrowDownload24Regular } from '@fluentui/react-icons';
import type { AppState } from './contracts';
import './theme.css';

type Place = 'devices' | 'screen' | 'files' | 'settings';
type IconName = 'devices' | 'screen' | 'files' | 'settings' | 'arrow' | 'wifi' | 'check' | 'copy' | 'plus' | 'folder' | 'close' | 'phone' | 'refresh' | 'download';
const iconSet = {
  devices: PhoneDesktop24Regular, screen: Desktop24Regular, files: Folder24Regular,
  settings: Settings24Regular, arrow: ArrowRight24Regular, wifi: Wifi124Regular,
  check: Checkmark24Regular, copy: Copy24Regular, plus: Add24Regular,
  folder: Folder24Regular, close: Dismiss24Regular, phone: Phone24Regular,
  refresh: ArrowSync24Regular, download: ArrowDownload24Regular
};
function Icon({ name, size = 20 }: { name: IconName; size?: number }) { const Glyph = iconSet[name]; return <Glyph width={size} height={size} style={{ fontSize: size }} aria-hidden="true"/>; }
function phoneUrls(urls: string[]) { return urls.filter(value => { try { const host = new URL(value).hostname; return host !== 'localhost' && host !== '[::1]' && !host.startsWith('127.'); } catch { return false; } }); }
const empty: AppState = { version: '0.1.0', settings: { toolsFolder: '', receiveFolder: '' }, toolsReady: false, android: { devices: [], mirroring: false, error: '', qr: { active: false, value: '', expiresAt: 0, status: 'idle' } }, sharing: { running: false, port: 0, urls: [], items: [] }, viewing: { running: false, port: 0, setupPort: 0, urls: [], setupUrls: [], fingerprint: '', connected: false } };
function Qr({ value, label = 'Scan this connection QR code with your phone' }: { value: string; label?: string }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc('');
    setFailed(false);
    if (value) {
      import('qrcode')
        .then(({ default: qr }) => qr.toDataURL(value, { width: 232, margin: 3, color: { dark: '#0f172a', light: '#ffffff' }, errorCorrectionLevel: 'M' }))
        .then(image => { if (!cancelled) setSrc(image); })
        .catch(() => { if (!cancelled) setFailed(true); });
    }
    return () => { cancelled = true; };
  }, [value]);
  return src ? <img className="qr" src={src} alt={label}/> : <div className="qr placeholder" role="status">{failed ? 'Could not generate QR code. Restart this session.' : 'Preparing QR code…'}</div>;
}
function App() {
  const [state, setState] = useState<AppState>(empty);
  const [place, setPlace] = useState<Place>('devices');
  const [phone, setPhone] = useState<'android' | 'iphone'>('android');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [pairAddress, setPairAddress] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [address, setAddress] = useState('');
  const [androidStep, setAndroidStep] = useState<'prepare' | 'scan' | 'devices'>('prepare');
  const [phoneBrand, setPhoneBrand] = useState<'samsung' | 'pixel' | 'other'>('samsung');
  const [now, setNow] = useState(Date.now());
  const [viewStep, setViewStep] = useState<'setup' | 'screen'>('setup');
  const [shareUrl, setShareUrl] = useState('');
  const [screenUrl, setScreenUrl] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [mcpDevice, setMcpDevice] = useState('');
  const [mcpFormat, setMcpFormat] = useState<'codex' | 'json'>('codex');
  const video = useRef<HTMLVideoElement>(null);
  const markedSession = useRef('');
  const desktop = !!window.glove;
  const androidQr = state.android.qr || { active: false, value: '', expiresAt: 0, status: 'idle' };
  useEffect(() => { if (!androidQr.active) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [androidQr.active, androidQr.expiresAt]);
  useEffect(() => { if (androidQr.status === 'connected') setAndroidStep('devices'); }, [androidQr.status]);
  const run = async (action: string, data?: unknown, success?: string) => {
    if (!window.glove) { setNotice({ text: 'Open the Windows app to use phone connections and native file dialogs. This browser view is a UI preview.', error: true }); return; }
    setBusy(action); setNotice(null);
    try {
      const value = await window.glove.call(action, data);
      if (success || typeof value === 'string') setNotice({ text: success || value, error: false });
      return value;
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : String(error), error: true }); }
    finally { setBusy(''); }
  };
  useEffect(() => {
    if (!window.glove) return;
    let receivedUpdate = false;
    const unsubscribe = window.glove.subscribe(update => {
      receivedUpdate = true;
      setState(update);
    });
    window.glove.call('state').then(initial => {
      if (!receivedUpdate) setState(initial);
    }).catch(error => setNotice({ text: error.message, error: true }));
    return unsubscribe;
  }, []);
  useEffect(() => { const list = phoneUrls(state.sharing.urls); if (!list.includes(shareUrl)) setShareUrl(list[0] || ''); }, [state.sharing.urls.join('|')]);
  useEffect(() => { const list = phoneUrls(viewStep === 'setup' ? state.viewing.setupUrls : state.viewing.urls); if (!list.includes(screenUrl)) setScreenUrl(list[0] || ''); }, [state.viewing.urls.join('|'), state.viewing.setupUrls.join('|'), viewStep]);
  useEffect(() => {
    const { offer, sessionId, running } = state.viewing;
    if (!running || !offer || !sessionId || !window.glove) { setStream(null); return; }
    let cancelled = false;
    const peer = new RTCPeerConnection({ iceServers: [] });
    markedSession.current = '';
    peer.ontrack = event => { if (!cancelled) setStream(event.streams[0] || new MediaStream([event.track])); };
    peer.onconnectionstatechange = () => {
      if (!cancelled && ['failed', 'disconnected'].includes(peer.connectionState)) {
        markedSession.current = '';
        window.glove?.call('viewingConnected', { sessionId, connected: false }).catch(() => {});
        setNotice({ text: 'The iPhone screen connection was interrupted. Stop sharing on the phone and start again.', error: true });
      }
    };
    (async () => {
      await peer.setRemoteDescription(offer);
      await peer.setLocalDescription(await peer.createAnswer());
      await new Promise<void>(resolve => {
        if (peer.iceGatheringState === 'complete') return resolve();
        const timer = setTimeout(resolve, 6000);
        peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
      });
      if (!cancelled) await window.glove!.call('answerViewing', { sessionId, sdp: peer.localDescription?.toJSON() });
    })().catch(error => { if (!cancelled) setNotice({ text: `Screen connection failed: ${error.message}`, error: true }); });
    return () => { cancelled = true; peer.close(); setStream(null); };
  }, [state.viewing.running, state.viewing.sessionId, state.viewing.offer?.sdp]);
  useEffect(() => {
    const element = video.current;
    if (!element || !stream) return;
    element.srcObject = stream;
    element.play().catch(() => {});
    let cancelled = false;
    const confirm = () => {
      const sessionId = state.viewing.sessionId;
      if (!cancelled && sessionId && markedSession.current !== sessionId && element.videoWidth > 0 && element.readyState >= 2) {
        markedSession.current = sessionId;
        window.glove?.call('viewingConnected', { sessionId, connected: true }).catch(() => {});
      }
    };
    element.addEventListener('loadeddata', confirm);
    let frame = 0;
    if ('requestVideoFrameCallback' in element) {
      const next = () => { if (cancelled) return; confirm(); frame = element.requestVideoFrameCallback(next); };
      frame = element.requestVideoFrameCallback(next);
    }
    return () => { cancelled = true; if (frame) element.cancelVideoFrameCallback(frame); element.removeEventListener('loadeddata', confirm); element.srcObject = null; };
  }, [stream, place, phone, state.viewing.sessionId]);
  const goScreen = (kind: 'android' | 'iphone') => { setPhone(kind); setPlace('screen'); setNotice(null); };
  const readyDevices = state.android.devices.filter(device => device.status === 'device');
  const disabled = !!busy;
  const copy = (text: string) => run('copyText', { text }, 'Link copied.');
  const qrSeconds = Math.max(0, Math.ceil(((androidQr.expiresAt || 0) - now) / 1000));
  const liveAndroidQr = androidQr.active && !!androidQr.value && qrSeconds > 0;
  const shareUrls = phoneUrls(state.sharing.urls);
  const screenUrls = phoneUrls(viewStep === 'setup' ? state.viewing.setupUrls : state.viewing.urls);
  const noNetwork = <div className="no-network" role="status"><strong>No local network address found</strong>Connect this PC to Wi-Fi or Ethernet, then stop and restart this session. A phone cannot open this PC’s loopback address.</div>;
  const qrProgress: Record<string, string> = { preparing: 'Starting the pairing service…', waiting: 'Ready to scan', pairing: 'Pairing with your phone…', connecting: 'Connecting to your phone…', connected: 'Phone connected', expired: 'QR code expired', error: 'Pairing could not finish', cancelled: 'Pairing stopped', idle: 'Ready when you are' };
  const linkBox = (url: string, urls: string[]) => <div className="link-box">
    {urls.length > 1 && <label className="network-label">Network address<select aria-label="Choose network address" value={url} onChange={e => place === 'files' ? setShareUrl(e.target.value) : setScreenUrl(e.target.value)}>{urls.map(value => <option value={value} key={value}>{new URL(value).hostname}{new URL(value).hostname === '127.0.0.1' ? ' · This PC only' : ''}</option>)}</select></label>}
    <div className="url-line"><code>{url || 'Preparing local link…'}</code><button className="icon-button" aria-label="Copy connection link" disabled={!url} onClick={() => copy(url)}><Icon name="copy" size={17}/></button></div>
  </div>;
  const windowAction = (action: string, data?: unknown) => window.glove?.call(action, data).catch(error => setNotice({ text: error.message, error: true }));
  const startAndroidQr = async () => { setAndroidStep('scan'); await run('startAndroidQr'); };
  const navLabels: Record<Place, string> = { devices: 'Devices', screen: 'Screen view', files: 'File sharing', settings: 'Settings' };
  const status = readyDevices.length ? readyDevices.length + ' Android device' + (readyDevices.length > 1 ? 's' : '') + ' connected' : state.viewing.connected ? 'Receiving iPhone screen' : 'No phone connected';
  return <div className="app-shell">
    <div className="app-titlebar">
      <div className="titlebar-identity"><img src={new URL('./brand.svg', import.meta.url).href} alt=""/><span>Glove</span></div>
      <div className="titlebar-drag-area" aria-hidden="true"/>
      <div className="window-controls">
        <button aria-label="Minimize window" disabled={!desktop} onClick={() => windowAction('windowMinimize')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10"/></svg></button>
        <button aria-label={state.window?.maximized ? 'Restore window' : 'Maximize window'} disabled={!desktop} onClick={() => windowAction('windowToggleMaximize')}><svg viewBox="0 0 16 16" aria-hidden="true">{state.window?.maximized ? <><path d="M5 5V3h8v8h-2"/><rect x="3" y="5" width="8" height="8"/></> : <rect x="3" y="3" width="10" height="10"/>}</svg></button>
        <button className="window-close" aria-label="Close window" disabled={!desktop} onClick={() => windowAction('windowClose')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13"/></svg></button>
      </div>
    </div>
    <aside className="sidebar">
      <div className="sidebar-heading">PHONE WORKSPACE</div>
      <nav aria-label="Main navigation">{(['devices', 'screen', 'files', 'settings'] as Place[]).map(key => <button className={'nav-item ' + (place === key ? 'selected' : '')} aria-current={place === key ? 'page' : undefined} onClick={() => { setPlace(key); setNotice(null); }} key={key}><Icon name={key}/><span>{navLabels[key]}</span>{key === 'files' && state.sharing.running && <span className="nav-dot" aria-label="Sharing is on"/>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-network"><Icon name="wifi" size={18}/><strong>Local connection</strong></div><p>Keep your phone and PC<br/>on the same Wi-Fi.</p><div className="sidebar-version">Glove for Windows <span>v{state.version}</span></div></div>
    </aside>
    <div className="workspace">
      <main>
        {!desktop && <div className="preview-note"><Icon name="screen" size={18}/><span>UI preview. Open the Windows app to pair a phone and transfer files.</span></div>}
        {notice && <div className={'notice ' + (notice.error ? 'error' : 'success')} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice(null)}><Icon name="close" size={17}/></button></div>}

        {place === 'devices' && <>
          <div className="page-heading"><div><div className="eyebrow">DEVICES</div><h1>Connect your phone</h1><p>View your screen or move files between your phone and PC.</p></div><span className="badge neutral"><Icon name="wifi" size={14}/> Same Wi-Fi</span></div>
          <div className="device-grid">
            <section className="device-card">
              <div className="device-card-top"><span className="platform-icon"><Icon name="phone" size={27}/></span><span className="badge">Android 11+</span></div>
              <h2>Android</h2><p>View and control your phone in a separate window.</p>
              <ul className="capability-list"><li><Icon name="check" size={16}/> Wireless pairing with a QR code</li><li><Icon name="check" size={16}/> Mouse and keyboard control via scrcpy</li><li><Icon name="check" size={16}/> Send and receive files in your browser</li></ul>
              <button className="button primary full" onClick={() => goScreen('android')}>Set up Android<Icon name="arrow" size={18}/></button>
              <small>Requires Developer options and separate scrcpy tools.</small>
            </section>
            <section className="device-card">
              <div className="device-card-top"><span className="platform-icon iphone"><Icon name="phone" size={27}/></span><span className="badge neutral">iPhone</span></div>
              <h2>iPhone</h2><p>Share your screen from Safari on iOS 27 or later.</p>
              <ul className="capability-list"><li><Icon name="check" size={16}/> Live screen viewing on this PC</li><li><Icon name="check" size={16}/> Secure Safari connection with certificate setup</li><li><Icon name="check" size={16}/> Browser file sharing on other iOS versions</li></ul>
              <button className="button secondary full" onClick={() => goScreen('iphone')}>Set up iPhone<Icon name="arrow" size={18}/></button>
              <small>Screen view only. Remote control and audio are unavailable.</small>
            </section>
          </div>
          <section className="handoff-strip"><span className="tile-icon"><Icon name="files" size={23}/></span><div><h3>Just need to send a file?</h3><p>Open a local link in any phone browser. No screen setup required.</p></div><button className="button secondary" onClick={() => setPlace('files')}>Open file sharing<Icon name="arrow" size={16}/></button></section>
          <div className="connection-note"><Icon name="wifi" size={17}/><span>Use a trusted private network. Guest Wi-Fi, VPNs and Windows Firewall may block phone connections.</span></div>
        </>}

        {place === 'screen' && <>
          <div className="page-heading"><div><div className="eyebrow">SCREEN VIEW</div><h1>{phone === 'android' ? 'Connect your Android' : 'View your iPhone screen'}</h1><p>{phone === 'android' ? 'Prepare your phone, pair over Wi-Fi, then open its screen.' : 'Share from Safari over a trusted local connection.'}</p></div></div>
          <div className="platform-tabs" aria-label="Phone platform"><button aria-pressed={phone === 'android'} className={phone === 'android' ? 'active' : ''} onClick={() => setPhone('android')}><Icon name="phone" size={17}/>Android</button><button aria-pressed={phone === 'iphone'} className={phone === 'iphone' ? 'active' : ''} onClick={() => setPhone('iphone')}><Icon name="phone" size={17}/>iPhone</button></div>
          {phone === 'android' ? <>
            {!state.toolsReady ? <section className="panel tools-gate">
              <span className="gate-icon"><Icon name="folder" size={30}/></span>
              <div><span className="badge">GET STARTED</span><h2>Install the Android tools first</h2><p>Glove uses the official scrcpy Windows tools to connect and control your phone. Download the archive, extract it, then select the folder containing <code>adb.exe</code> and <code>scrcpy.exe</code>.</p><div className="button-row"><button className="button primary" disabled={disabled} onClick={() => run('chooseTools')}>Choose tools folder<Icon name="folder" size={17}/></button><button className="text-button" onClick={() => run('openToolGuide')}>Open download guide<Icon name="arrow" size={16}/></button></div><p className="helper">Android 11 or later is required for wireless pairing. Both devices must use the same Wi-Fi.</p></div>
            </section> : <>
              <div className="setup-steps" aria-label="Android connection steps">
                {([{ id: 'prepare', title: 'Prepare phone', detail: 'Enable wireless debugging' }, { id: 'scan', title: 'Scan QR code', detail: 'Pair without a cable' }, { id: 'devices', title: 'Open screen', detail: 'Choose your connected phone' }] as const).map((step, index) => <button key={step.id} className={'setup-step ' + (androidStep === step.id ? 'active' : '')} aria-current={androidStep === step.id ? 'step' : undefined} onClick={() => setAndroidStep(step.id)}><span className="step-number">{index + 1}</span><span><strong>{step.title}</strong><small>{step.detail}</small></span></button>)}
              </div>
              {androidStep === 'prepare' && <section className="panel preparation-panel">
                <div className="panel-heading"><div><h2>Enable Developer options</h2><p>Do this on your phone. If Developer options are already enabled, continue to wireless debugging below.</p></div><span className="badge neutral">ONE-TIME SETUP</span></div>
                <div className="brand-selector" aria-label="Phone brand">{(['samsung', 'pixel', 'other'] as const).map(brand => <button key={brand} className={phoneBrand === brand ? 'active' : ''} aria-pressed={phoneBrand === brand} onClick={() => setPhoneBrand(brand)}>{brand === 'samsung' ? 'Samsung Galaxy' : brand === 'pixel' ? 'Google Pixel' : 'Other Android'}</button>)}</div>
                <div className="prepare-columns"><div><h3><span className="instruction-label">A</span> Turn on Developer options</h3><ol className="instructions">
                  <li>Open <strong>Settings → About phone</strong>{phoneBrand === 'samsung' ? <> → <strong>Software information</strong>.</> : '.'}</li>
                  <li>{phoneBrand === 'other' ? <>Find <strong>Build number</strong> (sometimes under Software information or About version). </> : <>Find <strong>Build number</strong>. </>}Tap it <strong>7 times</strong>.</li>
                  <li>Enter your phone PIN if asked. Look for a message that Developer options are enabled.</li>
                </ol></div><div><h3><span className="instruction-label">B</span> Enable wireless debugging</h3><ol className="instructions">
                  <li>{phoneBrand === 'samsung' ? <>Go back to <strong>Settings → Developer options</strong> near the bottom.</> : phoneBrand === 'pixel' ? <>Go back to <strong>Settings → System → Developer options</strong>.</> : <>Go back to Settings and search for <strong>Developer options</strong>.</>}</li>
                  <li>Turn on <strong>Wireless debugging</strong>. Allow it for your current Wi-Fi if prompted.</li>
                  <li>Open <strong>Wireless debugging → Pair device with QR code</strong>. Leave that scanner open.</li>
                </ol></div></div>
                <div className="panel-bottom"><p className="helper"><Icon name="phone" size={17}/> Use the scanner inside Wireless debugging. Your normal camera cannot pair Android.</p><button className="button primary" disabled={disabled} onClick={startAndroidQr}>{busy === 'startAndroidQr' ? 'Starting pairing…' : 'Phone ready — show QR code'}<Icon name="arrow" size={17}/></button></div>
              </section>}
              {androidStep === 'scan' && <section className="panel pairing-panel">
                <div className="pairing-copy"><span className="badge">WIRELESS PAIRING</span><h2>Scan from Wireless debugging</h2><p>On your phone, open <strong>Settings → Developer options → Wireless debugging → Pair device with QR code</strong>.</p><div className="inline-callout"><Icon name="phone" size={20}/><p>Use that pairing scanner to scan this code. Your normal camera app will not pair the device.</p></div><p className="helper">Keep your phone unlocked and both devices on the same Wi-Fi. Glove connects after pairing succeeds.</p>{androidQr.error && <p className="error-text" role="alert">{androidQr.error}</p>}<div className="button-row">{androidQr.active ? <button className="button secondary" disabled={disabled} onClick={() => run('stopAndroidQr')}>Cancel pairing</button> : <button className="button primary" disabled={disabled} onClick={startAndroidQr}>{busy === 'startAndroidQr' ? 'Starting…' : androidQr.status === 'expired' || androidQr.status === 'error' || androidQr.status === 'cancelled' ? 'Generate new QR code' : 'Show pairing QR code'}<Icon name="refresh" size={16}/></button>}<button className="text-button" onClick={() => setAndroidStep('prepare')}>Phone setup guide</button></div></div>
                <div className="pairing-code">{liveAndroidQr ? <><Qr value={androidQr.value} label="Android wireless debugging pairing QR code"/><div className="scan-status"><span className="activity-dot"/>{qrProgress[androidQr.status] || 'Waiting for phone'}</div><span className="countdown">Code expires in {Math.floor(qrSeconds / 60)}:{String(qrSeconds % 60).padStart(2, '0')}</span></> : <><div className="qr-empty"><Icon name="wifi" size={40}/></div><strong role="status">{androidQr.active ? qrSeconds === 0 && androidQr.value ? 'QR code expired' : qrProgress[androidQr.status] || 'Preparing pairing…' : qrProgress[androidQr.status] || 'Pairing is off'}</strong><p>{androidQr.active ? 'The pairing code appears when the service is ready.' : 'Generate a code to start a real pairing session.'}</p></>}</div>
              </section>}
              {androidStep === 'devices' && <section className="panel devices-panel">
                <div className="panel-heading"><div><h2>Connected Android devices</h2><p>Select an authorized phone to open its screen in a separate scrcpy window.</p></div><button className="button secondary small" disabled={disabled} onClick={() => run('refreshAndroid')}><Icon name="refresh" size={16}/>Refresh</button></div>
                {state.android.devices.length ? <div className="connected-devices">{state.android.devices.map(device => <div className="connected-device" key={device.serial}><span className="tile-icon"><Icon name="phone" size={23}/></span><div><strong>{device.model}</strong><small>{device.status === 'device' ? 'Connected and authorized' : device.status === 'unauthorized' ? 'Accept the debugging prompt on your phone' : device.status}<span className="device-serial">{device.serial}</span></small></div>{device.status === 'device' && <button className="button primary" disabled={disabled || state.android.mirroring} onClick={() => run('mirrorAndroid', { serial: device.serial })}>Open screen<Icon name="arrow" size={17}/></button>}</div>)}</div> : <div className="empty-state"><span className="empty-icon"><Icon name="phone" size={32}/></span><h3>No Android phone connected</h3><p>Pair your phone with a QR code, or use the manual options below.</p><button className="button primary" disabled={disabled} onClick={startAndroidQr}>Pair with QR code<Icon name="arrow" size={17}/></button></div>}
                {state.android.mirroring && <div className="mirror-open"><div><span className="status-pill live"><i/>Android screen is open</span><p>Use the separate window to control your phone.</p></div><button className="button secondary small" onClick={() => run('stopAndroid')}>Close screen</button></div>}
              </section>}
              {state.android.error && <div className="notice error" role="alert">{state.android.error}</div>}
              <details className="advanced-panel"><summary>Manual pairing & connection <span>Advanced fallback</span></summary><div className="advanced-content"><div><h3>Pair with a six-digit code</h3><p className="helper">On your phone: Wireless debugging → Pair device with pairing code. Use the address and code from that dialog.</p><form onSubmit={e => { e.preventDefault(); run('pairAndroid', { address: pairAddress, code: pairCode }).then(result => { if (result) setPairCode(''); }); }}><div className="form-row"><label>Pairing address<input autoComplete="off" value={pairAddress} onChange={e => setPairAddress(e.target.value)} placeholder="192.168.1.5:37123" required/></label><label className="code-field">Pairing code<input inputMode="numeric" autoComplete="off" type="password" maxLength={6} pattern="[0-9]{6}" value={pairCode} onChange={e => setPairCode(e.target.value)} placeholder="6 digits" required/></label></div><button className="button secondary" disabled={disabled}>{busy === 'pairAndroid' ? 'Pairing…' : 'Pair phone'}</button></form></div><div><h3>Connect an already paired phone</h3><p className="helper">Use the IP address and port on the main Wireless debugging screen. This port differs from the pairing port.</p><form onSubmit={e => { e.preventDefault(); run('connectAndroid', { address }).then(result => { if (result) setAndroidStep('devices'); }); }}><label>Connection address<input autoComplete="off" value={address} onChange={e => setAddress(e.target.value)} placeholder="192.168.1.5:39561" required/></label><button className="button secondary" disabled={disabled}>{busy === 'connectAndroid' ? 'Connecting…' : 'Connect phone'}<Icon name="wifi" size={16}/></button></form></div></div></details>
            </>}
            <div className="connection-note"><Icon name="wifi" size={17}/><span>Android 11+ · Same private Wi-Fi · Keep Wireless debugging enabled while connecting.</span></div>
          </> : <>
            {!state.viewing.running ? <section className="panel iphone-welcome"><span className="gate-icon"><Icon name="screen" size={32}/></span><div><span className="badge">SAFARI · iOS 27+</span><h2>Set up a secure screen connection</h2><p>Glove creates a local certificate for this PC. Download its profile on your iPhone, verify the actual certificate fingerprint, then enable trust before sharing your screen in Safari.</p><button className="button primary" disabled={disabled} onClick={() => { setViewStep('setup'); run('startViewing'); }}>{busy === 'startViewing' ? 'Preparing secure session…' : 'Start iPhone setup'}<Icon name="arrow" size={17}/></button><p className="helper">View only · No screen audio · Keep Safari open<br/>Other iOS versions can use <button className="inline-link" onClick={() => setPlace('files')}>file sharing</button>.</p></div></section> : <div className="iphone-grid">
              <section className="panel iphone-connection"><div className="panel-heading"><h2>Connect from Safari</h2><span className={'status-pill ' + (state.viewing.connected ? 'live' : '')}><i/>{state.viewing.connected ? 'Receiving screen' : 'Waiting for iPhone'}</span></div>
                <div className="sub-tabs"><button className={viewStep === 'setup' ? 'active' : ''} onClick={() => setViewStep('setup')}>1. Certificate setup</button><button className={viewStep === 'screen' ? 'active' : ''} onClick={() => setViewStep('screen')}>2. Share screen</button></div>
                {screenUrls.length ? <><div className="iphone-qr"><Qr value={screenUrl}/><h3>{viewStep === 'setup' ? 'Open setup on your iPhone' : 'Open the secure screen page'}</h3><p>{viewStep === 'setup' ? 'Scan with your iPhone camera and open in Safari. Download the Glove certificate profile.' : 'Scan with your iPhone camera. Open in Safari, tap Start screen sharing, then approve the system sharing picker.'}</p></div>{linkBox(screenUrl, screenUrls)}</> : noNetwork}
                {viewStep === 'setup' && <><div className="certificate-check"><h3>Verify the downloaded certificate</h3><p>Open the actual downloaded profile’s certificate details in iPhone Settings. Compare its <strong>SHA-256 fingerprint</strong> with this PC’s value below <strong>before installing or enabling full trust</strong>.</p><code className="fingerprint">{state.viewing.fingerprint}</code><p className="helper">Do not rely on a fingerprint printed on the HTTP setup page. If the certificate details do not expose SHA-256, stop setup and use an independently trusted way to verify or transfer the certificate.</p></div><ol className="instructions compact-instructions"><li>Settings → General → VPN & Device Management → downloaded Glove profile. Inspect its certificate, verify SHA-256, then install.</li><li>General → About → Certificate Trust Settings → enable full trust for <strong>{state.viewing.rootName || 'this PC’s Glove certificate'}</strong>.</li></ol><button className="button primary full" onClick={() => setViewStep('screen')}>Certificate verified & trusted<Icon name="arrow" size={17}/></button><p className="helper">Remove the Glove profile in Settings when you stop using this PC.</p></>}
                <button className="text-button danger" disabled={disabled} onClick={() => run('stopViewing')}>End viewing session</button>
              </section>
              <section className="screen-stage" aria-label="iPhone screen viewer"><div className="screen-stage-bar"><Icon name="screen" size={17}/><span>iPhone screen</span><span className={'screen-live ' + (state.viewing.connected ? 'active' : '')}>{state.viewing.connected ? 'LIVE' : 'WAITING'}</span></div><div className="screen-stage-content">{stream ? <video ref={video} autoPlay muted playsInline aria-label="Live iPhone screen"/> : <div><Icon name="phone" size={46}/><h3>Waiting for your screen</h3><p>Start screen sharing in Safari.<br/>Your live picture appears here.</p></div>}</div></section>
            </div>}
            <div className="connection-note"><Icon name="wifi" size={17}/><span>Same private Wi-Fi · Safari on iOS 27+ · Windows Firewall must allow the local connection.</span></div>
          </>}
        </>}

        {place === 'files' && <>
          <div className="page-heading"><div><div className="eyebrow">FILE SHARING</div><h1>Send files between devices</h1><p>Open a local link on your phone to send or download files.</p></div>{state.sharing.running ? <button className="button secondary" disabled={disabled} onClick={() => run('stopSharing')}>Stop sharing</button> : <button className="button primary" disabled={disabled} onClick={() => run('startSharing')}>{busy === 'startSharing' ? 'Starting…' : 'Start file sharing'}<Icon name="wifi" size={17}/></button>}</div>
          <div className="files-layout">
            <section className="panel connection-panel"><div className="panel-heading"><h2>Phone connection</h2><span className={'status-pill ' + (state.sharing.running ? 'live' : '')}><i/>{state.sharing.running ? 'Sharing on' : 'Off'}</span></div>{state.sharing.running ? <>{shareUrls.length ? <><Qr value={shareUrl}/><h3>Scan to open on your phone</h3><p>Use your camera or paste this link into your phone’s browser.</p>{linkBox(shareUrl, shareUrls)}</> : noNetwork}<div className="privacy-note">Use trusted private Wi-Fi. Transfers use unencrypted local HTTP. Anyone with this session link can access the shared files.</div></> : <div className="connect-empty"><span className="empty-icon"><Icon name="wifi" size={32}/></span><h3>Start a sharing session</h3><p>A QR code and local link will appear here. Works in Android and iPhone browsers.</p></div>}</section>
            <section className="panel file-list-panel"><div className="panel-heading"><div><h2>Shared files <span className="item-count">{state.sharing.items.length}</span></h2><p>Add files from this PC, or upload from your phone.</p></div><button className="button secondary small" disabled={disabled || !state.sharing.running} onClick={() => run('addFiles')}><Icon name="plus" size={16}/>Add files</button></div>{state.sharing.items.length ? <div className="file-list">{state.sharing.items.map(item => <div className="file-row" key={item.id}><span className="tile-icon"><Icon name={item.direction === 'from-phone' ? 'download' : 'files'} size={21}/></span><div className="file-info"><strong title={item.name}>{item.name}</strong><small>{formatSize(item.size)}<span>·</span>{item.direction === 'from-phone' ? 'Received from phone' : 'Available to phone'}</small></div><button className="icon-button" aria-label={'Remove ' + item.name + ' from sharing'} disabled={disabled} onClick={() => run('removeFile', { id: item.id })}><Icon name="close" size={17}/></button></div>)}</div> : <div className="empty-state file-empty"><span className="empty-icon"><Icon name="files" size={33}/></span><h3>No shared files yet</h3><p>{state.sharing.running ? 'Add a file from this PC, or send one from the phone connection page.' : 'Start file sharing to add files and connect your phone.'}</p></div>}<div className="file-footer"><span>Removing a received file here keeps it on your PC.</span><button className="text-button" onClick={() => run('openReceiveFolder')}><Icon name="folder" size={16}/>Open receive folder</button></div></section>
          </div>
        </>}

        {place === 'settings' && <>
          <div className="page-heading"><div><div className="eyebrow">SETTINGS</div><h1>Tools & storage</h1><p>Choose your Android tools and where incoming files are saved.</p></div></div>
          <section className="panel settings-panel"><span className="setting-icon"><Icon name="phone" size={25}/></span><div className="setting-body"><div className="panel-heading"><h2>Android screen tools</h2><span className={'status-pill ' + (state.toolsReady ? 'live' : '')}><i/>{state.toolsReady ? 'Ready' : 'Setup required'}</span></div><p>Download and extract the official Windows scrcpy archive. Choose the folder containing <code>adb.exe</code> and <code>scrcpy.exe</code>.</p><div className="path-field"><Icon name="folder" size={18}/><code>{state.settings.toolsFolder || 'No tools folder selected'}</code></div><div className="button-row"><button className="button primary small" disabled={disabled} onClick={() => run('chooseTools')}>Choose tools folder</button><button className="text-button" onClick={() => run('openToolGuide')}>Open download guide<Icon name="arrow" size={16}/></button></div><p className="helper">Tools are installed separately. Wireless pairing requires Android 11+ and Wireless debugging.</p></div></section>
          <section className="panel settings-panel"><span className="setting-icon"><Icon name="folder" size={25}/></span><div className="setting-body"><h2>Receive folder</h2><p>Files uploaded from your phone are saved here. They remain on your PC after sharing stops.</p><div className="path-field"><Icon name="folder" size={18}/><code>{state.settings.receiveFolder || 'Downloads → Glove'}</code></div><div className="button-row"><button className="button secondary small" disabled={disabled || state.sharing.running} onClick={() => run('chooseReceiveFolder')}>Change folder</button><button className="text-button" onClick={() => run('openReceiveFolder')}>Open folder<Icon name="arrow" size={16}/></button></div>{state.sharing.running && <p className="helper">Stop file sharing before changing the receive folder.</p>}</div></section>
          <section className="panel settings-panel">
            <span className="setting-icon"><Icon name="devices" size={25}/></span>
            <div className="setting-body">
              <div className="panel-heading"><h2>Developer tools</h2></div>
              <p>Give your MCP client read-only access to a connected Android screen. The client needs Node.js 24 or newer on this PC.</p>
              <div className="mcp-fields">
                <label>Android device
                  <select value={mcpDevice} onChange={event => setMcpDevice(event.target.value)}>
                    <option value="">Choose a connected device</option>
                    {state.android.devices.filter(device => device.status === 'device').map(device =>
                      <option key={device.serial} value={device.serial}>{device.model} ({device.serial})</option>
                    )}
                  </select>
                </label>
                <label>MCP client
                  <select value={mcpFormat} onChange={event => setMcpFormat(event.target.value === 'codex' ? 'codex' : 'json')}>
                    <option value="codex">Codex · TOML</option>
                    <option value="json">Claude Code · JSON</option>
                  </select>
                </label>
              </div>
              <div className="button-row">
                <button className="button secondary small" disabled={disabled || !state.toolsReady} onClick={() => run('refreshAndroid')}>Refresh devices</button>
                <button className="button primary small"
                  disabled={disabled || !state.android.devices.some(device => device.serial === mcpDevice && device.status === 'device')}
                  onClick={() => run('copyMcpConfig', { serial: mcpDevice, format: mcpFormat })}>
                  Copy MCP configuration<Icon name="copy" size={16}/>
                </button>
              </div>
              <p className="helper">Paste the configuration into the client on this PC.</p>
            </div>
          </section>
          <div className="about-row"><img src={new URL('./brand.svg', import.meta.url).href} alt=""/><div><strong>Glove for Windows <span>v{state.version}</span></strong><p>Original application code: MIT License. Third-party notices are included with the app.</p></div></div>
        </>}
      </main>
      <footer className="statusbar"><span><i className={readyDevices.length || state.viewing.connected ? 'connected' : ''}/>{status}</span><span>{state.sharing.running ? 'File sharing is on' : 'Local network workspace'}</span></footer>
    </div>
  </div>;
}
function formatSize(bytes: number) { if (bytes < 1024) return bytes + ' B'; if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB'; if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB'; return (bytes / 1024 ** 3).toFixed(2) + ' GB'; }
createRoot(document.getElementById('root')!).render(<App/>);
