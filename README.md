<div align="center">
  <img src="https://i.imgur.com/00GKkWY.png" height="110px" width="auto" alt="Open WebUI Quick Voice Calls"/>
  <br/>
  <h3 align="center">Open WebUI Quick Voice Calls</h3>
  <p align="center">Quick, temporary Open WebUI voice calls at the press of a hotkey.</p>
  <h2></h2>
  <br />

  [![Issues][issues-badge]][issues-link]
  [![Pull Requests][pulls-badge]][pulls-link]
  [![Licence][license-badge]][license-link]
</div>

## Description

Open WebUI Quick Voice Calls is a Windows hotkey helper for quick, temporary
Realtime conversations with your existing [Open WebUI](https://github.com/open-webui/open-webui)
instance. It uses AutoHotkey v2, Node.js, Playwright, and an authenticated browser
profile separate from your everyday Chrome profile.

Default controls: **F16** starts/ends a call. The dedicated browser stays headless
and preloads the next temporary chat between calls, with no active microphone or
Realtime connection while in standby.

## Requirements

- Windows, Node.js **24+**, and Google Chrome (or Microsoft Edge via configuration).
- AutoHotkey **v2**. For elevated-window support, install its **UIAccess** runtime
  in a Windows trusted installation directory, normally `Program Files`.
- An HTTPS Open WebUI instance with a working default model, temporary-chat access,
  and Realtime calls configured. The shipped UI selectors target the English
  Open WebUI 0.13.1 interface; other versions may need selector updates.
- Windows desktop microphone access and working recording/playback devices.

## Instructions

Run the launcher as your **normal Windows user**, not as administrator.

Clone the repository and open a terminal in the project directory:

```powershell
git clone https://github.com/mobeigi/owui-quick-voice-calls.git
cd owui-quick-voice-calls
```

The repository includes [`.node-version`](.node-version) selecting Node 24. If you
use fnm, select the project version before installing dependencies:

```powershell
fnm install
fnm use
```

fnm can select it automatically on directory changes when its shell integration
is configured with `--use-on-cd`. Other managers that support `.node-version` can
read the same file. This does not change Explorer's PATH: all launchers require
Node 24+ on PATH, or can be run from the configured terminal.

```powershell
npm install
Copy-Item config.example.json config.json
```

1. Edit **`config.json`** and set `baseUrl` to your own Open WebUI HTTPS root URL.
   The example's `https://openwebui.example.com/` is a placeholder.
2. Double-click **`Login.cmd`**. Sign in yourself, including MFA, in the dedicated
   visible browser. Verify your default model and voice settings. No password is
   requested or stored by the helper.
3. Close the setup browser. Your login remains in the dedicated profile.
4. Double-click **`Launch.cmd`**. It starts the normal-user controller, then the
   UIAccess hotkey helper silently. Hover its tray icon to check standby status.
5. Press **F16**, wait for the connected sound, then speak. Press it again to stop
   audio, hang up, discard the conversation tab, and prepare a new temporary chat.

The launchers no longer run `npm install` automatically. If dependencies are
missing, install them explicitly as a normal user. Installed Chrome/Edge does not
require downloading Playwright's bundled browser.

### Silent Launch and Windows Startup

Double-click **[`LaunchSilent.vbs`](LaunchSilent.vbs)** to start without a console
window flashing on screen. It runs the same Node launcher as `Launch.cmd`, keeps
the tray icon available, and only shows a dialog if startup fails. Use it as your
regular launcher or from the Windows Startup folder.

The script uses `node.exe` from PATH and verifies it is Node 24 or newer. It does
not search version-manager installations, select versions, or accept a custom
Node-path override. Configure Node on your user/system PATH so that Explorer and
startup shortcuts can find it; shell-only version-manager initialisation is not
run automatically at sign-in. No username or installed version path is hardcoded.

To launch automatically when you sign in:

1. Press **Win + R**, enter `shell:startup`, and create a shortcut in that folder.
2. Use this target, replacing the project location with your own:

   ```text
   wscript.exe "C:\path\to\owui-quick-voice-calls\LaunchSilent.vbs"
   ```

3. Leave **Run as administrator** unchecked. The launcher uses the script's own
   directory, so a shortcut does not need a custom **Start in** value.

Use `wscript.exe`, not the console-based `cscript.exe`. Windows Script Host and its
VBScript component must be enabled. Setup/login windows and genuine AHK error
dialogs can still appear. Delete the Startup shortcut to disable automatic startup;
the script does not create a shortcut or scheduled task itself.

## Configuration

**[`config.example.json`](config.example.json)** is the shareable default/template. **`config.json`** is
your private override file and is gitignored. Unspecified settings inherit the
example's defaults, including nested sound and selector options.

Set **`OWUI_QUICK_VOICE_CALLS_CONFIG`** to the path of a different JSON file if desired. Both the
CLI and launcher use it, and the controller passes the resolved settings to AHK;
there is no second AHK configuration file to maintain. Configuration changes take
effect after **tray → Exit**, then relaunching.

| Setting | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | Placeholder HTTPS URL | Your Open WebUI origin root, without credentials, query, or a subpath |
| `hotkey` | `F16` | AHK key name, optionally with modifiers, e.g. `^!Space` for Ctrl+Alt+Space |
| `hotkeyMode` | `uiAccess` | `uiAccess` for elevated-window compatibility; `standard` for ordinary AHK |
| `autoHotkeyPath` | Empty | Optional full path to the matching AHK v2 runtime |
| `dataDir` | `%LOCALAPPDATA%\owui-quick-voice-calls` | Private application-data root |
| `profileDir` | `browser-profile` | Relative to `dataDir`, or an absolute/environment-expanded path |
| `browserChannel` | `chrome` | `chrome`, `msedge`, or empty for installed Playwright Chromium |
| `windowMode` | `headless` | `headless`, `visible`, or `minimized` |
| `warmStandby` | `true` | Keep the browser and next temporary tab ready between calls |
| `standbyMinimized` | `true` | Minimise standby windows in headed mode |
| `standbyRefreshMs` | `600000` | Replace idle standby every ten minutes |
| `port` | `17361` | Authenticated loopback control port |
| `startupTimeoutMs` | `60000` | Call/standby startup timeout |
| `loginTimeoutMs` | `300000` | Manual sign-in deadline when login is detected |
| `stopTimeoutMs` | `750` | Graceful-stop budget; also bounds individual tab teardown operations |
| `statusPollMs` | `50` | AHK status/heartbeat interval, 50–1000 ms; faster sound feedback at the cost of more local requests |
| `sounds.enabled` | `true` | Enable call sounds and error beeps |
| `sounds.connected`, `sounds.hangup` | `sounds/*.wav` | Asynchronous WAV sound paths |
| `sounds.errorBeep` | `true` | Enable the separate error beep |
| `selectors` | English Open WebUI selectors | Confirmation dialog and Realtime controls |

AHK modifiers are `^` Ctrl, `!` Alt, `+` Shift, and `#` Win. The supported config
format is a named key with optional modifiers, not arbitrary AHK code or custom
two-key combinations. Hotkeys already used by other applications can conflict.

Relative `dataDir`, sound paths, and `autoHotkeyPath` resolve against the config
file's directory. `profileDir` resolves against `dataDir`. Paths support `%VAR%`
environment expansion, including `%LOCALAPPDATA%`; escape backslashes in JSON.
For portable operation, set `dataDir` to `./private-data` and add that directory to
your own ignore rules. Independent installations/configurations need distinct
`dataDir` values and ports if running simultaneously.

## Private Data and Migration

The default layout is:

```text
owui-quick-voice-calls/
  config.example.json       # shareable template
  config.json               # private settings; gitignored
  src/, test/, sounds/

%LOCALAPPDATA%/owui-quick-voice-calls/
  browser-profile/           # cookies, login state, site settings and cache
  runtime/
    bridge.ini              # private controller token + resolved helper settings
    controller.log          # state and numeric latency diagnostics only
```

`%LOCALAPPDATA%` is the normal Windows location for this non-roaming data. It is
not a credential vault: protection depends on the Windows user's folder ACLs, and
other software running as that user may access it. **Never publish the profile or
runtime directory.** Windows browser credentials may be tied to the user/machine;
copying a profile to someone else's computer is not a supported sign-in method.

To migrate the earlier project-local `browser-profile/`:

1. Exit the helper and close its dedicated browser.
2. Set `dataDir`/`profileDir` in your private config.
3. Run **`npm run migrate-profile`**.
4. Launch and verify authentication. The migration copies the whole profile,
   including `Local State`, and retains the original as an ignored backup. It
   refuses to merge/overwrite an existing destination or copy an in-use browser
   profile. Sign in again if browser authentication policy requires it.

An optional source path can be supplied as `node src/migrate.js "D:\old-profile"`.
You can skip migration and use `Login.cmd` to sign in to a newly created profile.
Legacy project-local profile/runtime files remain ignored; do not upload an entire
working folder as a ZIP just because it has a `.gitignore`.

## Elevated-Window Hotkeys

The launcher uses the installed **`AutoHotkey64_UIA.exe`** in UIAccess mode. AHK
checks its actual Windows token and refuses to silently run without UIAccess when
it was requested. Normal key names use AHK's registered-hotkey mechanism; the
UIAccess keyboard hook tracks release across elevated applications.

Only the hotkey helper has UIAccess. **Node and Chrome are not run as
administrator**, and both the launcher and controller reject high-integrity
execution. The AHK helper does not spawn Node/Chrome; it only sends authenticated
loopback control requests. No scheduled task, Windows service, or automatic
administrator elevation is installed.

If UIAccess cannot activate, install the signed AHK runtime in a trusted location,
or explicitly choose `hotkeyMode: "standard"` (elevated-window behaviour is then
not guaranteed). Merely renaming/moving a normal AHK executable does not enable
UIAccess. If keyboard software generates the hotkey, it must also be able to emit
that key while an elevated application is focused; UIAccess cannot repair events
blocked in an upstream remapper. The UAC secure desktop is not supported.

## Controls and Sounds

| Control | Action |
| --- | --- |
| Configured hotkey in standby | Confirm the prepared call and connect |
| Hotkey during background warm-up | Request a call once the fresh tab is ready |
| Hotkey while starting | Cancel activation and rebuild standby |
| Hotkey during a call | Cut local audio, hang up, replace the conversation tab |
| Open WebUI mute/unmute | Mute this call; reflected in helper status |
| Tray → Start/End Call | Start a call or end the current session and return to standby |
| Tray → Setup (Login) | Open visible setup; retains authentication |
| Tray → Exit | End the session and close the dedicated browser/controller |

No global mute hotkey or on-screen status window is installed. Routine startup and
standby are silent; status is available by hovering the tray icon or running
`npm run status`. Call sounds and error notifications remain enabled by default.

[`sounds/connected.wav`](sounds/connected.wav) and [`sounds/hangup.wav`](sounds/hangup.wav)
play asynchronously through AHK. Connected sounds only after Realtime and the
microphone are ready; hang-up sounds after local microphone/playback shutdown is
verified, not after the next standby finishes loading. Missing/unplayable WAVs
fall back to short beeps. FFmpeg is not needed at runtime.

## Session Behaviour and Privacy

- Each conversation uses `/?temporary-chat=true&call=true`. The helper verifies
  temporary mode before confirming only the specific microphone-call dialog.
- Warm standby is unconfirmed. The media wrapper rejects capture until activation
  and stops acquisitions that finish after cancellation. Standby is checked for
  zero microphone tracks and zero Realtime sockets before being marked ready.
- Start requires the Realtime UI to report connected/listening or speaking, a live
  microphone track, and a running Web Audio context. It does not change your model
  or Realtime settings or silently fall back to Standard call mode.
- Confirmation is dispatched directly inside the verified call dialog, without
  visual click/animation-frame waits. Temporary mode and idle microphone state
  are rechecked in the same page task before arming capture. Disabled/unmounted
  controls still receive a short timer-based retry; ambiguous controls fail closed.
- Mutating requests to the site's `/api/v1/chats/...` endpoints are blocked during
  calls and standby, not during manual setup. Changed temporary mode or navigation
  away from the temporary root ends the session. The expanded call view can hide
  the navbar; that alone does not mean temporary mode was disabled.
- Stop cuts microphone input and playback, dispatches explicit hang-up without
  visual click/actionability waits, and verifies audio-off using timer polling.
  Bounded fallback closes the conversation tab. Fresh tabs prevent reusing the
  previous conversation's session storage, while the profile retains sign-in.
- If AHK disappears, its missing heartbeat shuts down the controller after about
  12–14 seconds. Abrupt OS/process failure is not guaranteed to hang up gracefully.
- Headless login expiry requires visible setup. `Login.cmd`/tray setup always open
  visibly. Headed launch/tab replacement can affect focus; neither headed mode
  guarantees focus-free operation in every game.

Temporary mode is intended to avoid saved Open WebUI history, **not** guarantee
zero server/provider retention. Chrome's profile may contain tokens, site storage,
cache, and browser history. No audio, transcripts, passwords, tokens, page HTML, or
websocket payloads are written to the helper's log. It records state/error messages
and numeric connection/shutdown timings only.

## Command Line and Tests

```powershell
npm run launch             # controller + configured AHK runtime
npm run login              # visible setup; controller starts if needed
npm start                  # controller/standby only, no global hotkey
npm run paths              # resolved config/profile/runtime paths
npm run status             # state, startup/shutdown latency, helper UIAccess status
npm run toggle
npm run stop
npm run shutdown           # stops controller; exit tray helper as well before restarting
npm run migrate-profile
npm test
npm run check
```

Use `Launch.cmd`/`npm run launch` rather than double-clicking `OWUIQuickVoiceCalls.ahk`: the
launcher starts the non-elevated controller and supplies resolved settings first.
If Node is managed by a shell-specific version manager, launch from a terminal in
which `node --version` works.

Tests use the example config and isolated, synthetic UI profiles in real Chrome,
never your private config/login or remote Realtime service. They cover session
races, temporary/history safeguards, warm browser reuse, headless shutdown,
configuration/path resolution, Unicode bridge settings, runtime selection, and
safe profile copying. They do not establish physical microphone/speaker quality,
provider retention, or behaviour in every elevated app/game. Verify those on the
target machine, including hotkey down/up with an elevated window focused.

## Troubleshooting

- **No hotkey:** check the tray icon, conflicting hotkeys, and whether your keyboard
  actually emits the configured key. Try the tray toggle to separate key problems
  from call problems. For elevated windows, check `helperUiAccess=1` in status.
- **Profile in use:** close only the dedicated helper browser/other helpers using
  that profile. Never point the helper at your normal Chrome profile.
- **Temporary-mode verification fails:** check account permissions and selectors.
  The helper intentionally does not fall back to saving the conversation.
- **Startup timeout/no audio:** try visible mode, English UI, one working default
  model, Windows desktop microphone permission, and correct default audio devices.
- **Controller offline:** restart via `Launch.cmd`; inspect the resolved runtime
  log from `npm run paths`. A stale bridge is replaced when the controller starts.

Transcripts, screenshots, mixer branding, and a native audio client are not
implemented. No installer/startup task is created automatically.

If you encounter a reproducible problem, [open an issue](../../issues) with your
Windows, Node.js, browser, and Open WebUI versions, plus any relevant sanitised
error messages. Do not include login profiles, controller tokens, or private
configuration files.

## Contributions

Contributions are always welcome!
Just make a [pull request](../../pulls).

## Licence

Open WebUI Quick Voice Calls is licensed under the
[GNU General Public License v3.0 (GPL-3.0)](LICENSE).

<!-- Variables -->
[issues-badge]: https://img.shields.io/github/issues/mobeigi/owui-quick-voice-calls.svg?style=flat-square
[issues-link]: ../../issues

[pulls-badge]: https://img.shields.io/github/issues-pr/mobeigi/owui-quick-voice-calls.svg?style=flat-square
[pulls-link]: ../../pulls

[license-badge]: https://img.shields.io/github/license/mobeigi/owui-quick-voice-calls.svg?style=flat-square
[license-link]: LICENSE
