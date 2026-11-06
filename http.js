'use strict';
const http = require('http');
const https = require('https');
const {execFile} = require('child_process');

function request(url, {timeout = 60000, maxBytes = 200 * 1024 * 1024, redirects = 5} = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Unsupported HTTP protocol'));
    const req = (parsed.protocol === 'https:' ? https : http).get(parsed, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new Error('Too many redirects'));
        return request(new URL(res.headers.location, parsed).href, {timeout, maxBytes, redirects: redirects - 1}).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${parsed.hostname}${parsed.pathname}`), {status: res.statusCode}));
      }
      const chunks = []; let size = 0;
      res.on('data', b => {
        size += b.length;
        if (size > maxBytes) res.destroy(new Error('HTTP response exceeds size limit'));
        else chunks.push(b);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('HTTP response aborted')));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('HTTP timeout'), {code: 'ETIMEDOUT'})));
    req.on('error', reject);
  });
}

async function fetchBuffer(url, {attempts = 3, delay = 250, curl = process.env.SKETCHFAB_HTTP === 'curl', ...options} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (!curl) return await request(url, options);
      return await new Promise((resolve, reject) => {
        execFile('curl', ['-L', '-sS', '--fail', '--proto', '=http,https', '--max-redirs', '5', '--max-time', String((options.timeout || 60000) / 1000), url],
          {encoding: 'buffer', maxBuffer: options.maxBytes || 200 * 1024 * 1024},
          (error, stdout) => error ? reject(error) : resolve(stdout));
      });
    } catch (error) {
      if (attempt >= attempts || (error.status && error.status !== 408 && error.status !== 429 && error.status < 500)) throw error;
      await new Promise(resolve => setTimeout(resolve, delay * 2 ** (attempt - 1)));
    }
  }
}

async function mapPool(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency');
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}
module.exports = {fetchBuffer, mapPool};
