import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, ROOT } from './config.js';
import { ensure, request } from './control.js';
import { assertUnelevated, findAutoHotkey, launchHotkey } from './windows.js';

try {
  assertUnelevated();
  const config = await loadConfig();
  const runtime = findAutoHotkey(config);
  await ensure(config);
  launchHotkey(runtime, path.join(ROOT, 'OWUIQuickVoiceCalls.ahk'), config);
  let attached = false;
  for (let i = 0; i < 40; i += 1) {
    await delay(250);
    const status = await request(config).catch(() => '');
    if (/^helperAttached=1$/m.test(status) && (config.hotkeyMode !== 'uiAccess' || /^helperUiAccess=1$/m.test(status))) {
      attached = true;
      break;
    }
  }
  if (!attached) throw new Error('Hotkey helper did not attach. Check its error window. UIAccess requires a correctly signed AutoHotkey runtime in a Windows trusted installation directory.');
  if (process.argv.includes('--login')) await request(config, 'login');
  console.log(`Open WebUI Quick Voice Calls running: ${config.hotkey} (${config.hotkeyMode}). Profile: ${config.profileDir}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
