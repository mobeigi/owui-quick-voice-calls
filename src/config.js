import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const EXAMPLE_CONFIG = path.join(ROOT, 'config.example.json');

export function assertNodeVersion(version = process.versions.node) {
  const major = Number(version.split('.')[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`Node.js 24 or newer is required (running ${version}). Select the project's .node-version with your version manager, then launch again.`);
  }
}

export function expandPath(value, env = process.env) {
  if (typeof value !== 'string' || !value || /[\r\n\0"]/.test(value)) {
    throw new Error('Paths must be non-empty strings without quotes or line breaks.');
  }
  return value.replace(/%([^%]+)%/g, (_, name) => {
    const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (!key || !env[key]) throw new Error(`Environment variable %${name}% is not set.`);
    return env[key];
  });
}

export function resolveConfig(defaults, input, configFile, env = process.env) {
  const config = {
    ...defaults, ...input,
    selectors: { ...defaults.selectors, ...input.selectors },
    sounds: { ...defaults.sounds, ...input.sounds }
  };
  let url;
  try { url = new URL(config.baseUrl); } catch { throw new Error('baseUrl must be a valid HTTPS site root.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('baseUrl must be an HTTPS site root without credentials or query parameters.');
  }
  if (!['visible', 'minimized', 'headless'].includes(config.windowMode)) {
    throw new Error('windowMode must be visible, minimized, or headless.');
  }
  if (!['chrome', 'msedge', ''].includes(config.browserChannel)) throw new Error('browserChannel must be chrome, msedge, or empty (bundled Chromium).');
  if (!['uiAccess', 'standard'].includes(config.hotkeyMode)) throw new Error('hotkeyMode must be uiAccess or standard.');
  if (typeof config.hotkey !== 'string' || !/^[!^+#<>]*[A-Za-z0-9]+$/.test(config.hotkey) || config.hotkey.length > 64) {
    throw new Error('hotkey must be an AHK key name with optional modifiers, such as F16 or ^!Space.');
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('port must be between 1024 and 65535.');
  for (const key of ['startupTimeoutMs', 'loginTimeoutMs', 'stopTimeoutMs']) {
    if (!Number.isFinite(config[key]) || config[key] < 100 || config[key] > 600000) throw new Error(`${key} must be between 100 and 600000.`);
  }
  for (const [name, value] of Object.entries({
    warmStandby: config.warmStandby, standbyMinimized: config.standbyMinimized,
    'sounds.enabled': config.sounds.enabled, 'sounds.errorBeep': config.sounds.errorBeep
  })) {
    if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  }
  if (!Number.isInteger(config.standbyRefreshMs) || config.standbyRefreshMs < 30000 || config.standbyRefreshMs > 86400000) {
    throw new Error('standbyRefreshMs must be between 30000 and 86400000.');
  }
  if (!Number.isInteger(config.statusPollMs) || config.statusPollMs < 50 || config.statusPollMs > 1000) {
    throw new Error('statusPollMs must be between 50 and 1000.');
  }
  for (const value of Object.values(config.selectors)) {
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error('selectors must be non-empty, single-line strings.');
  }
  const configDir = path.dirname(path.resolve(configFile));
  const resolve = (value, base) => path.resolve(base, expandPath(value, env));
  const dataDir = resolve(config.dataDir, configDir);
  return {
    ...config, baseUrl: url.href, configFile: path.resolve(configFile), dataDir,
    profileDir: resolve(config.profileDir, dataDir),
    runtimeDir: path.join(dataDir, 'runtime'),
    bridgePath: path.join(dataDir, 'runtime', 'bridge.ini'),
    autoHotkeyPath: config.autoHotkeyPath ? resolve(config.autoHotkeyPath, configDir) : '',
    sounds: {
      ...config.sounds,
      connected: resolve(config.sounds.connected, configDir),
      hangup: resolve(config.sounds.hangup, configDir)
    }
  };
}

export async function loadConfig(file = process.env.OWUI_QUICK_VOICE_CALLS_CONFIG || path.join(ROOT, 'config.json')) {
  assertNodeVersion();
  const configFile = path.resolve(expandPath(file));
  let input;
  try { input = JSON.parse(await readFile(configFile, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Configuration missing. Copy config.example.json to config.json and set baseUrl before launching.');
    throw new Error('Cannot read configuration. Check that your config file contains valid JSON.');
  }
  const defaults = JSON.parse(await readFile(EXAMPLE_CONFIG, 'utf8'));
  return resolveConfig(defaults, input, configFile);
}
