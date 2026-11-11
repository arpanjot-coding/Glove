// SPDX-License-Identifier: MIT
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { PersonalNotification, PersonalReply, PersonalState } from './contracts';
import { Icon, Qr } from './controls';

export const emptyPersonal: PersonalState = {
  pairing: null, request: null, device: null, notifications: [], paused: false, reply: null, error: null
};

const replyMessages: Record<PersonalReply['status'], string> = {
  pending: 'Sending to your phone…',
  submitted: 'Reply submitted to the phone app.',
  expired: 'The reply expired. Check the notification or open the conversation on your phone.',
  failed: 'The phone app could not accept the reply.',
  unknown: 'Glove could not confirm the reply. Check your phone before trying again.'
};
const notificationTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type RunAction = (action: string, data?: unknown) => Promise<unknown>;
type SendReply = (id: string, text: string) => Promise<string | undefined>;

function PairingCode({ pairing }: { pairing: NonNullable<PersonalState['pairing']> }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000));
  return <div className="pairing-code personal-pairing-code">
    {seconds > 0 ? <>
      <Qr value={pairing.payload} label="Glove Companion pairing QR code"/>
      <div className="scan-status"><span className="activity-dot"/>Ready to scan</div>
      <span className="countdown">Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
    </> : <strong role="status">Pairing code expired</strong>}
  </div>;
}

function NotificationCard({ item, reply, disabled, sendReply }: {
  item: PersonalNotification; reply: PersonalReply | null; disabled: boolean; sendReply: SendReply;
}) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [attempt, setAttempt] = useState<{ id: string; text: string } | null>(null);
  const field = useId();
  const date = new Date(item.time);
  const feedback = reply?.notificationId === item.id ? replyMessages[reply.status] : null;

  useEffect(() => {
    if (reply?.status !== 'submitted' || !attempt || reply.id !== attempt.id) return;
    setDraft(value => value.trim() === attempt.text ? '' : value);
    setComposing(false);
    setAttempt(null);
  }, [attempt, reply]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (disabled || !text) return;
    const id = await sendReply(item.id, text);
    if (id) setAttempt({ id, text });
  };

  return <li className="notification-item">
    <div className="notification-meta">
      <span><Icon name="notifications" size={16}/>{item.app}</span>
      {Number.isFinite(date.getTime()) && <time dateTime={date.toISOString()}>{notificationTime.format(date)}</time>}
    </div>
    {item.title && <h3>{item.title}</h3>}
    {item.body && <p className="notification-body">{item.body}</p>}
    {item.replyable && (composing ? <form className="notification-reply" onSubmit={submit}>
      <label htmlFor={field}>Your reply</label>
      <textarea id={field} autoFocus autoComplete="off" value={draft} maxLength={1000} rows={2} required
        disabled={disabled} onChange={event => setDraft(event.target.value)}/>
      <div className="button-row">
        <button className="button primary small" disabled={disabled || !draft.trim()}>
          Send reply<Icon name="send" size={16}/>
        </button>
        <button className="button secondary small" type="button" disabled={disabled} onClick={() => setComposing(false)}>Close reply</button>
      </div>
    </form> : <button className="button secondary small reply-button" disabled={disabled} onClick={() => setComposing(true)}>Reply</button>)}
    {feedback && <p className="notification-feedback" role="status">{feedback}</p>}
  </li>;
}

export function PersonalInbox({ state, busy, apkReady, run, sendReply, shareInstaller }: {
  state: PersonalState; busy: boolean; apkReady: boolean; run: RunAction; sendReply: SendReply;
  shareInstaller: () => Promise<void>;
}) {
  const { device, pairing, request, paused, reply, error } = state;
  const ready = !!device?.online && device.access && !paused;
  const deviceStatus = !device?.online ? 'Offline' : paused ? 'Paused' : device.access ? 'Connected' : 'Permission needed';
  const visibleNotifications = ready ? state.notifications : [];

  return <div className="personal-workspace">
    <div className="page-heading">
      <div>
        <div className="eyebrow">PERSONAL</div>
        <h1>Notifications</h1>
        <p>Read notifications from the Android apps you choose and reply when the phone app allows it.</p>
      </div>
      <span className="badge neutral"><Icon name="wifi" size={14}/>Same Wi-Fi</span>
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}

    {request ? <section className="panel pairing-panel personal-pairing" aria-labelledby="approve-phone">
      <div className="pairing-copy">
        <span className="gate-icon"><Icon name="phone" size={28}/></span>
        <h2 id="approve-phone">Confirm your phone</h2>
        <p><strong>{request.name}</strong> wants to connect. Compare the code with the one in Glove Companion before approving.</p>
        <div className="button-row">
          <button className="button primary" disabled={busy} onClick={() => run('approvePersonalPairing', { id: request.id })}>Approve phone<Icon name="check" size={17}/></button>
          <button className="button secondary" disabled={busy} onClick={() => run('denyPersonalPairing', { id: request.id })}>Decline</button>
        </div>
      </div>
      <div className="pairing-code personal-pairing-code">
        <span>Matching code</span>
        <strong className="personal-match-code">{request.code}</strong>
      </div>
    </section> : pairing ? <section className="panel pairing-panel personal-pairing" aria-labelledby="scan-personal">
      <div className="pairing-copy">
        <span className="gate-icon"><Icon name="qr" size={28}/></span>
        <h2 id="scan-personal">Scan in Glove Companion</h2>
        <p>In Glove Companion on Android, tap <strong>Scan Windows QR</strong>, scan this code, then tap <strong>Pair with this PC</strong>.</p>
        <div className="inline-callout"><Icon name="phone" size={19}/><p>Once scanned, Glove shows a six-digit code on both screens for you to compare.</p></div>
        <div className="button-row"><button className="button secondary" disabled={busy} onClick={() => run('stopPersonalPairing')}>Cancel pairing</button></div>
      </div>
      <PairingCode key={pairing.expiresAt} pairing={pairing}/>
    </section> : device ? <>
      <section className="panel personal-device" aria-labelledby="personal-phone-name">
        <span className="platform-icon"><Icon name="phone" size={26}/></span>
        <div className="personal-device-info">
          <h2 id="personal-phone-name">{device.name}</h2>
          <span className={`status-pill ${ready ? 'live' : ''}`}><i/>{deviceStatus}</span>
        </div>
        <div className="button-row personal-device-actions">
          <button className="button secondary small" disabled={busy} onClick={() => run('setPersonalPaused', { paused: !paused })}>{paused ? 'Resume notifications' : 'Pause notifications'}</button>
          <button className="button secondary small" disabled={busy} onClick={() => run('forgetPersonalDevice')}>Forget phone</button>
        </div>
      </section>
      <section className="panel personal-feed" aria-labelledby="personal-inbox">
        <div className="panel-heading">
          <div><h2 id="personal-inbox">Recent notifications <span className="item-count">{visibleNotifications.length}</span></h2></div>
        </div>
        {reply && !visibleNotifications.some(item => item.id === reply.notificationId) &&
          <p className="notification-feedback" role="status">{replyMessages[reply.status]}</p>}
        {visibleNotifications.length ? <ul className="notification-list">
          {visibleNotifications.map(item => <NotificationCard key={item.id} item={item} reply={reply} sendReply={sendReply} disabled={busy || reply?.status === 'pending'}/>)}
        </ul> : <div className="empty-state personal-feed-empty">
          <span className="empty-icon"><Icon name="notifications" size={29}/></span>
          <h3>{paused ? 'Notifications are paused' : !device.online ? 'Waiting for your phone' : !device.access ? 'Notifications are unavailable on Android' : 'No recent notifications'}</h3>
          <p>{paused ? 'Resume when you want to see your phone’s notifications again.' : !device.online ? 'Open Glove Companion, allow notification access, and check that both devices are on the same Wi-Fi.' : !device.access ? 'Unlock your phone and open Glove Companion to check notification access and whether sharing is paused.' : 'In Glove Companion, tap Choose apps and save your selection. Their eligible notifications will appear here.'}</p>
          {device.online && !device.access && !paused && <RestrictedSettings/>}
        </div>}
      </section>
    </> : <section className="panel personal-welcome" aria-labelledby="pair-android-phone">
      <span className="gate-icon"><Icon name="notifications" size={29}/></span>
      <div>
        <h2 id="pair-android-phone">Connect an Android phone</h2>
        <p>Use Glove Companion on Android 11 or newer to pair over Wi-Fi. Developer options can stay off.</p>
        <ol className="instructions personal-steps">
          <li><strong>Install Glove Companion.</strong> {apkReady ? 'Use Share Android installer, then scan the file sharing code with your phone’s camera.' : 'Install the Glove Companion APK on your phone.'}</li>
          <li><strong>Pair your phone.</strong> Show the pairing QR here and scan it in Glove Companion.</li>
          <li><strong>Choose what to show.</strong> Grant Android notification access and select apps on the phone.</li>
        </ol>
        <div className="button-row">
          <button className="button primary" disabled={busy} onClick={() => run('startPersonalPairing')}>Pair Android<Icon name="qr" size={17}/></button>
          {apkReady && <button className="button secondary" disabled={busy} onClick={shareInstaller}>Share Android installer<Icon name="download" size={17}/></button>}
        </div>
        <RestrictedSettings/>
      </div>
    </section>}
  </div>;
}

function RestrictedSettings() {
  return <details className="personal-permission-help">
    <summary>Android blocks notification access</summary>
    <p>On your phone, open Settings → Apps → Glove Companion. From the three-dot menu, choose <strong>Allow restricted settings</strong> if Android offers it, then grant notification access in the companion.</p>
  </details>;
}
