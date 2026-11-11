import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

export function userError(message) {
  return Object.assign(new Error(message), { publicMessage: message });
}

async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Browser shutdown step timed out.')), Math.max(1, timeoutMs));
      })
    ]);
  } finally { clearTimeout(timer); }
}

export function isHistoryWrite(url, method, origin) {
  const parsed = new URL(url);
  return parsed.origin === origin && /^\/api\/v1\/chats(?:\/|$)/.test(parsed.pathname)
    && !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

export function callUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set('temporary-chat', 'true');
  url.searchParams.set('call', 'true');
  return url.href;
}

// No audio recording, transcripts, tokens, or raw websocket messages are collected.
export function installMediaProbe({ allowCapture = false } = {}) {
  const tracks = new Set();
  const contexts = new Set();
  let captureAllowed = allowCapture;
  let epoch = 0;
  const quiesce = () => {
    captureAllowed = false;
    epoch += 1;
    for (const track of tracks) track.stop();
    for (const element of window.document?.querySelectorAll('audio, video') || []) {
      element.muted = true;
      element.pause();
    }
    window.speechSynthesis?.cancel();
    // Suspend output immediately without racing WebUI's own context.close().
    for (const context of contexts) {
      if (context.state === 'running') void context.suspend().catch(() => {});
    }
  };
  const original = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
  if (original) navigator.mediaDevices.getUserMedia = async (...args) => {
    if (!captureAllowed) throw new DOMException('Open WebUI Quick Voice Calls standby does not allow capture.', 'NotAllowedError');
    const requestEpoch = epoch;
    const stream = await original(...args);
    for (const track of stream.getTracks()) tracks.add(track);
    if (!captureAllowed || epoch !== requestEpoch) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException('Open WebUI Quick Voice Calls session was canceled.', 'AbortError');
    }
    return stream;
  };
  const OriginalContext = window.AudioContext;
  if (OriginalContext) window.AudioContext = new Proxy(OriginalContext, {
    construct(target, args) {
      const context = Reflect.construct(target, args);
      contexts.add(context);
      return context;
    }
  });
  Object.defineProperty(window, '__owuiQuickVoiceCallsMedia', {
    value: {
      arm: () => { captureAllowed = true; },
      quiesce,
      status: () => ({
        liveAudioTracks: [...tracks].filter((t) => t.kind === 'audio' && t.readyState === 'live').length,
        enabledAudioTracks: [...tracks].filter((t) => t.kind === 'audio' && t.readyState === 'live' && t.enabled).length,
        runningContexts: [...contexts].filter((c) => c.state === 'running').length,
        playingMediaElements: [...(window.document?.querySelectorAll('audio, video') || [])]
          .filter((element) => !element.paused && !element.muted).length,
        speaking: window.speechSynthesis?.speaking ?? false
      }),
      stop: () => {
        quiesce();
        for (const context of contexts) void context.close().catch(() => {});
      }
    }
  });
}

export class VoiceBrowser {
  constructor(config, launch = (profile, options) => chromium.launchPersistentContext(profile, options)) {
    this.config = config;
    this.launch = launch;
    this.closing = false;
    this.closed = false;
    this.context = null;
  }

  async ensureContext({ setup = false, signal }) {
    const config = this.config;
    if (this.context && !this.closed && !this.closing) return;
    if (signal.aborted) return;
    try {
      this.launching = this.launch(config.profileDir, {
        channel: config.browserChannel || undefined,
        headless: !setup && config.windowMode === 'headless',
        // Playwright otherwise includes --mute-audio, which breaks this helper's purpose.
        ignoreDefaultArgs: ['--mute-audio'],
        args: [
          '--autoplay-policy=no-user-gesture-required',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows'
        ],
        viewport: null,
        serviceWorkers: 'block',
        timeout: 20000
      });
      this.context = await this.launching;
    } catch {
      throw userError('Cannot open the dedicated browser. Close other helpers using the configured profile and check the configured browser is installed.');
    }
    if (signal.aborted || this.closing) {
      await this.context.close();
      return;
    }
    this.context.on('close', () => { this.closed = true; });
    await this.context.grantPermissions(['microphone'], { origin: new URL(config.baseUrl).origin });
    await this.context.addInitScript(installMediaProbe, { allowCapture: setup });
    if (!setup) {
      await this.context.route('**/api/v1/chats{,/**}', async (route) => {
        const request = route.request();
        if (isHistoryWrite(request.url(), request.method(), new URL(config.baseUrl).origin)) {
          this.historyWriteBlocked = true;
          await route.abort('blockedbyclient');
        } else await route.continue();
      });
    }
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.configurePage(this.page);
    // Nothing except this dedicated page should keep a call alive.
    this.context.on('page', (page) => {
      if (!setup && !this.creatingPage && page !== this.page) void page.close().catch(() => {});
    });
    for (const page of this.context.pages()) {
      if (page !== this.page) await page.close();
    }
  }

  configurePage(page) {
    page.setDefaultTimeout(2500);
    this.realtimeSockets = new Set();
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname.replace(/\/$/, '') !== '/api/v1/audio/realtime') return;
      this.realtimeSockets.add(socket);
      socket.on('close', () => this.realtimeSockets.delete(socket));
    });
  }

  async newPage() {
    this.creatingPage = true;
    try {
      const page = await this.context.newPage();
      this.page = page;
      this.configurePage(page);
      return page;
    } finally { this.creatingPage = false; }
  }

  confirmationDialog() {
    return this.page.getByRole('dialog', {
      name: this.config.selectors.confirmationDialogName, exact: true
    }).filter({ hasText: this.config.selectors.confirmationText });
  }

  async open({ setup, signal, onStatus }) {
    if (setup) {
      await this.ensureContext({ setup, signal });
      if (signal.aborted) return;
      await this.page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    }
    await this.prepare({ signal, onStatus });
    if (!signal.aborted) await this.startCall({ signal, onStatus });
  }

  async isPrepared() {
    if (this.closed || this.closing || !this.page || this.page.isClosed() || !this.preparedAt) return false;
    this.assertSafe();
    const url = new URL(this.page.url());
    if (url.origin !== new URL(this.config.baseUrl).origin || url.pathname !== '/'
      || url.searchParams.get('temporary-chat') !== 'true' || url.searchParams.get('call') !== 'true') return false;
    return await this.confirmationDialog().isVisible() && await this.isTemporary();
  }

  async assertIdleMedia() {
    const media = await this.page.evaluate(() => window.__owuiQuickVoiceCallsMedia?.status());
    if (!media || media.liveAudioTracks !== 0 || this.realtimeSockets.size !== 0) {
      throw userError('Unexpected microphone capture or Realtime connection in standby. Browser closed for safety.');
    }
  }

  async prepare({ signal, onStatus = () => {}, force = false }) {
    const config = this.config;
    if (signal.aborted) return;
    await this.ensureContext({ signal });
    if (signal.aborted) return;
    if (!force && await this.isPrepared()) {
      await this.assertIdleMedia();
      return;
    }
    if (this.preparedAt) {
      // Even an unconfirmed stale page gets a new tab/sessionStorage, not a reload.
      await this.endCall({ keepBrowser: true });
    }
    this.endTask = null;
    this.preparedAt = null;
    this.temporaryVerified = false;
    this.historyWriteBlocked = false;
    await this.page.goto(callUrl(config.baseUrl), { waitUntil: 'domcontentloaded', timeout: 30000 });

    let deadline = Date.now() + config.startupTimeoutMs;
    let loginDetected = false;
    while (!signal.aborted && !this.closed && Date.now() < deadline) {
      this.assertSafe();
      const url = new URL(this.page.url());
      const login = url.origin !== new URL(config.baseUrl).origin
        || url.pathname.startsWith('/auth')
        || await this.page.locator('input[type="password"]').isVisible();
      if (login) {
        if (!loginDetected) {
          loginDetected = true;
          deadline = Date.now() + config.loginTimeoutMs;
          onStatus(`Sign in in the dedicated browser; ${config.hotkey || 'the hotkey'} cancels`);
          if (config.windowMode === 'headless') {
            throw userError('Login expired. Use tray Login / setup in a visible browser, then try again.');
          }
          await this.page.bringToFront();
        }
        await delay(300, undefined, { signal });
        continue;
      }
      if (loginDetected && url.pathname === '/' && url.searchParams.get('call') !== 'true') {
        // Some sign-in flows discard the return URL. Navigate fresh after successful login.
        await this.page.goto(callUrl(config.baseUrl), { waitUntil: 'domcontentloaded' });
      }
      const dialog = this.confirmationDialog();
      if (await dialog.isVisible()) {
        if (!await this.isTemporary()) {
          throw userError('Temporary chat is not enabled or could not be verified. Call was not started.');
        }
        this.temporaryVerified = true;
        await this.assertIdleMedia();
        if (config.standbyMinimized && config.windowMode !== 'headless') await this.minimize();
        this.preparedAt = Date.now();
        return;
      }
      await delay(200, undefined, { signal });
    }
    if (!signal.aborted) throw userError(this.closed
      ? 'Dedicated browser was closed before standby was ready.'
      : 'Standby preparation timed out. Check login, English UI selectors, and default model.');
  }

  async startCall({ signal, onStatus = () => {}, requestedAt = performance.now() }) {
    const config = this.config;
    const start = performance.now();
    this.assertSafe();
    await this.assertTemporaryCall();
    await this.assertIdleMedia();
    if (signal.aborted) return;
    if (config.windowMode === 'visible' && config.standbyMinimized) await this.setWindowState('normal');
    if (!await this.confirmPreparedCall(signal)) return;
    const confirmedAt = performance.now();
    this.preparedAt = null;
    onStatus('Connecting Realtime audio');
    const deadline = Date.now() + config.startupTimeoutMs;
    while (!signal.aborted && !this.closed && !this.page.isClosed() && Date.now() < deadline) {
      this.assertSafe();
      if (await this.connected()) {
        if (config.windowMode === 'minimized') await this.minimize();
        return {
          prepareMs: Math.round(start - requestedAt),
          confirmMs: Math.round(confirmedAt - start),
          connectMs: Math.round(performance.now() - confirmedAt),
          totalMs: Math.round(performance.now() - requestedAt)
        };
      }
      const error = this.page.locator(`${config.selectors.realtimePanel} .call-error`);
      if (await error.isVisible()) {
        throw userError('Open WebUI could not connect the Realtime call. Check its Realtime configuration and microphone.');
      }
      await delay(50, undefined, { signal });
    }
    if (!signal.aborted) throw userError(this.closed
      ? 'Dedicated browser was closed before the call connected.'
      : 'Call startup timed out. Check login, English UI selectors, default model, and Realtime settings.');
  }

  async confirmPreparedCall(signal) {
    const deadline = Date.now() + Math.min(this.config.startupTimeoutMs, 2500);
    while (!signal.aborted && Date.now() < deadline) {
      this.assertSafe();
      if (this.realtimeSockets.size) throw userError('Unexpected Realtime connection before call confirmation. Call stopped.');
      // Arm and dispatch in one page task, without Playwright's visual click /
      // animation-frame stability wait. Recheck privacy and capture immediately
      // before arming, so a changed/stale page can never bypass the start guards.
      const result = await this.confirmationDialog().getByRole('button', {
        name: this.config.selectors.confirmationButtonName, exact: true
      }).evaluateAll((buttons, origin) => {
        if (buttons.length > 1) return 'ambiguous';
        if (!buttons.length || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') return 'not-ready';
        const url = new URL(location.href);
        const checked = document.querySelector('#temporary-chat-button path[d="M8 12L11 15L16 10"]');
        const saved = document.querySelector('#save-temporary-chat-button');
        if (url.origin !== origin || url.pathname !== '/' || url.searchParams.get('temporary-chat') !== 'true'
          || url.searchParams.get('call') !== 'true' || !(checked || saved)) return 'temporary';
        const probe = window.__owuiQuickVoiceCallsMedia;
        if (!probe || probe.status().liveAudioTracks !== 0) return 'media';
        probe.arm();
        buttons[0].click();
        return 'confirmed';
      }, new URL(this.config.baseUrl).origin);
      if (result === 'confirmed') return true;
      if (result === 'ambiguous') throw userError('Multiple call confirmation buttons matched. Call was not started.');
      if (result === 'temporary') throw userError('Temporary chat changed before confirmation. Call was not started.');
      if (result === 'media') throw userError('Microphone capture was not idle before confirmation. Call was not started.');
      // Preserve waiting for a genuinely disabled/unmounted control, but do not
      // wait for visual stability or require requestAnimationFrame in headless.
      await delay(25, undefined, { signal });
    }
    if (!signal.aborted) throw userError('Call confirmation is not ready. Check the configured dialog/button selectors.');
    return false;
  }

  assertSafe() {
    if (this.historyWriteBlocked) throw userError('Blocked a chat-history write. Call stopped to protect temporary-chat privacy.');
  }

  async isTemporary() {
    return await this.temporaryState() === 'enabled';
  }

  async temporaryState() {
    return this.page.evaluate(() => {
      const toggle = document.querySelector('#temporary-chat-button');
      const checked = toggle?.querySelector('path[d="M8 12L11 15L16 10"]');
      const saved = document.querySelector('#save-temporary-chat-button');
      if (checked || saved) return 'enabled';
      // WebUI removes the chat navbar in its expanded call view. Missing controls
      // are not evidence that temporary mode has been switched off.
      return toggle ? 'disabled' : 'unavailable';
    });
  }

  async assertTemporaryCall() {
    const url = new URL(this.page.url());
    const state = await this.temporaryState();
    if (!this.temporaryVerified || state === 'disabled'
      || url.origin !== new URL(this.config.baseUrl).origin || url.pathname !== '/'
      || url.searchParams.get('temporary-chat') !== 'true') {
      throw userError('Temporary-chat state changed. Call stopped.');
    }
  }

  async connected() {
    const status = await this.page.locator(this.config.selectors.realtimeStatus).textContent({ timeout: 250 }).catch(() => '');
    const end = this.endCallButton();
    const media = await this.page.evaluate(() => window.__owuiQuickVoiceCallsMedia?.status());
    return /^(Listening|Speaking|Microphone off)$/.test(status?.trim())
      && await end.isVisible() && media?.liveAudioTracks > 0 && media?.runningContexts > 0;
  }

  endCallButton() {
    // WebUI also renders an End call button in its tab/toolbar controls. Keep
    // every connection, monitoring, and hang-up check inside the Realtime panel.
    return this.page.locator(this.config.selectors.realtimePanel).getByRole('button', {
      name: this.config.selectors.endCallName, exact: true
    });
  }

  async minimize() {
    return this.setWindowState('minimized');
  }

  async setWindowState(windowState) {
    const cdp = await this.context.newCDPSession(this.page);
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
    } finally { await cdp.detach(); }
  }

  async waitForClose(signal) {
    while (!this.closed && !this.page.isClosed() && !signal.aborted) await delay(300, undefined, { signal });
  }

  async monitor(signal, onMute) {
    let lastMuted;
    while (!this.closed && !this.page.isClosed() && !signal.aborted) {
      this.assertSafe();
      await this.assertTemporaryCall();
      const end = this.endCallButton();
      if (!await end.isVisible()) return; // User ended the call inside WebUI.
      const status = await this.page.locator(this.config.selectors.realtimeStatus).textContent();
      if (/disconnected/i.test(status || '')) throw userError('Realtime call disconnected. Microphone released.');
      const muted = /Microphone off/i.test(status || '');
      if (muted !== lastMuted) { lastMuted = muted; onMute(muted); }
      await delay(750, undefined, { signal });
    }
  }

  close() {
    if (!this.closeTask) this.closeTask = this.closeOnce();
    return this.closeTask;
  }

  async closeOnce() {
    this.closing = true;
    // If launch is still pending, await it so a canceled start cannot leak a browser.
    const context = this.context || await this.launching?.catch(() => null);
    if (!context) return;
    try { await this.endCall({ keepBrowser: false }); }
    finally {
      await context.close();
      this.closed = true;
    }
  }

  endCall({ keepBrowser = true, onAudioStopped = () => {}, requestedAt = performance.now() } = {}) {
    if (!this.endTask) this.endTask = this.endCallOnce({ keepBrowser, onAudioStopped, requestedAt });
    return this.endTask;
  }

  async endCallOnce({ keepBrowser, onAudioStopped, requestedAt }) {
    const page = this.page;
    const start = performance.now();
    const deadline = start + this.config.stopTimeoutMs;
    const remaining = () => Math.max(1, deadline - performance.now());
    const timing = { dispatchMs: 0, verifyMs: 0, audioStopMs: null, totalMs: 0, hangupDispatched: false, fallback: false };
    const markAudioStopped = () => {
      if (timing.audioStopMs !== null) return;
      timing.audioStopMs = Math.round(performance.now() - requestedAt);
      onAudioStopped({ audioStopMs: timing.audioStopMs });
    };
    try {
      if (page && !page.isClosed()) {
        const dispatch = performance.now();
        // No visual actionability/animation-frame wait: local capture is cut in
        // the same page task that dispatches WebUI's explicit hang-up event.
        timing.hangupDispatched = await bounded(this.endCallButton().evaluateAll((buttons) => {
          window.__owuiQuickVoiceCallsMedia?.quiesce();
          if (buttons.length !== 1) return false;
          buttons[0].click();
          return true;
        }), remaining());
        timing.dispatchMs = Math.round(performance.now() - dispatch);
        const verify = performance.now();
        await bounded(page.waitForFunction(() => {
          const media = window.__owuiQuickVoiceCallsMedia?.status();
          return media && media.liveAudioTracks === 0 && media.runningContexts === 0
            && !media.playingMediaElements && !media.speaking;
        }, undefined, { polling: 25, timeout: remaining() }), remaining());
        timing.verifyMs = Math.round(performance.now() - verify);
        markAudioStopped();
        if (!timing.hangupDispatched) timing.fallback = true;
      } else markAudioStopped();
    } catch {
      timing.fallback = true; // Tab/context teardown below releases any stuck media/socket.
    }
    finally {
      if (page && !page.isClosed()) {
        await bounded(page.evaluate(() => window.__owuiQuickVoiceCallsMedia?.stop()), remaining()).catch(() => {});
      }
      this.preparedAt = null;
      if (keepBrowser && !this.closed && !this.closing && page && !page.isClosed()) {
        // Keep one blank tab alive before closing the old conversation tab;
        // closing Chrome's last tab would terminate the warm browser process.
        await bounded(this.newPage(), this.config.stopTimeoutMs);
        await bounded(page.close(), this.config.stopTimeoutMs);
        markAudioStopped();
      } else if (page && !page.isClosed()) {
        await bounded(page.close(), this.config.stopTimeoutMs);
        markAudioStopped();
      }
    }
    timing.totalMs = Math.round(performance.now() - requestedAt);
    return timing;
  }
}
