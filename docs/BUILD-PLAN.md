# Glove MIT — initial Windows release

This is a separately written application. No source or assets from the earlier GPL fork are included. Original Glove code is MIT; third-party components retain their licenses. This is not a formal clean-room process: the developer has previously seen the old project, so provenance is maintained by independent implementation and explicit dependency records.

## Agreed product

Windows only. Android wireless pairing and screen control via separately installed ADB/scrcpy. iPhone screen viewing via Safari on iOS 27+, explicitly accepted by the user. Browser file sharing for either phone. No Linux/Docker workspace. No cloud service or account.

## Interaction and appearance

Graphite navigation, cool neutral workspace, white panels, blue actions, legible Segoe UI typography, Microsoft Fluent icons and an original vector mark. A minimal custom draggable Windows header includes the Glove identity and window controls. Four destinations: Devices, Screen, Files, Settings. Initial screen explains both phone paths. Android setup guides Developer mode and Wireless debugging before QR pairing; manual pairing remains available. Each connection action reports a real result or actionable error. Native file/folder dialogs stay in the desktop process. Minimum window 980 × 720.

## Implementation and acceptance

1. Electron shell with isolated preload and narrow IPC; renderer has no Node access.
2. Android tools folder selected by user, argument-array subprocesses, paired Wi-Fi endpoint validation, device list, mirroring process lifecycle.
3. Tokenized local file server; native selection, phone uploads, exact downloads, bounded input, session stop.
4. iOS secure local capture page with generated local CA and explicit certificate trust; WebRTC display; status based on actual media.
5. Build a portable Windows folder, retain Electron/Chromium notices, produce dependency report and source archive.

Verification: Node integration tests on loopback, strict renderer types/build, dependency license inventory, desktop/browser UI inspection at default and minimum size, independent review. Physical Android/iPhone connection remains unverified without attached phones. No signature or installer publication is in scope.
