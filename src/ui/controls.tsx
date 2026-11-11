// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import {
  Add24Regular, Alert24Regular, ArrowDownload24Regular, ArrowRight24Regular, ArrowSync24Regular,
  Checkmark24Regular, Code24Regular, Copy24Regular, Desktop24Regular, Dismiss24Regular,
  Folder24Regular, Phone24Regular, PhoneDesktop24Regular, QrCode24Regular, Send24Regular,
  Settings24Regular, Wifi124Regular
} from '@fluentui/react-icons';

const icons = {
  devices: PhoneDesktop24Regular, notifications: Alert24Regular, screen: Desktop24Regular,
  files: Folder24Regular, developer: Code24Regular, settings: Settings24Regular,
  arrow: ArrowRight24Regular, wifi: Wifi124Regular, check: Checkmark24Regular,
  copy: Copy24Regular, plus: Add24Regular, folder: Folder24Regular, close: Dismiss24Regular,
  phone: Phone24Regular, refresh: ArrowSync24Regular, download: ArrowDownload24Regular,
  qr: QrCode24Regular, send: Send24Regular
};

export function Icon({ name, size = 20 }: { name: keyof typeof icons; size?: number }) {
  const Glyph = icons[name];
  return <Glyph width={size} height={size} style={{ fontSize: size }} aria-hidden="true"/>;
}

export function Qr({ value, label = 'Scan this connection QR code with your phone' }: { value: string; label?: string }) {
  const [result, setResult] = useState<{ value: string; src: string } | null>(null);
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    import('qrcode')
      .then(({ default: qr }) => qr.toDataURL(value, { width: 232, margin: 3, color: { dark: '#0f172a', light: '#ffffff' }, errorCorrectionLevel: 'M' }))
      .then(src => { if (!cancelled) setResult({ value, src }); })
      .catch(() => { if (!cancelled) setResult({ value, src: '' }); });
    return () => { cancelled = true; };
  }, [value]);
  if (value && result?.value === value && result.src) return <img className="qr" src={result.src} alt={label}/>;
  return <div className="qr placeholder" role="status">{value && result?.value === value ? 'Could not generate QR code. Restart this session.' : 'Preparing QR code…'}</div>;
}
