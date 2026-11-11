// SPDX-License-Identifier: MIT
export type Device = { serial: string; model: string; status: string };
export type ShareItem = { id: string; name: string; size: number; direction: 'to-phone' | 'from-phone'; createdAt: string | number };
export type PersonalNotification = {
  id: string;
  title: string;
  body: string;
  app: string;
  time: number;
  replyable: boolean;
};
export type PersonalReply = {
  id: string;
  notificationId: string;
  status: 'pending' | 'submitted' | 'expired' | 'failed' | 'unknown';
};
export type PersonalState = {
  pairing: { payload: string; expiresAt: number } | null;
  request: { id: string; name: string; code: string } | null;
  device: { name: string; online: boolean; access: boolean } | null;
  notifications: PersonalNotification[];
  paused: boolean;
  reply: PersonalReply | null;
  error: string | null;
};
export type AppState = {
  version: string;
  window?: { maximized: boolean };
  settings: { toolsFolder: string; receiveFolder: string };
  toolsReady: boolean;
  personal: PersonalState;
  companionApkReady?: boolean;
  installerSharing?: boolean;
  android: { devices: Device[]; mirroring: boolean; error: string; qr?: { active: boolean; value: string; expiresAt: number | null; status: string; error?: string } };
  sharing: { running: boolean; port: number | null; urls: string[]; items: ShareItem[] };
  viewing: { running: boolean; port: number | null; setupPort: number | null; urls: string[]; setupUrls: string[]; fingerprint: string | null; rootName?: string | null; offer?: RTCSessionDescriptionInit | null; sessionId?: string | null; status?: string; connected: boolean };
};
export type Bridge = { call: (action: string, data?: unknown) => Promise<any>; subscribe: (callback: (state: AppState) => void) => () => void };
declare global { interface Window { glove?: Bridge } }
