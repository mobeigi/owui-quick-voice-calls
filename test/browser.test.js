import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { VoiceBrowser, callUrl, isHistoryWrite } from '../src/browser.js';
import { loadConfig, ROOT, EXAMPLE_CONFIG } from '../src/config.js';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

test('activation URL always targets a fresh temporary root chat', () => {
  assert.equal(callUrl('https://voice.test/'), 'https://voice.test/?temporary-chat=true&call=true');
});

test('history write guard is origin scoped and allows reads', () => {
  const origin = 'https://voice.test';
  assert.equal(isHistoryWrite(`${origin}/api/v1/chats/new`, 'POST', origin), true);
  assert.equal(isHistoryWrite(`${origin}/api/v1/chats/123`, 'POST', origin), true);
  assert.equal(isHistoryWrite(`${origin}/api/v1/chats/`, 'GET', origin), false);
  assert.equal(isHistoryWrite(`${origin}/api/v1/audio/realtime`, 'POST', origin), false);
  assert.equal(isHistoryWrite('https://example.com/api/v1/chats/new', 'POST', origin), false);
});

// These are UI automation fixtures, NOT evidence of real microphone/speaker operation.
function fixture({ temporary = true, hideTemporaryOnConnect = false } = {}) {
  return `<!doctype html><html><body>
    <button id="temporary-chat-button"><svg><path d="${temporary ? 'M8 12L11 15L16 10' : 'other'}"></path></svg></button>
    <div role="dialog" aria-label="Unrelated confirmation"><button>Confirm</button></div>
    <div role="dialog" aria-label="Open link" id="call-dialog">
      <p>Start a voice call using your microphone?</p><button id="confirm">Confirm</button>
    </div>
    <nav><button id="toolbar-end">End call</button></nav>
    <section class="bridge-call" hidden>
      <p class="status-label">Listening</p><button id="end">End call</button>
    </section>
    <script>
      window.confirmed = false; window.ended = false; window.toolbarEndClicked = false;
      document.querySelector('#toolbar-end').onclick = () => { window.toolbarEndClicked = true; };
      document.querySelector('#confirm').onclick = (event) => {
        window.confirmTrusted = event.isTrusted;
        window.confirmed = true;
        document.querySelector('#call-dialog').remove();
        if (${hideTemporaryOnConnect}) document.querySelector('#temporary-chat-button').remove();
        document.querySelector('.bridge-call').hidden = false;
        window.__owuiQuickVoiceCallsMedia.status = () => ({liveAudioTracks: 1, runningContexts: 1});
      };
      document.querySelector('#end').onclick = () => {
        window.ended = true;
        document.querySelector('.bridge-call').hidden = true;
        window.__owuiQuickVoiceCallsMedia.status = () => ({liveAudioTracks: 0, runningContexts: 0});
      };
    </script></body></html>`;
}

async function browserFixture(t, options = {}) {
  const RUNTIME = path.join(ROOT, 'runtime', 'tests');
  await mkdir(RUNTIME, { recursive: true });
  const profile = await mkdtemp(path.join(RUNTIME, 'test-profile-'));
  const config = { ...await loadConfig(EXAMPLE_CONFIG), baseUrl: 'https://voice.test/', profileDir: profile, windowMode: 'headless' };
  const browser = new VoiceBrowser(config, async (dir, launchOptions) => {
    assert.deepEqual(launchOptions.ignoreDefaultArgs, ['--mute-audio']);
    assert.ok(!launchOptions.args.some((arg) => arg.includes('fake-device')));
    const context = await chromium.launchPersistentContext(dir, launchOptions);
    await context.route('https://voice.test/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: fixture(options) });
    });
    return context;
  });
  t.after(async () => {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
  });
  return browser;
}

test('browser scopes confirmation and hang-up despite duplicate toolbar controls', async (t) => {
  const browser = await browserFixture(t);
  const abort = new AbortController();
  await browser.open({ setup: false, signal: abort.signal, onStatus() {} });
  assert.equal(await browser.page.evaluate(() => window.confirmed), true);
  assert.equal(await browser.connected(), true);
  assert.equal(await browser.page.getByRole('button', { name: 'End call', exact: true }).count(), 2);
  assert.equal(await browser.page.getByRole('dialog', { name: 'Unrelated confirmation' }).isVisible(), true);
  let ended = false;
  await browser.page.exposeFunction('reportEnd', () => { ended = true; });
  await browser.page.evaluate(() => document.querySelector('#end').addEventListener('click', () => {
    if (!window.toolbarEndClicked) window.reportEnd();
  }));
  await browser.close();
  assert.equal(ended, true);
  assert.equal(browser.closed, true);
});

test('browser refuses to start if temporary mode cannot be verified', async (t) => {
  const browser = await browserFixture(t, { temporary: false });
  await assert.rejects(browser.open({ setup: false, signal: new AbortController().signal, onStatus() {} }),
    /Temporary chat is not enabled/);
  assert.equal(await browser.page.evaluate(() => window.confirmed), false);
});

test('fast confirmation waits for enabled controls but never for animation frames or visual clicks', async (t) => {
  const browser = await browserFixture(t);
  const signal = new AbortController().signal;
  await browser.prepare({ signal });
  await browser.page.evaluate(() => {
    window.requestAnimationFrame = () => 1;
    document.querySelector('#confirm').disabled = true;
    setTimeout(() => { document.querySelector('#confirm').disabled = false; }, 75);
  });
  const dialog = browser.confirmationDialog.bind(browser);
  browser.confirmationDialog = () => {
    const locator = dialog();
    const byRole = locator.getByRole.bind(locator);
    locator.getByRole = (...args) => {
      const button = byRole(...args);
      button.click = () => { throw new Error('Visual confirmation clicks are not allowed'); };
      return button;
    };
    return locator;
  };
  await browser.startCall({ signal });
  assert.equal(await browser.page.evaluate(() => window.confirmed), true);
  assert.equal(await browser.page.evaluate(() => window.confirmTrusted), false);
  assert.equal(await browser.connected(), true);
});

test('ambiguous confirmation fails without arming microphone capture', async (t) => {
  const browser = await browserFixture(t);
  const signal = new AbortController().signal;
  await browser.prepare({ signal });
  await browser.page.evaluate(() => {
    document.querySelector('#call-dialog').append(document.querySelector('#confirm').cloneNode(true));
  });
  await assert.rejects(browser.startCall({ signal }), /Multiple call confirmation buttons/);
  assert.equal(await browser.page.evaluate(() => window.confirmed), false);
  const error = await browser.page.evaluate(async () => {
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); return 'unexpectedly allowed'; }
    catch (error) { return error.name; }
  });
  assert.equal(error, 'NotAllowedError');
});

test('temporary-mode change between preflight and dispatch fails closed', async (t) => {
  const browser = await browserFixture(t);
  const signal = new AbortController().signal;
  await browser.prepare({ signal });
  const verify = browser.assertTemporaryCall.bind(browser);
  browser.assertTemporaryCall = async () => {
    await verify();
    await browser.page.evaluate(() => document.querySelector('#temporary-chat-button path').setAttribute('d', 'other'));
  };
  await assert.rejects(browser.startCall({ signal }), /Temporary chat changed before confirmation/);
  assert.equal(await browser.page.evaluate(() => window.confirmed), false);
});

test('fast confirmation remains cancelable while a control is disabled', async (t) => {
  const browser = await browserFixture(t);
  await browser.prepare({ signal: new AbortController().signal });
  await browser.page.evaluate(() => { document.querySelector('#confirm').disabled = true; });
  const signal = AbortSignal.timeout(100);
  await browser.startCall({ signal }).catch((error) => assert.equal(error.name, 'AbortError'));
  assert.equal(signal.aborted, true);
  assert.equal(await browser.page.evaluate(() => window.confirmed), false);
  await browser.assertIdleMedia();
});

test('expanded call view may remove the verified temporary-chat navbar', async (t) => {
  const browser = await browserFixture(t, { hideTemporaryOnConnect: true });
  await browser.open({ setup: false, signal: new AbortController().signal, onStatus() {} });
  assert.equal(await browser.temporaryState(), 'unavailable');
  await assert.doesNotReject(browser.assertTemporaryCall());
  await assert.rejects(browser.monitor(AbortSignal.timeout(50), () => {}), { name: 'AbortError' });
});

test('explicitly disabled temporary mode or navigation out of temporary chat is rejected', async (t) => {
  const browser = await browserFixture(t);
  await browser.open({ setup: false, signal: new AbortController().signal, onStatus() {} });
  await browser.page.evaluate(() => document.querySelector('#temporary-chat-button path').setAttribute('d', 'other'));
  await assert.rejects(browser.assertTemporaryCall(), /Temporary-chat state changed/);
  await browser.page.evaluate(() => {
    document.querySelector('#temporary-chat-button').remove();
    history.replaceState(null, '', '/');
  });
  await assert.rejects(browser.assertTemporaryCall(), /Temporary-chat state changed/);
});

test('browser aborts history writes and flags privacy failure', async (t) => {
  const browser = await browserFixture(t);
  await browser.open({ setup: false, signal: new AbortController().signal, onStatus() {} });
  const failed = await browser.page.evaluate(async () => {
    try { await fetch('/api/v1/chats/new', { method: 'POST', body: '{}' }); return false; }
    catch { return true; }
  });
  assert.equal(failed, true);
  assert.throws(() => browser.assertSafe(), /Blocked a chat-history write/);
});

test('canceled browser launch does not leak a profile or context', async (t) => {
  const browser = await browserFixture(t);
  const abort = new AbortController();
  const opening = browser.open({ setup: false, signal: abort.signal, onStatus() {} });
  abort.abort();
  await browser.close();
  await opening;
  assert.equal(browser.context.pages().length, 0);
});

test('standby has no capture, starts on demand, and reuses Chrome with a fresh tab per call', async (t) => {
  const browser = await browserFixture(t);
  const signal = new AbortController().signal;
  await browser.prepare({ signal });
  const context = browser.context;
  const firstPage = browser.page;
  assert.equal(await browser.page.evaluate(() => window.confirmed), false);
  await browser.assertIdleMedia();
  assert.equal(await browser.isPrepared(), true);
  const captureError = await browser.page.evaluate(async () => {
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); return 'unexpectedly allowed'; }
    catch (error) { return error.name; }
  });
  assert.equal(captureError, 'NotAllowedError');
  await browser.page.evaluate(() => sessionStorage.setItem('old-conversation', 'must not carry over'));
  const timing = await browser.startCall({ signal });
  assert.ok(timing.totalMs >= 0);
  assert.equal(await browser.connected(), true);
  await browser.endCall({ keepBrowser: true });
  assert.equal(firstPage.isClosed(), true);
  assert.equal(browser.context, context);
  assert.equal(browser.closed, false);
  await browser.prepare({ signal });
  assert.equal(await browser.page.evaluate(() => sessionStorage.getItem('old-conversation')), null);
  assert.equal(await browser.page.evaluate(() => window.confirmed), false);
  assert.equal(context.pages().length, 1);
  await browser.assertIdleMedia();
  await browser.startCall({ signal });
  assert.equal(await browser.connected(), true);
  await browser.endCall({ keepBrowser: true });
  assert.equal(browser.context, context);
  await browser.prepare({ signal });
  await browser.assertIdleMedia();
});

test('refreshing standby replaces only the tab without confirming a call', async (t) => {
  const browser = await browserFixture(t);
  const signal = new AbortController().signal;
  await browser.prepare({ signal });
  const previous = browser.page;
  const context = browser.context;
  await browser.prepare({ signal, force: true });
  assert.equal(previous.isClosed(), true);
  assert.equal(browser.context, context);
  assert.equal(await browser.isPrepared(), true);
  assert.equal(await browser.page.evaluate(() => window.confirmed), false);
  await browser.assertIdleMedia();
});

test('headless hang-up does not depend on animation frames or visual click stability', async (t) => {
  const browser = await browserFixture(t);
  await browser.open({ setup: false, signal: new AbortController().signal, onStatus() {} });
  const page = browser.page;
  await page.evaluate(() => { window.requestAnimationFrame = () => 1; });
  const verify = page.waitForFunction.bind(page);
  page.waitForFunction = (expression, argument, options) => {
    assert.equal(options.polling, 25);
    return verify(expression, argument, options);
  };
  // Enforce that the normal Playwright click path cannot be used for hang-up.
  const locate = browser.endCallButton.bind(browser);
  browser.endCallButton = () => {
    const locator = locate();
    locator.click = () => { throw new Error('Visual clicks are not allowed in this regression test'); };
    return locator;
  };
  const timing = await browser.endCall({ keepBrowser: true });
  assert.equal(timing.hangupDispatched, true);
  assert.equal(timing.fallback, false);
  assert.ok(timing.audioStopMs < 750, JSON.stringify(timing));
  assert.equal(page.isClosed(), true);
});

test('audio-off notification precedes tab replacement and standby loading', async (t) => {
  const browser = await browserFixture(t);
  await browser.open({ setup: false, signal: new AbortController().signal, onStatus() {} });
  const oldPage = browser.page;
  let releaseReplacement;
  const replacementHeld = new Promise((resolve) => { releaseReplacement = resolve; });
  let audioStopped;
  const notified = new Promise((resolve) => { audioStopped = resolve; });
  const create = browser.newPage.bind(browser);
  browser.newPage = async () => { await replacementHeld; return create(); };
  const ending = browser.endCall({ keepBrowser: true, onAudioStopped: audioStopped });
  try {
    const report = await Promise.race([notified, delay(500).then(() => { throw new Error('Audio notification waited for replacement'); })]);
    assert.ok(report.audioStopMs < 500);
    assert.equal(browser.page, oldPage);
    assert.equal(oldPage.isClosed(), false);
  } finally { releaseReplacement(); }
  await ending;
  assert.equal(oldPage.isClosed(), true);
});

test('missing hang-up control falls back to closing only the conversation tab', async (t) => {
  const browser = await browserFixture(t);
  await browser.open({ setup: false, signal: new AbortController().signal, onStatus() {} });
  const page = browser.page;
  const context = browser.context;
  await page.evaluate(() => document.querySelector('#end').remove());
  const timing = await browser.endCall({ keepBrowser: true });
  assert.equal(timing.hangupDispatched, false);
  assert.equal(timing.fallback, true);
  assert.equal(page.isClosed(), true);
  assert.equal(browser.context, context);
  assert.equal(browser.closed, false);
  await browser.prepare({ signal: new AbortController().signal });
  await browser.assertIdleMedia();
});
