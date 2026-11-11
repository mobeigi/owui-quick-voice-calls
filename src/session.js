function safeError(error) {
  return error.publicMessage || (error.message?.includes('strict mode violation')
    ? 'Multiple Open WebUI controls matched an automation selector. The helper selectors need updating.'
    : 'Browser operation failed. Check Chrome, login, and configuration.');
}

// One operation owns the browser at a time. Preparing is not an active call:
// the first hotkey press during preparation requests a start, and the second cancels it.
export class Session {
  constructor(createBrowser, onChange = () => {}, {
    warmStandby = true, onTiming = () => {}, onStopTiming = () => {}, hotkey = 'F16'
  } = {}) {
    this.createBrowser = createBrowser;
    this.onChange = onChange;
    this.onTiming = onTiming;
    this.onStopTiming = onStopTiming;
    this.warmStandby = warmStandby;
    this.hotkey = hotkey;
    this.state = 'idle';
    this.message = `Ready - ${hotkey} starts a temporary call`;
    this.generation = 0;
    this.started = 0;
    this.ended = 0;
    this.task = null;
    this.browser = null;
    this.disposed = false;
  }

  snapshot() {
    return {
      state: this.state, message: this.message, generation: this.generation,
      started: this.started, ended: this.ended, latencyMs: this.latencyMs ?? '',
      endLatencyMs: this.endLatencyMs ?? ''
    };
  }

  set(state, message) {
    this.state = state;
    this.message = message;
    this.onChange(this.snapshot());
  }

  warm({ force = false } = {}) {
    if (!this.warmStandby || this.disposed || this.task) return false;
    return this.begin({ force });
  }

  toggle() {
    if (this.disposed) return false;
    if (this.task) {
      if (this.state === 'stopping') return this.stop();
      if (this.operation.phase === 'prepare' && !this.operation.start) {
        this.operation.start = true;
        this.operation.requestedAt = performance.now();
        this.generation += 1;
        this.set('starting', 'Waiting for fresh temporary tab');
        return true;
      }
      return this.stop();
    }
    this.generation += 1;
    return this.begin({ start: true });
  }

  login() {
    if (this.disposed) return false;
    if (this.task) {
      if (this.operation.phase !== 'prepare' || this.operation.start) return false;
      // Switch an in-progress background warm-up to visible manual setup.
      const pending = this.stop({ rearm: false });
      void pending.then(() => { if (!this.disposed) this.begin({ setup: true }); });
      return true;
    }
    return this.begin({ setup: true });
  }

  begin({ setup = false, start = false, force = false } = {}) {
    if (this.disposed || this.task) return false;
    const operation = {
      setup, start, force, phase: setup ? 'setup' : 'prepare',
      abort: new AbortController(), requestedAt: performance.now(), rearm: true, connected: false
    };
    this.operation = operation;
    this.set(setup ? 'setup' : start ? 'starting' : 'warming', setup
      ? 'Sign in, choose defaults, then close the setup browser'
      : start ? 'Starting fresh temporary call' : 'Preparing next call - microphone off');
    this.task = Promise.resolve().then(() => this.run(operation));
    return true;
  }

  async run(operation) {
    const { setup, abort } = operation;
    const signal = abort.signal;
    let failure;
    let standbyReady = false;
    try {
      if (setup || this.browser?.closed || this.browser?.closing) {
        await this.browser?.close();
        this.browser = null;
      }
      if (signal.aborted) return;
      this.browser ||= this.createBrowser();
      const onStatus = (message) => {
        if (!signal.aborted) this.set(setup ? 'setup' : operation.start ? 'starting' : 'warming', message);
      };
      if (setup) {
        await this.browser.open({ setup: true, signal, onStatus });
        if (!signal.aborted) await this.browser.waitForClose(signal);
      } else {
        await this.browser.prepare({ signal, onStatus, force: operation.force });
        if (signal.aborted) return;
        if (!operation.start) {
          standbyReady = true;
          return;
        }
        operation.phase = 'connecting';
        const timing = await this.browser.startCall({ signal, onStatus, requestedAt: operation.requestedAt });
        if (signal.aborted) return;
        operation.phase = 'active';
        operation.connected = true;
        this.started += 1;
        this.latencyMs = timing.totalMs;
        this.onTiming(timing);
        this.set('active', `Listening - ${this.hotkey} ends call`);
        await this.browser.monitor(signal, (muted) => {
          if (!signal.aborted) this.set(muted ? 'muted' : 'active', muted
            ? `Muted in Open WebUI - ${this.hotkey} ends call` : `Listening - ${this.hotkey} ends call`);
        });
      }
    } catch (error) {
      if (!signal.aborted) failure = safeError(error);
    } finally {
      if (!standbyReady) {
        this.set('stopping', 'Ending session and releasing microphone');
        let released = false;
        try {
          const keepBrowser = this.warmStandby && !setup && !failure && !this.disposed
            && this.browser && !this.browser.closed && !this.browser.closing;
          if (keepBrowser) {
            const timing = await this.browser.endCall(this.endOptions(operation, true));
            if (timing) this.onStopTiming(timing);
          }
          else {
            await this.browser?.close();
            this.browser = null;
          }
          released = true;
        } catch {
          failure = 'Browser did not close cleanly. Close the dedicated Chrome window manually.';
          try { await this.browser?.close(); released = true; } catch { /* Do not report audio off without teardown. */ }
          this.browser = null;
        }
        if (released) this.markAudioStopped(operation);
      }
      this.task = null;
      this.operation = null;
      if (this.disposed) this.set('idle', 'Helper stopped - browser closed');
      else if (failure) this.set('error', failure);
      else if (standbyReady) this.set('standby', `Standby ready - microphone off - ${this.hotkey} starts`);
      else {
        this.set('idle', setup ? 'Setup closed - profile retained' : 'Call ended - microphone released');
        if (operation.rearm) this.warm();
      }
    }
  }

  async stop({ rearm = true } = {}) {
    const task = this.task;
    if (!task) return;
    const operation = this.operation;
    operation.rearm = rearm;
    operation.stopRequestedAt ??= performance.now();
    operation.abort.abort();
    this.set('stopping', 'Ending session and releasing microphone');
    // Active hang-up retains Chrome. During navigation/connection, closing the
    // context interrupts Playwright waits promptly; warm-up then rebuilds it.
    if (operation.phase === 'active') {
      // Do not wait for an in-flight monitor locator to finish before cutting audio.
      void this.browser?.endCall(this.endOptions(operation, this.warmStandby && !this.disposed)).catch(() => {});
    } else await this.browser?.close().catch(() => {});
    await task;
  }

  markAudioStopped(operation, timing) {
    if (!operation.connected || operation.audioStopped) return;
    operation.audioStopped = true;
    this.ended += 1;
    if (timing) this.endLatencyMs = timing.audioStopMs;
    this.set('stopping', 'Audio off - finishing hang-up');
  }

  endOptions(operation, keepBrowser) {
    return {
      keepBrowser,
      requestedAt: operation.stopRequestedAt ?? performance.now(),
      onAudioStopped: (timing) => this.markAudioStopped(operation, timing)
    };
  }

  async shutdown() {
    this.disposed = true;
    await this.stop({ rearm: false });
    await this.browser?.close();
    this.browser = null;
    this.set('idle', 'Helper stopped - browser closed');
  }
}
