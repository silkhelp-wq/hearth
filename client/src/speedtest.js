/**
 * Speed test against the Hearth server — which is exactly the path media
 * takes (through Tailscale), so results reflect real streaming conditions,
 * WireGuard overhead included.
 */

const UPLOAD_CHUNK = 4 * 1024 * 1024; // 4 MiB per POST
const UPLOAD_SECONDS = 8;
const DOWNLOAD_MB = 16;

function randomBody(bytes) {
  // crypto.getRandomValues caps at 64KiB per call; fill in slices.
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65536) {
    crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, bytes)));
  }
  return buf;
}

export async function measurePing(socket, samples = 8) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await new Promise((resolve) => socket.emit('ping', t0, resolve));
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]; // median
}

export async function measureDownload(baseUrl, onProgress) {
  const res = await fetch(`${baseUrl}/speedtest/download?mb=${DOWNLOAD_MB}`, {
    cache: 'no-store'
  });
  if (!res.ok || !res.body) throw new Error(`download test failed (${res.status})`);

  const reader = res.body.getReader();
  const t0 = performance.now();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    onProgress?.(bytes, performance.now() - t0);
  }
  const secs = (performance.now() - t0) / 1000;
  return (bytes * 8) / secs / 1e6; // Mbps
}

export async function measureUpload(baseUrl, onProgress) {
  const body = randomBody(UPLOAD_CHUNK);
  const t0 = performance.now();
  let bytes = 0;
  while ((performance.now() - t0) / 1000 < UPLOAD_SECONDS) {
    const res = await fetch(`${baseUrl}/speedtest/upload`, {
      method: 'POST',
      body,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/octet-stream' }
    });
    if (!res.ok) throw new Error(`upload test failed (${res.status})`);
    bytes += UPLOAD_CHUNK;
    onProgress?.(bytes, performance.now() - t0);
  }
  const secs = (performance.now() - t0) / 1000;
  return (bytes * 8) / secs / 1e6; // Mbps
}

export async function runFullTest({ baseUrl, socket, name, onPhase }) {
  onPhase?.('ping');
  const pingMs = await measurePing(socket);

  onPhase?.('download');
  const downMbps = await measureDownload(baseUrl);

  onPhase?.('upload');
  const upMbps = await measureUpload(baseUrl);

  // Share with the server so the host can see the whole crew's numbers.
  fetch(`${baseUrl}/speedtest/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, upMbps, downMbps, pingMs })
  }).catch(() => {});

  return {
    pingMs: Math.round(pingMs),
    downMbps: Math.round(downMbps * 10) / 10,
    upMbps: Math.round(upMbps * 10) / 10
  };
}

export async function fetchCrewReports(baseUrl) {
  const res = await fetch(`${baseUrl}/speedtest/reports`, { cache: 'no-store' });
  return res.ok ? res.json() : [];
}
