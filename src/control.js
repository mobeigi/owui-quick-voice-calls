import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { ROOT } from './config.js';
import { decodeBridge, bridgeValue } from './bridge.js';
import { assertUnelevated } from './windows.js';

export async function request(config, action = 'status') {
  const bridge = decodeBridge(await readFile(config.bridgePath));
  const port = bridgeValue(bridge, 'port');
  const token = bridgeValue(bridge, 'token');
  const owner = bridgeValue(bridge, 'configFile');
  if (owner?.toLowerCase() !== config.configFile.toLowerCase()) throw new Error('This dataDir is in use by another config file. Use a different dataDir and port.');
  if (!/^\d+$/.test(port || '') || !/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Controller credentials unavailable.');
  const response = await fetch(`http://127.0.0.1:${port}/${action}`, {
    method: action === 'status' ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(response.status === 409 ? text.trim() : 'Controller request failed.');
  return text;
}

export async function ensure(config) {
  assertUnelevated();
  try { return await request(config); } catch { /* Start the normal-user controller. */ }
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.js')], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, OWUI_QUICK_VOICE_CALLS_CONFIG: config.configFile }
  });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  child.unref();
  for (let i = 0; i < 40; i += 1) {
    if (spawnError) break;
    await delay(200);
    try { return await request(config); } catch { /* Bounded service-start wait. */ }
  }
  throw new Error(`Controller did not start. Check your config, port ${config.port}, and ${path.join(config.runtimeDir, 'controller.log')}.`);
}
