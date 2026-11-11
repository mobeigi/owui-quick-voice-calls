import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function assertUnelevated({ platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'win32') return;
  const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  const groups = run(whoami, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  if (/S-1-16-(12288|16384|20480)/.test(groups)) {
    throw new Error('Run Open WebUI Quick Voice Calls as your normal Windows user, not as administrator. Only the hotkey helper uses UIAccess; Node and Chrome must remain non-elevated.');
  }
}

export function findAutoHotkey(config, env = process.env, exists = existsSync) {
  if (config.autoHotkeyPath) {
    if (!exists(config.autoHotkeyPath)) throw new Error('Configured autoHotkeyPath does not exist.');
    return config.autoHotkeyPath;
  }
  const filename = config.hotkeyMode === 'uiAccess' ? 'AutoHotkey64_UIA.exe' : 'AutoHotkey64.exe';
  const candidates = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'AutoHotkey', 'v2', filename),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'AutoHotkey', 'v2', filename)
  ].filter(Boolean);
  const found = candidates.find(exists);
  if (!found) throw new Error(config.hotkeyMode === 'uiAccess'
    ? 'AutoHotkey v2 UIAccess runtime not found. Install AutoHotkey v2 with UIAccess support in Program Files, set autoHotkeyPath, or explicitly choose hotkeyMode: standard.'
    : 'AutoHotkey v2 not found. Install it or set autoHotkeyPath in config.json.');
  return found;
}

export function launchHotkey(runtime, script, config) {
  // ShellExecute activates signed UIAccess programs without elevating the caller.
  // Fixed PowerShell code + environment arguments avoid interpreting config as code.
  const command = `
    $ErrorActionPreference = 'Stop'
    $arguments = '"{0}" --bridge "{1}"' -f $env:OWUI_QUICK_VOICE_CALLS_SCRIPT, $env:OWUI_QUICK_VOICE_CALLS_BRIDGE
    $process = Start-Process -FilePath $env:OWUI_QUICK_VOICE_CALLS_RUNTIME -ArgumentList $arguments -WorkingDirectory $env:OWUI_QUICK_VOICE_CALLS_CWD -PassThru
    $process.Id
  `;
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, OWUI_QUICK_VOICE_CALLS_SCRIPT: script, OWUI_QUICK_VOICE_CALLS_BRIDGE: config.bridgePath,
      OWUI_QUICK_VOICE_CALLS_RUNTIME: runtime, OWUI_QUICK_VOICE_CALLS_CWD: path.dirname(script) }
  }).trim();
}
