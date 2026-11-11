import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, EXAMPLE_CONFIG, assertNodeVersion, expandPath, loadConfig, resolveConfig } from '../src/config.js';
import { encodeBridge, decodeBridge, bridgeValue } from '../src/bridge.js';
import { findAutoHotkey, assertUnelevated } from '../src/windows.js';
import { copyProfile } from '../src/migrate.js';

const defaults = JSON.parse(await readFile(EXAMPLE_CONFIG, 'utf8'));
const env = { LOCALAPPDATA: path.join(ROOT, 'runtime', 'fake-localappdata') };
const resolve = (input = {}) => resolveConfig(defaults, input, path.join(ROOT, 'config.json'), env);

test('Node 24 minimum and version-manager file agree with package metadata', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.engines.node, '>=24');
  assert.equal(lock.packages[''].engines.node, '>=24');
  assert.equal((await readFile(path.join(ROOT, '.node-version'), 'utf8')).trim(), '24');
  assert.throws(() => assertNodeVersion('22.23.4'), /Node.js 24 or newer is required/);
  assert.throws(() => assertNodeVersion('23.0.0'), /Node.js 24 or newer is required/);
  assert.doesNotThrow(() => assertNodeVersion('24.0.0'));
  assert.doesNotThrow(() => assertNodeVersion('26.0.0'));
});

test('example config works without a private config file or live user profile', async () => {
  const config = await loadConfig(EXAMPLE_CONFIG);
  assert.equal(config.hotkey, 'F16');
  assert.equal(config.hotkeyMode, 'uiAccess');
  assert.equal(config.baseUrl, 'https://openwebui.example.com/');
  assert.equal(config.statusPollMs, 50);
});

test('project identity matches package metadata, data directory, and helper filename', async () => {
  const name = 'owui-quick-voice-calls';
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.name, name);
  assert.equal(lock.name, name);
  assert.equal(lock.packages[''].name, name);
  assert.equal(path.basename(resolve().dataDir), name);
  const helper = await readFile(path.join(ROOT, 'OWUIQuickVoiceCalls.ahk'), 'utf8');
  assert.ok(helper.includes('Open WebUI Quick Voice Calls'));
  assert.ok(helper.includes(`\\${name}\\runtime\\bridge.ini`));
});

test('profile and runtime default to LOCALAPPDATA; custom hotkeys and nested options merge', () => {
  const config = resolve({ hotkey: '^!Space', sounds: { enabled: false } });
  assert.equal(config.profileDir, path.join(env.LOCALAPPDATA, 'owui-quick-voice-calls', 'browser-profile'));
  assert.equal(config.bridgePath, path.join(env.LOCALAPPDATA, 'owui-quick-voice-calls', 'runtime', 'bridge.ini'));
  assert.equal(config.hotkey, '^!Space');
  assert.equal(config.sounds.enabled, false);
  assert.equal(config.sounds.errorBeep, true);
  assert.equal(config.sounds.connected, path.join(ROOT, 'sounds', 'connected.wav'));
});

test('relative portable paths resolve consistently; environment variables are case-insensitive', () => {
  const config = resolve({ dataDir: './portable-data', profileDir: 'profile' });
  assert.equal(config.profileDir, path.join(ROOT, 'portable-data', 'profile'));
  assert.equal(expandPath('%localappdata%', env), env.LOCALAPPDATA);
  assert.throws(() => expandPath('%DOES_NOT_EXIST%', {}), /not set/);
});

test('invalid URL, hotkey, enum, unsafe paths, and settings are rejected', () => {
  for (const input of [
    { baseUrl: 'http://voice.test/' }, { baseUrl: 'https://u:p@voice.test/' }, { baseUrl: 'https://voice.test/c/123' },
    { hotkey: 'F16\nother=value' }, { hotkeyMode: 'admin' }, { dataDir: 'bad\npath' },
    { windowMode: 'bogus' }, { sounds: { enabled: 'true' } }, { port: 1 }, { statusPollMs: 20000 }, { statusPollMs: 49 }
  ]) assert.throws(() => resolve(input));
});

test('UTF-16 bridge round-trips non-ASCII paths and configured UI options', () => {
  const config = resolve({ sounds: { connected: 'sounds/接続.wav' }, hotkey: '^!Space' });
  const text = decodeBridge(encodeBridge(config, { token: 'a'.repeat(64), pid: 123 }));
  assert.equal(bridgeValue(text, 'connectedSound'), config.sounds.connected);
  assert.equal(bridgeValue(text, 'hotkey'), '^!Space');
  assert.equal(bridgeValue(text, 'uiAccess'), '1');
  assert.equal(bridgeValue(text, 'statusPollMs'), '50');
  assert.equal(bridgeValue(text, 'token'), 'a'.repeat(64));
  assert.equal(bridgeValue(decodeBridge(Buffer.from('port=1234\n')), 'port'), '1234');
});

test('bridge exports only controller, hotkey, polling, and sound settings', () => {
  const text = decodeBridge(encodeBridge(resolve(), { token: 'a'.repeat(64), pid: 123 }));
  const keys = text.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => line.split('=')[0]);
  assert.deepEqual(keys, [
    'port', 'token', 'pid', 'configFile', 'hotkey', 'uiAccess', 'statusPollMs',
    'sounds', 'errorBeep', 'connectedSound', 'hangupSound'
  ]);
});

test('launcher selects UIAccess runtime explicitly, with no silent administrator fallback', () => {
  const paths = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local' };
  const config = resolve();
  assert.match(findAutoHotkey(config, paths, () => true), /AutoHotkey64_UIA\.exe$/);
  assert.match(findAutoHotkey({ ...config, hotkeyMode: 'standard' }, paths, () => true), /AutoHotkey64\.exe$/);
  assert.throws(() => findAutoHotkey(config, paths, () => false), /UIAccess runtime not found/);
});

test('controller launch rejects elevated tokens and uses Windows system whoami, not PATH', () => {
  for (const sid of ['S-1-16-12288', 'S-1-16-16384']) {
    assert.throws(() => assertUnelevated({ platform: 'win32', run: () => sid }), /not as administrator/);
  }
  assert.doesNotThrow(() => assertUnelevated({ platform: 'win32', run: (executable) => {
    assert.match(executable, /System32[\\/]whoami\.exe$/);
    return 'S-1-16-8192';
  } }));
});

test('profile migration preserves source and refuses to overwrite an existing destination', async (t) => {
  const parent = path.join(ROOT, 'runtime', 'tests');
  await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'migration-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const source = path.join(folder, 'old');
  const destination = path.join(folder, 'new');
  await mkdir(source);
  await writeFile(path.join(source, 'Local State'), 'synthetic test data');
  await copyProfile(source, destination);
  assert.equal(await readFile(path.join(source, 'Local State'), 'utf8'), 'synthetic test data');
  assert.equal(await readFile(path.join(destination, 'Local State'), 'utf8'), 'synthetic test data');
  await assert.rejects(copyProfile(source, destination), /Refusing to merge or overwrite/);
});
