export function decodeBridge(buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xfe
    ? buffer.subarray(2).toString('utf16le') : buffer.toString('utf8');
}

export function bridgeValue(text, key) {
  return new RegExp(`^${key}=([^\\r\\n]*)\\r?$`, 'm').exec(text)?.[1];
}

export function encodeBridge(config, { token, pid }) {
  const values = {
    port: config.port, token, pid, configFile: config.configFile,
    hotkey: config.hotkey, uiAccess: Number(config.hotkeyMode === 'uiAccess'),
    statusPollMs: config.statusPollMs,
    sounds: Number(config.sounds.enabled), errorBeep: Number(config.sounds.errorBeep),
    connectedSound: config.sounds.connected, hangupSound: config.sounds.hangup
  };
  const lines = Object.entries(values).map(([key, value]) => {
    if (/[\r\n\0]/.test(String(value))) throw new Error('Bridge settings cannot contain line breaks.');
    return `${key}=${value}`;
  });
  // Windows IniRead requires UTF-16 with BOM for non-ASCII sound/config paths.
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`[bridge]\r\n${lines.join('\r\n')}\r\n`, 'utf16le')]);
}
