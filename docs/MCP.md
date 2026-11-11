# Android developer testing with Glove MCP

Glove lets a local MCP client inspect a connected Android screen and, with UI input enabled, tap, swipe, and go back. It uses the same local ADB connection as the Windows app. Pair your phone through Glove before using MCP over Wi-Fi. An Android emulator connected to that same ADB server also works as a test target.

Use Node.js 24 or newer. From a source checkout, the entry point is `src/mcp/main.mjs`. In the portable Windows package, use `resources/mcp/main.mjs`.

## Copy configuration from Glove

1. In Glove, open **Developer → MCP testing** and select **Refresh devices**.
2. Choose the connected Android device and either **Codex · TOML** or **Claude Code · JSON**.
3. Select **Copy MCP configuration**. Merge the copied server entry into `~/.codex/config.toml` for Codex or your project's `.mcp.json` for Claude Code. Start a new client session.

The copied configuration binds read-only screenshot access to the selected device. For a requested interactive test, append `"--allow-input"` to that client's argument array and restart its MCP session.

The mobile QA skill describes how to inspect the device, navigate with bounded gestures, and report the observed result. Find it at `resources/glove-mobile-qa/SKILL.md` in the portable build. [Glove mobile QA skill in the repository](../skills/glove-mobile-qa/SKILL.md).

## Choose a device

1. In Glove, choose the folder containing the official `adb.exe` and `scrcpy.exe` tools.
2. Pair your Android 11+ phone through **Wireless debugging → Pair device with QR code** and wait until Glove lists it as connected.
3. Set `--adb` to the absolute path of that `adb.exe`. You can omit `--device` for discovery and call `android_list_devices` to see the authorized devices. You can also find the serial with `adb devices -l` using the same executable.
4. Add `--device` with the exact serial shown by ADB, then restart the MCP client session. A Wi-Fi serial can be an IP and port or an ADB mDNS name.
5. For navigation, add `--allow-input` to the client configuration and restart its MCP session.

The server handles one device operation at a time. Capture a fresh screenshot before each tap or swipe, and check the resulting screen before proceeding. Screenshot coordinates are pixels in the original image, measured from the top left. Tool results send screenshots to the requesting MCP client, which may pass them to its configured model provider. Keep your test app visible when sharing a screen.

## Codex

Run the command in PowerShell with your own paths and device serial.

```powershell
codex mcp add glove -- node 'C:\Glove\src\mcp\main.mjs' --adb 'C:\Android\platform-tools\adb.exe' --device '192.168.1.25:37123'
codex mcp list
```

The `codex mcp add` syntax was checked against the installed CLI help. Reopen your session after adding Glove.

## Claude Code

```powershell
claude mcp add --transport stdio glove -- node 'C:\Glove\src\mcp\main.mjs' --adb 'C:\Android\platform-tools\adb.exe' --device '192.168.1.25:37123'
claude mcp get glove
```

Claude Code also shows server status through `/mcp`. See the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server).

## VS Code and other clients

For VS Code, add this server to your workspace `.vscode/mcp.json` and start it from the MCP server controls.

```json
{
  "servers": {
    "glove": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/Glove/src/mcp/main.mjs",
        "--adb", "C:/Android/platform-tools/adb.exe",
        "--device", "192.168.1.25:37123"
      ]
    }
  }
}
```

Other local clients can use the same `node` command and argument array in their stdio server configuration. Use the full path to `node.exe` if the client cannot find it. See the [VS Code MCP setup guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## Tools

- `android_list_devices {}` returns authorized devices. When `--device` is set, the result includes only the selected serial.
- `android_screenshot {}` returns a PNG from the selected device. Available with `--device`.
- `android_tap {x, y}` taps a pixel in the latest screenshot. Available with `--allow-input`.
- `android_swipe {x1, y1, x2, y2, durationMs?}` swipes between two screenshot pixels. Duration is 100 to 1,500 ms, with a default of 300 ms. Available with `--allow-input`.
- `android_back {}` presses Android Back. Available with `--allow-input`.

Tap and swipe require a screenshot captured within the previous 30 seconds. Capture again after each gesture to check the new state before sending another.

The client launches Glove as a local process and exchanges MCP messages through standard input and output. Glove sends ADB commands to the local server at `127.0.0.1:5037`. If you already run an isolated ADB server on another loopback port for testing, pass `--adb-port` with that port number. The tools operate on authorized Android devices. iPhone file sharing and screen viewing are available through the desktop app.

## Check the connection

Start with `android_list_devices` and confirm your selected serial appears. Then capture a screenshot and check that it shows the expected test app. If the list is empty, verify the phone is connected and authorized in Glove, or check whether the device serial changed after reconnecting.

Run the subprocess tests with `node --test test/mcp.test.mjs`. They exercise real stdio messages against a fixture Android runner. An additional check used the official MCP TypeScript SDK 1.32.2 with the Glove server and an authorized Android API 36 emulator. The client listed the emulator, captured a 1080 × 2400 PNG, tapped the fixture app and captured its visible count changing from 0 to 1. Physical phone pairing still needs a handset acceptance run.
