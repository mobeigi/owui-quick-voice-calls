import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Session } from '../src/session.js';

function mockBrowser({ fail = false, slow = false } = {}) {
  let finish;
  let stopped;
  const reset = () => { stopped = new Promise((resolve) => { finish = resolve; }); };
  reset();
  return {
    closeCount: 0,
    endCount: 0,
    startCount: 0,
    async prepare({ signal }) {
      if (slow) await delay(10000, undefined, { signal });
      if (fail) throw Object.assign(new Error('secret browser details'), { publicMessage: 'Safe error' });
    },
    async open(options) { await this.prepare(options); },
    async startCall() {
      this.startCount += 1;
      this.endTask = null;
      reset();
      return { prepareMs: 0, confirmMs: 0, connectMs: 1, totalMs: 1 };
    },
    async monitor(signal, onMute) {
      onMute(false);
      if (signal.aborted) return;
      await Promise.race([stopped, new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))]);
    },
    async waitForClose() { await stopped; },
    endCall({ onAudioStopped = () => {} } = {}) {
      if (!this.endTask) this.endTask = Promise.resolve().then(() => {
        this.endCount += 1;
        onAudioStopped({ audioStopMs: 1 });
        finish();
        return { audioStopMs: 1, totalMs: 2 };
      });
      return this.endTask;
    },
    async close() { this.closeCount += 1; this.closed = true; finish(); }
  };
}

function coldSession(createBrowser) {
  return new Session(createBrowser, () => {}, { warmStandby: false });
}

test('toggle starts, stop releases owned browser, next call creates new browser', async () => {
  const browsers = [];
  const session = coldSession(() => {
    const browser = mockBrowser();
    browsers.push(browser);
    return browser;
  });
  session.toggle();
  await delay(0);
  assert.equal(session.state, 'active');
  await session.toggle();
  assert.equal(session.state, 'idle');
  assert.ok(browsers[0].closeCount);
  session.toggle();
  await delay(0);
  assert.equal(browsers.length, 2);
  assert.equal(session.generation, 2);
  await session.stop();
});

test('stop cuts audio without waiting for a pending monitor check or standby preparation', async () => {
  const browser = mockBrowser();
  let releaseMonitor;
  browser.monitor = async () => new Promise((resolve) => { releaseMonitor = resolve; });
  const session = new Session(() => browser);
  session.toggle();
  await delay(0);
  assert.equal(session.state, 'active');
  const stopping = session.stop();
  await delay(0);
  assert.equal(session.ended, 1);
  assert.equal(session.snapshot().endLatencyMs, 1);
  assert.equal(session.state, 'stopping');
  assert.equal(browser.endCount, 1);
  releaseMonitor();
  await stopping;
  await session.task;
  assert.equal(session.state, 'standby');
  assert.equal(session.ended, 1);
  await session.shutdown();
});

test('second press during startup cancels without opening another browser', async () => {
  let count = 0;
  const session = coldSession(() => { count += 1; return mockBrowser({ slow: true }); });
  session.toggle();
  await delay(0);
  await session.toggle();
  assert.equal(count, 1);
  assert.equal(session.state, 'idle');
});

test('repeated stop presses do not queue another activation', async () => {
  let count = 0;
  const session = coldSession(() => { count += 1; return mockBrowser({ slow: true }); });
  session.toggle();
  await delay(0);
  await Promise.all([session.toggle(), session.toggle(), session.stop()]);
  assert.equal(count, 1);
  assert.equal(session.state, 'idle');
});

test('canceling before the scheduled start avoids launching any browser', async () => {
  let count = 0;
  const session = coldSession(() => { count += 1; return mockBrowser(); });
  session.toggle();
  await session.toggle();
  assert.equal(count, 0);
  assert.equal(session.state, 'idle');
});

test('failure closes browser and surfaces only safe error', async () => {
  const browser = mockBrowser({ fail: true });
  const session = coldSession(() => browser);
  session.toggle();
  await session.task;
  assert.equal(session.state, 'error');
  assert.equal(session.message, 'Safe error');
  assert.ok(browser.closeCount);
});

test('ambiguous selectors get a useful error without exposing page contents', async () => {
  const browser = mockBrowser();
  browser.prepare = async () => { throw new Error('locator.isVisible: strict mode violation: sensitive page contents'); };
  const session = coldSession(() => browser);
  session.toggle();
  await session.task;
  assert.equal(session.state, 'error');
  assert.match(session.message, /Multiple Open WebUI controls/);
  assert.ok(!session.message.includes('sensitive'));
});

test('login owns profile until setup is closed; cannot overlap calls', async () => {
  let count = 0;
  const session = coldSession(() => { count += 1; return mockBrowser(); });
  assert.equal(session.login(), true);
  await delay(0);
  assert.equal(session.state, 'setup');
  assert.equal(session.login(), false);
  await session.toggle();
  assert.equal(count, 1);
  assert.equal(session.state, 'idle');
});

test('warm standby reuses browser, retires each call, and reports latency/call counters', async () => {
  const browsers = [];
  const timings = [];
  const session = new Session(() => {
    const browser = mockBrowser();
    browsers.push(browser);
    return browser;
  }, () => {}, { onTiming: (timing) => timings.push(timing) });
  session.warm();
  await session.task;
  assert.equal(session.state, 'standby');
  assert.equal(browsers[0].startCount, 0);
  session.toggle();
  await delay(0);
  assert.equal(session.state, 'active');
  await session.toggle();
  await session.task;
  assert.equal(session.state, 'standby');
  assert.equal(browsers.length, 1);
  assert.equal(browsers[0].endCount, 1);
  assert.equal(browsers[0].closeCount, 0);
  assert.equal(session.started, 1);
  assert.equal(session.ended, 1);
  assert.equal(session.snapshot().latencyMs, 1);
  session.toggle();
  await delay(0);
  assert.equal(browsers[0].startCount, 2);
  await session.shutdown();
  assert.equal(session.state, 'idle');
  assert.equal(session.browser, null);
  assert.equal(session.task, null);
  assert.equal(browsers[0].closeCount, 1);
  assert.equal(session.started, session.ended);
  assert.equal(timings.length, 2);
});

test('first F16 during background warm-up requests a call; second cancels it', async () => {
  const browsers = [];
  const session = new Session(() => {
    const browser = mockBrowser({ slow: true });
    browsers.push(browser);
    return browser;
  });
  session.warm();
  await delay(0);
  session.toggle();
  assert.equal(session.state, 'starting');
  await session.toggle();
  await session.shutdown();
  assert.equal(session.started, 0);
  assert.ok(browsers.every((browser) => browser.startCount === 0));
  assert.equal(session.state, 'idle');
});

test('login from standby releases the warm profile before opening visible setup', async () => {
  const browsers = [];
  const session = new Session(() => {
    const browser = mockBrowser();
    browsers.push(browser);
    return browser;
  });
  session.warm();
  await session.task;
  assert.equal(session.login(), true);
  await delay(0);
  assert.equal(session.state, 'setup');
  assert.equal(browsers[0].closed, true);
  assert.equal(browsers.length, 2);
  await session.shutdown();
});

test('status labels use the configured hotkey instead of a hardcoded key', async () => {
  const session = new Session(() => mockBrowser(), () => {}, { hotkey: '^!Space' });
  assert.match(session.message, /\^!Space/);
  session.warm();
  await session.task;
  assert.match(session.message, /\^!Space/);
  session.toggle();
  await delay(0);
  assert.match(session.message, /\^!Space/);
  await session.shutdown();
});
