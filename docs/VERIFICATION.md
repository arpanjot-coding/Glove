# Glove verification

This is the Windows x64 development preview. The final package opened on the Windows test PC using its normal executable. The app was left open for a physical phone test.

## Personal notifications and file sharing

- The Android 16 emulator installed the companion APK, paired with the Windows service over certificate-pinned HTTPS, and matched the same six-digit approval code on both sides. The test entered the pairing payload through the companion's manual fallback. The emulator camera opened. Its injected QR image did not decode, so scanning a Windows QR with a physical Android camera still needs a handset test.
- Before Android granted notification access, Windows showed no previews. With only the synthetic test app selected, Windows received an informational notification and a notification offering a text reply. The secret notification stayed on Android.
- Glove sent a reply through the original Android notification's free-form action. The test app received the exact text once and Glove reported that the reply was submitted. The test also checked reconnection after an APK upgrade, pause and resume, notification permission revocation, and forgetting the pairing.
- In the native Windows app, the Android installer sharing session listed only the bundled APK. Continuing to pairing closed that session. The ordinary file sharing page generated its own camera QR. Developer screen control and MCP setup appeared in a separate workspace.

## Android and MCP

- Glove discovered an authorized Android 16 (API 36) emulator through the real Android tools. The run caught a device-list parsing bug. Current ADB aligns its columns with spaces, so Glove now accepts both spaces and tabs.
- scrcpy 5.0.1 recorded 126 decodable H.264 frames at 864 × 1920 over 3.204 seconds from a synthetic test app. The ADB connection used local emulator transport. [Sample recording](qa/emulator-scrcpy.mp4)
- The official MCP SDK 1.32.2 client discovered the same emulator, captured a 1080 × 2400 PNG, sent a tap, and captured the updated screen. The test app changed colour and its tap count advanced from zero to one. [Result screenshot](qa/emulator-mcp-after.png)
- A separate Android fixture downloaded and uploaded different 8,388,645-byte files through Glove's real sharing service. SHA-256 and byte counts matched in both directions. The download took 1,781 ms and the upload took 986 ms over the emulator's connection to the host. These are individual emulator timings.
- The Android QR workflow generates a code using real ADB discovery. Unit tests exercise QR matching, authorized connection detection, expiry, cancellation and fallback addresses. The installed Android emulator image lacks the Wireless Debugging Settings screen, so the scan and pair step still needs a physical Android phone.

## Size and startup work

- The application archive fell from 56,361,969 bytes to 1,555,758 bytes after removing duplicate renderer dependencies and build caches. That is a 97.2% reduction in `app.asar`. The full Windows distribution also includes Electron, Chromium and their runtime libraries.
- Moving QR rendering into an on-demand chunk reduced the initial renderer script from 292.25 kB to 272.20 kB in the production build. QR code generation loads when a pairing or sharing link is shown.
- The median load time for the viewing module fell from 45.5 ms to 17.7 ms across seven fresh Node processes per version. This isolated import measurement covers the move to on-demand HTTPS and certificate imports. It does not measure time to open the full Windows app.
- Service updates now use one debounced state event. The renderer no longer requests the full state after each action, and the desktop app checks the Android tools path outside the renderer startup path.

## Automated checks

`npm test` passes 54 tests. Regression cases cover overlapping pairing and mirror actions, phone-side revocation, stale ADB transports, partial transfer retry, and late iPhone signaling. The production UI and Windows installer build. The archive contains only the certificate provider as an external desktop dependency. The MCP server and QA skill ship as standalone resources.

The iPhone tests verify certificate setup, signaling, and session expiry. End-to-end Safari screen sharing and phone browser transfers still need physical device tests. The compatible model families on the website describe eligibility based on device requirements.

## Reproduce

Use `npm test` and `npm run build` in the source checkout. For Android device testing, connect an authorized phone or emulator, check its serial in Glove and follow the [MCP guide](MCP.md) and [mobile QA skill](../skills/glove-mobile-qa/SKILL.md). A development build remains unsigned. Whether Windows allows it to run depends on the PC's application policy.
