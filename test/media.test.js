import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installMediaProbe } from '../src/browser.js';

test('standby blocks capture and cancels a late acquisition even if the next call is armed', async () => {
  let requests = 0;
  let resolveCapture;
  let stopped = false;
  const track = {
    kind: 'audio', readyState: 'live', enabled: true,
    stop() { stopped = true; this.readyState = 'ended'; }
  };
  const sandbox = {
    window: {}, DOMException,
    navigator: { mediaDevices: {
      getUserMedia() {
        requests += 1;
        return new Promise((resolve) => { resolveCapture = resolve; });
      }
    } }
  };
  vm.runInNewContext(`(${installMediaProbe.toString()})()`, sandbox);
  const media = sandbox.window.__owuiQuickVoiceCallsMedia;
  await assert.rejects(sandbox.navigator.mediaDevices.getUserMedia({ audio: true }), { name: 'NotAllowedError' });
  assert.equal(requests, 0);
  media.arm();
  const pending = sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
  media.stop();
  media.arm();
  resolveCapture({ getTracks: () => [track] });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stopped, true);
  assert.equal(media.status().liveAudioTracks, 0);
});

test('quiesce stops microphone, media elements, and synthesis while suspending output', async () => {
  let captureStopped = false;
  let paused = false;
  let canceled = false;
  let suspended = false;
  const track = { kind: 'audio', readyState: 'live', enabled: true,
    stop() { captureStopped = true; this.readyState = 'ended'; } };
  const element = { muted: false, paused: false, pause() { paused = true; this.paused = true; } };
  const synthesis = { speaking: true, cancel() { canceled = true; this.speaking = false; } };
  class AudioContext {
    state = 'running';
    async suspend() { suspended = true; this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
  }
  const sandbox = { DOMException, window: {
    AudioContext, document: { querySelectorAll: () => [element] }, speechSynthesis: synthesis
  }, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } } };
  vm.runInNewContext(`(${installMediaProbe.toString()})({allowCapture: true})`, sandbox);
  await sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
  new sandbox.window.AudioContext();
  const media = sandbox.window.__owuiQuickVoiceCallsMedia;
  media.quiesce();
  assert.equal(captureStopped, true);
  assert.equal(paused, true);
  assert.equal(element.muted, true);
  assert.equal(canceled, true);
  assert.equal(suspended, true);
  assert.equal(media.status().liveAudioTracks, 0);
  assert.equal(media.status().runningContexts, 0);
  assert.equal(media.status().playingMediaElements, 0);
  assert.equal(media.status().speaking, false);
  await assert.rejects(sandbox.navigator.mediaDevices.getUserMedia({ audio: true }), { name: 'NotAllowedError' });
});
