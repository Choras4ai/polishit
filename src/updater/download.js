'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

async function downloadVerifiedFile(url, destination, {
  sha256, size, onProgress = () => {}, userAgent = 'Runshi-Desktop', resume = false,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  const expectedHash = String(sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('更新清单缺少有效的 SHA-256 校验值，已取消安装。');
  const maximumBytes = 1024 * 1024 * 1024;
  const expectedBytes = Number(size) || 0;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maximumBytes) throw new Error('安装包大小无效。');
  const initialUrl = new URL(url);
  if (initialUrl.protocol !== 'https:' || initialUrl.username || initialUrl.password) throw new Error('更新安装包必须通过 HTTPS 下载。');
  const signal = AbortSignal.timeout(timeoutMs);
  let existingBytes = resume && fs.existsSync(destination) ? fs.statSync(destination).size : 0;
  if (resume && existingBytes > 0 && (!expectedBytes || existingBytes === expectedBytes)) {
    const cachedHash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(destination)) cachedHash.update(chunk);
    if (cachedHash.digest('hex') === expectedHash) {
      onProgress(existingBytes, existingBytes);
      return { bytes: existingBytes, cached: true };
    }
    // A complete corrupt file cannot be repaired by appending more bytes.
    if (expectedBytes) { fs.rmSync(destination, { force: true }); existingBytes = 0; }
  }
  if (resume && !existingBytes) fs.rmSync(destination, { force: true });
  if (existingBytes > expectedBytes) {
    fs.rmSync(destination, { force: true });
    existingBytes = 0;
  }
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('更新安装包必须通过 HTTPS 下载。');
    const headers = { 'User-Agent': userAgent };
    if (existingBytes > 0) headers.Range = `bytes=${existingBytes}-`;
    response = await fetch(parsed, { redirect: 'manual', signal, cache: 'no-store', headers });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    if (redirects === 5 || !response.headers.get('location')) throw new Error('安装包下载重定向无效。');
    url = new URL(response.headers.get('location'), parsed).href;
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (response.status === 416 && existingBytes > 0) {
      fs.rmSync(destination, { force: true });
      return downloadVerifiedFile(url, destination, { sha256, size, onProgress, userAgent, resume, timeoutMs });
    }
    throw new Error(`下载失败 (${response.status})`);
  }
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!range || Number(range[1]) !== existingBytes || Number(range[2]) < existingBytes
      || Number(range[2]) >= Number(range[3]) || (expectedBytes && Number(range[3]) !== expectedBytes)) {
      await response.body.cancel();
      if (resume) fs.rmSync(destination, { force: true });
      throw new Error('安装包续传范围无效，请重试。');
    }
  }
  if (existingBytes > 0 && response.status !== 206) {
    existingBytes = 0;
    fs.rmSync(destination, { force: true });
  }
  const announcedBytes = Number(response.headers.get('content-length')) || 0;
  if (announcedBytes > maximumBytes) { await response.body.cancel(); throw new Error('安装包超过大小限制。'); }
  const hash = crypto.createHash('sha256');
  if (existingBytes > 0) hash.update(fs.readFileSync(destination));
  let received = existingBytes;
  let invalidContent = false;
  const output = fs.createWriteStream(destination, { flags: existingBytes > 0 ? 'a' : 'wx', mode: 0o600 });
  try {
    await pipeline(response.body, async function* (source) {
      for await (const chunk of source) {
        received += chunk.length;
        if (received > (expectedBytes || maximumBytes)) { invalidContent = true; throw new Error('安装包超过预期大小。'); }
        hash.update(chunk);
        onProgress(received, expectedBytes || announcedBytes);
        yield chunk;
      }
    }, output, { signal });
    if (expectedBytes && received !== expectedBytes) throw new Error('安装包大小校验失败。');
    if (hash.digest('hex') !== expectedHash) { invalidContent = true; throw new Error('安装包完整性校验失败，已取消安装。'); }
    return { bytes: received };
  } catch (error) {
    // Never remove an existing destination when exclusive creation failed.
    if (error.code !== 'EEXIST' && (!resume || invalidContent)) fs.rmSync(destination, { force: true });
    throw error;
  }
}
module.exports = { downloadVerifiedFile };
