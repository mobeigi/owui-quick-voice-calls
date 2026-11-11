import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const host = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe');
const script = path.join(ROOT, 'LaunchSilent.vbs');

function environmentWithPath(value) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  return { ...env, PATH: value };
}

test('silent launcher uses Node from PATH without launching the app', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(host, ['//B', '//Nologo', script, '--check'], {
    // Project paths resolve against the script, not the caller's working directory.
    cwd: path.dirname(ROOT.replace(/[\\/]$/, '')), windowsHide: true, timeout: 10000,
    env: environmentWithPath(path.dirname(process.execPath)), encoding: 'utf8'
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('silent launcher fails when Node is absent from PATH instead of searching version managers', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(host, ['//B', '//Nologo', script, '--check'], {
    cwd: ROOT, windowsHide: true, timeout: 10000,
    env: environmentWithPath(path.join(ROOT, 'does-not-exist')), encoding: 'utf8'
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
});
