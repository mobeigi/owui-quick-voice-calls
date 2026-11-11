import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, writeFile, rename, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { decodeBridge, encodeBridge } from './bridge.js';
import { assertUnelevated } from './windows.js';
import { VoiceBrowser } from './browser.js';
import { Session } from './session.js';

assertUnelevated();
const config = await loadConfig();
const { runtimeDir: RUNTIME, bridgePath: BRIDGE } = config;
await mkdir(RUNTIME, { recursive: true });
const token = randomBytes(32).toString('hex');
const log = (message) => appendFile(path.join(RUNTIME, 'controller.log'),
  `${new Date().toISOString()} ${message}\n`).catch(() => {});
const session = new Session(() => new VoiceBrowser(config), (status) => {
  void log(`${status.state}: ${status.message}`);
}, {
  warmStandby: config.warmStandby,
  hotkey: config.hotkey,
  onTiming: (timing) => void log(`Call timing: prepare=${timing.prepareMs}ms confirm=${timing.confirmMs}ms connect=${timing.connectMs}ms total=${timing.totalMs}ms`),
  onStopTiming: (timing) => void log(`Stop timing: audioOff=${timing.audioStopMs}ms dispatch=${timing.dispatchMs}ms verify=${timing.verifyMs}ms total=${timing.totalMs}ms hangup=${timing.hangupDispatched} fallback=${timing.fallback}`)
});
let shuttingDown = false;
let heartbeatAt = 0;
let helperUiAccess = false;

function statusText() {
  const status = session.snapshot();
  return `state=${status.state}\nmessage=${status.message}\ngeneration=${status.generation}\nstarted=${status.started}\nended=${status.ended}\nlatencyMs=${status.latencyMs}\nendLatencyMs=${status.endLatencyMs}\nhelperAttached=${Number(heartbeatAt > 0 && Date.now() - heartbeatAt < 12000)}\nhelperUiAccess=${Number(helperUiAccess)}\n`;
}

function authenticated(request) {
  // A website must not be able to control the helper, even via a local fetch.
  if (request.headers.origin || request.headers.host !== `127.0.0.1:${config.port}`) return false;
  const supplied = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!authenticated(request)) { response.writeHead(403).end('Forbidden\n'); return; }
  if (shuttingDown) { response.writeHead(503).end('Shutting down\n'); return; }
  if (request.method === 'GET' && request.url === '/status') {
    response.end(statusText());
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405).end('Unavailable\n');
    return;
  }
  switch (request.url) {
    case '/heartbeat':
      heartbeatAt = Date.now();
      helperUiAccess = request.headers['x-owui-quick-voice-calls-uiaccess'] === '1';
      response.end(statusText());
      return;
    case '/toggle':
      void session.toggle();
      break;
    case '/login':
      if (!session.login()) {
        response.writeHead(409).end('Stop the current call or close setup first.\n');
        return;
      }
      break;
    case '/stop':
      void session.stop();
      break;
    case '/shutdown':
      response.writeHead(202).end('Shutting down\n');
      void shutdown();
      return;
    default:
      response.writeHead(404).end('Not found\n');
      return;
  }
  response.writeHead(202).end(statusText());
});
server.requestTimeout = 3000;
server.headersTimeout = 3000;
server.maxConnections = 16;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(watchdog);
  clearInterval(standbyRefresh);
  await session.shutdown();
  await log('Controller stopped');
  // Do not delete credentials belonging to a replacement process.
  const contents = await readFile(BRIDGE).then(decodeBridge).catch(() => '');
  if (contents.includes(`token=${token}`)) await rm(BRIDGE, { force: true });
  server.closeAllConnections();
  server.close(() => process.exit(0));
}

const watchdog = setInterval(() => {
  if (heartbeatAt && Date.now() - heartbeatAt > 12000) {
    void log('Hotkey helper heartbeat lost; ending owned session');
    void shutdown();
  }
}, 2000);
watchdog.unref();

const standbyRefresh = setInterval(() => {
  if (session.state === 'standby') session.warm({ force: true });
}, config.standbyRefreshMs);
standbyRefresh.unref();

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void shutdown());
process.on('uncaughtException', () => { void log('Unexpected controller error'); void shutdown(); });
process.on('unhandledRejection', () => { void log('Unexpected asynchronous controller error'); void shutdown(); });

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
} catch (error) {
  // Simultaneous launcher requests may race; only the listener owns the profile.
  if (error.code !== 'EADDRINUSE') await log('Unable to bind loopback controller port');
  process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
}
const temporaryBridge = `${BRIDGE}.${process.pid}.tmp`;
await writeFile(temporaryBridge, encodeBridge(config, { token, pid: process.pid }), { mode: 0o600 });
await rename(temporaryBridge, BRIDGE);
await log(`Controller ready on loopback port ${config.port}`);
session.warm();
