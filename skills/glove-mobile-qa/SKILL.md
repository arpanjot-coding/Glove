---
name: glove-mobile-qa
description: Test an app on an authorized Android phone or emulator using Glove MCP screenshots, taps, swipes, and Back. Use for mobile smoke tests, regression checks, and collecting device evidence. Use the separate iPhone checklist for manual Safari or hardware verification.
license: MIT
---

# Glove mobile QA

## Set up the run

1. Record the app build, feature under test, starting screen, and expected result. Use an emulator or test account when the flow could expose personal data.
2. Select one authorized Android device in Glove. Pair a physical phone using **Wireless debugging**. An emulator can use its normal local ADB transport. Identify which transport you tested.
3. In **Settings → Developer tools**, refresh devices, choose the target, and copy the MCP configuration for your client. Start with screenshot access. For a requested interactive test, enable input on that same device using `docs/MCP.md` in the repository or `MCP.md` in the Windows package.
4. Call `android_list_devices` and confirm the expected device is online. Open the test app using the project's normal test setup. Coordinate with anyone else using the device before sending input.

## Run a mobile flow

1. Call `android_screenshot` and inspect the image at its original pixel dimensions. Identify the intended control from the current screen.
2. Perform one action. Use `android_tap` for a visible control, `android_swipe` for a bounded scroll, or `android_back` to check navigation. Tap and swipe require a fresh capture. Map coordinates to the original screenshot if the client resized the preview.
3. Capture the result before choosing another action. For a loading state, wait for the expected screen with a short deadline. If it remains loading, record the state and the elapsed time.
4. Check the main workflow, Back or cancel, and a relevant recovery case such as a lost connection or invalid input. Use the project's expected behavior to decide whether content, scroll position, and saved state should survive navigation.
5. Inspect critical screenshots for clipped text, controls hidden by system bars or the keyboard, unreadable contrast, and layouts that cannot scroll. Check orientation changes when the app supports them.
6. When a flow creates or transfers a file, open the saved file and confirm its content. For an exact transfer, compare byte count and SHA-256 on both ends.

If the device disconnects or shows a sensitive prompt, pause the flow and ask the owner to restore the intended test state. Keep screenshots with private information out of shared reports.

## Test iPhone flows

Use a physical iPhone or an available iOS simulator with the project's usual test tools. Glove's Windows iPhone view is for observing screen video. Use the iPhone itself to interact. For Glove screen sharing, verify Safari's capture support, the downloaded certificate fingerprint, the sharing prompt, live video, and stopping the session. For file sharing, send and open a disposable file in both directions.

Record iPhone evidence separately. A Windows browser preview can verify page layout, and a loopback test can verify the transfer or signaling service. Physical Wi-Fi pairing and Safari screen capture require evidence from the corresponding phone.

## Report evidence

For each case record the build, device model and OS, transport, steps, expected result, observed result, and evidence path. Mark the case **pass**, **fail**, or **blocked**. Inspect the screenshot or output file before marking it passed. Save only the evidence needed to reproduce the result.

Example case: On the Android test device, open the test app, capture its first screen, scroll to the last item, and press Back. Verify the app returns to the previous screen and that the result matches its documented navigation behavior.
