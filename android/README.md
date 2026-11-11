# Glove Companion for Android

Glove Companion connects Android notifications to Glove on Windows over your private network. It requires Android 11 or newer. The Personal workspace pairs through the companion, using Android’s normal camera and notification access controls. Screen control and MCP setup live in the Windows Developer workspace.

## Try the preview

1. Put the Windows PC and Android phone on the same private Wi-Fi network.
2. In Glove on Windows, open **Personal → Notifications** and choose **Share Android installer**. Scan the file sharing code with your phone’s regular camera, download **Glove-Companion.apk**, and open it to install. Use the preview installer supplied with your Windows build. Android may ask whether your browser can install this APK.
3. In Glove, choose **Continue to pairing → Pair Android**. Open **Glove Companion** on your phone and tap **Scan Windows QR**. Grant camera access when Android asks, scan the Windows code, and tap **Pair with this PC**.
4. Compare the six-digit code on your phone and PC. Approve in Glove on Windows if they match.
5. On your phone tap **Allow notification access**, enable **Glove Companion** in Android Settings, then return to the companion. Tap **Choose apps**, pick a test messaging app, and tap **Save**.
6. Leave the phone unlocked and have someone send a test message to the selected app. If its Android notification includes a text reply action, Glove displays a reply box. **Submitted** means Glove handed the text to the phone app.

Some Android builds restrict notification access for APKs installed from a browser. For a preview APK you trust, Android documents the per-app **Allow restricted settings** option on its App info page. Availability depends on the installer and phone policy. [Android restricted settings](https://support.google.com/android/answer/12623953)

The preview supports one phone per PC pairing and reconnects to the saved PC address. If the address changes, forget the pairing on both devices and scan again. Notifications are held in memory. The companion excludes secret notifications, likely verification codes and aggregate group summaries. It pauses forwarding and replies while the phone is locked or its screen is off. Use **Pause sharing**, **Manage notification access**, or **Forget this PC** in the companion to stop sharing.

## Build the companion on Windows

Install JDK 17 or newer, Android SDK Platform 36, and Build Tools 36.0.0. Set `ANDROID_HOME` to the SDK path if the SDK is installed outside the usual Android Studio location.

```powershell
./android/build.ps1
```

The build verifies the pinned ZXing Core 3.5.4 dependency, generates a local preview signing key on the first run, and verifies the APK signature. Find the APK at `android/out/Glove-Companion.apk`. Retain the preview key to install subsequent builds over this one. Keep the key private. Different preview keys require uninstalling the old app before installing the replacement.

Glove’s Android code uses the MIT license. The bundled ZXing decoder uses the Apache 2.0 license. The APK includes both license texts.
