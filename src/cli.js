import { loadConfig } from './config.js';
import { ensure, request } from './control.js';

const action = process.argv[2] || 'status';
if (!['ensure', 'status', 'login', 'toggle', 'stop', 'shutdown', 'paths'].includes(action)) {
  console.error('Usage: node src/cli.js ensure|status|login|toggle|stop|shutdown|paths');
  process.exitCode = 1;
} else {
  try {
    const config = await loadConfig();
    if (action === 'paths') console.log(JSON.stringify({
      configFile: config.configFile, dataDir: config.dataDir,
      profileDir: config.profileDir, runtimeDir: config.runtimeDir,
      hotkey: config.hotkey, hotkeyMode: config.hotkeyMode
    }, null, 2));
    else {
      if (['ensure', 'login', 'toggle'].includes(action)) await ensure(config);
      console.log(await request(config, action === 'ensure' ? 'status' : action));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
