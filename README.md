<p align="center">
  <a href="https://arpanjot-coding.github.io/Glove/">
    <img src="docs/assets/glove-social.jpg" width="100%" alt="Glove product artwork showing a laptop and phone connected wirelessly">
  </a>
</p>

<h1 align="center">Glove</h1>

<p align="center"><strong>Wireless Android screen control, phone file sharing, and mobile QA on Windows.</strong></p>

<p align="center">
  <a href="https://arpanjot-coding.github.io/Glove/">Website</a> ·
  <a href="https://arpanjot-coding.github.io/Glove/demos/">Watch the demos</a> ·
  <a href="https://arpanjot-coding.github.io/Glove/setup/">Setup guide</a> ·
  <a href="https://arpanjot-coding.github.io/Glove/compatibility/">Compatibility</a> ·
  <a href="docs/MCP.md">Developer MCP</a>
</p>

Glove is an open-source Windows x64 preview. Mirror and control an Android phone over Wi-Fi, move files between a phone browser and your PC, or let a coding agent inspect an authorized Android test device.

## A look inside Glove

<img src="docs/assets/glove-app.webp" width="100%" alt="Glove's Devices page in the Windows app with Android and iPhone connection options">

*The Windows desktop app, ready to connect a phone.*

<details>
<summary>See Android setup and file sharing</summary>

<img src="docs/assets/glove-android.webp" width="49%" alt="Glove's Android Developer options guide with Samsung Galaxy instructions">
<img src="docs/assets/glove-files.webp" width="49%" alt="Glove's file sharing page with controls to start a transfer session">

</details>

## What you can do

- **Mirror and control Android over Wi-Fi.** Pair by QR from Android's Wireless debugging screen, then open the phone in scrcpy. Wireless pairing requires Android 11+ and separately installed scrcpy Windows tools. An authorized Android emulator also works for testing.
- **Send files in either direction.** Open a Glove link in the Android or iPhone browser. Uploads stream to your selected receive folder. Each file can be up to 2 GiB.
- **Try iPhone screen viewing.** The experimental HTTPS session targets Safari on iOS 27+ and needs a compatible system screen picker. Physical iPhone playback is still unverified. The session is view-only.
- **Test an Android app with an agent.** The local MCP server captures PNG screenshots from one selected test device. Enable input to tap, swipe, and press Back. [MCP guide](docs/MCP.md)

## Watch the demos

- **Screen mirroring.** Watch scrcpy record the Android 16 emulator at 864 × 1920. This demo used local emulator ADB transport. [Video](https://arpanjot-coding.github.io/Glove/demos/#screen-mirroring)
- **Agent-driven QA.** Compare before and after screenshots from a real MCP screenshot → tap → screenshot run. [MCP demo](https://arpanjot-coding.github.io/Glove/demos/#developer-testing)
- **File transfer.** A test fixture uploaded and downloaded 8,388,645 bytes per direction. File sizes and SHA-256 hashes matched. [Transfer results](https://arpanjot-coding.github.io/Glove/demos/#file-sharing)

See the [verification notes](docs/VERIFICATION.md) for test conditions and physical-device coverage.

## Get started on Windows

Build the preview from source with Node.js 24+ on Windows x64. The portable build is unsigned.

```powershell
git clone https://github.com/arpanjot-coding/Glove.git
cd Glove
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

**Android.** In **Settings → Android screen tools**, choose the extracted [scrcpy Windows tools](https://github.com/Genymobile/scrcpy/blob/master/doc/windows.md). Open **Screen view → Android** for step-by-step instructions to turn on Developer options and Wireless debugging. Use the QR scanner inside **Wireless debugging → Pair device with QR code**. Manual pairing is available when local discovery fails.

**Files.** In **File sharing**, start a session and scan its QR with your phone's camera. Keep both devices on the same trusted private network. The file link grants access to that session over local HTTP. Stop sharing when you finish.

**iPhone screen preview.** Follow the setup guide to verify the downloaded certificate fingerprint before trusting the certificate. Remove the certificate profile when you no longer use it. File sharing works independently of screen viewing. [iPhone setup](https://arpanjot-coding.github.io/Glove/setup/#iphone)

## Mobile testing with Codex, Claude Code, or VS Code

Choose an authorized test device in **Settings → Developer tools** and copy the configuration for your local MCP client. Run that client on the Windows PC hosting ADB. The [Glove mobile QA skill](skills/glove-mobile-qa/SKILL.md) gives the agent a workflow for checking the device, taking screenshots, navigating with optional input, and collecting evidence. [Developer guide](https://arpanjot-coding.github.io/Glove/developers/)

## Compatibility and support

The [compatibility guide](https://arpanjot-coding.github.io/Glove/compatibility/) covers Samsung Galaxy, Google Pixel, OnePlus, Motorola, Xiaomi, and other phone families. Wireless debugging availability depends on the Android version, model, and device policy. See the guide for tested configurations and platform requirements.

Run `npm test` to check pairing, local transfers, iPhone signaling, and the MCP protocol. Use `npm run dev` for the development shell or `npm run package:win` to build the unsigned portable folder at `release/Glove-win32-x64`. [Report an issue](https://github.com/arpanjot-coding/Glove/issues/new)

## License

Glove's original source and mobile QA skill use the [MIT License](LICENSE). Dependencies retain their own licenses. Glove uses a separate installation of scrcpy for Android screen control. [Third-party notices](THIRD-PARTY-NOTICES.txt)
