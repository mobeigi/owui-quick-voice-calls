import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT } from './config.js';
import { assertUnelevated, POWERSHELL } from './windows.js';

export async function copyProfile(source, destination) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (source.toLowerCase() === destination.toLowerCase()) throw new Error('Source and destination profiles are the same.');
  if (!(await stat(source)).isDirectory()) throw new Error('Source profile must be a directory.');
  if (await stat(destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  })) throw new Error('Destination already exists. Refusing to merge or overwrite an authenticated profile.');
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = `${destination}.migration-${randomUUID()}`;
  try {
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function assertProfilesClosed(source, destination) {
  if (process.platform !== 'win32') return;
  const result = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $running = @(Get-CimInstance Win32_Process | Where-Object {
      ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -and
      ($_.CommandLine.IndexOf($env:OWUI_QUICK_VOICE_CALLS_SOURCE_PROFILE, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
       $_.CommandLine.IndexOf($env:OWUI_QUICK_VOICE_CALLS_DEST_PROFILE, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
    if ($running.Count -gt 0) { 'running' } else { 'closed' }
  `], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, OWUI_QUICK_VOICE_CALLS_SOURCE_PROFILE: source, OWUI_QUICK_VOICE_CALLS_DEST_PROFILE: destination }
  }).trim();
  if (result !== 'closed') throw new Error('A source/destination browser profile is in use. Exit Open WebUI Quick Voice Calls and close the dedicated browser before migrating.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertUnelevated();
    const config = await loadConfig();
    const source = path.resolve(process.argv[2] || path.join(ROOT, 'browser-profile'));
    assertProfilesClosed(source, config.profileDir);
    await copyProfile(source, config.profileDir);
    console.log(`Profile copied to ${config.profileDir}. Original retained as an ignored backup. Do not publish either profile.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
