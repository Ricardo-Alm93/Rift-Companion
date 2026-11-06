'use strict';

const https = require('node:https');
const { ENDPOINTS, normalizeLiveClientSnapshot } = require('../adapters/live-client-data-adapter');

function requestLiveClient({ endpoint, ca, timeoutMs = 2500, requestImpl = https.request }) {
  if (!Object.values(ENDPOINTS).includes(endpoint)) return Promise.reject(Object.assign(new Error('invalid-request'), { code: 'LIVE_CLIENT_INVALID_REQUEST' }));
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = requestImpl({ hostname: '127.0.0.1', servername: 'localhost', port: 2999, path: endpoint, method: 'GET', ca, rejectUnauthorized: true, headers: { Accept: 'application/json' }, timeout: timeoutMs, agent: false }, res => {
        const chunks = []; let length = 0;
        res.on('data', chunk => { length += chunk.length; if (length > 2_000_000) req.destroy(Object.assign(new Error('response-too-large'), { code: 'LIVE_CLIENT_RESPONSE_TOO_LARGE' })); else chunks.push(chunk); });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(new Error('live-client-http-error'), { code: `LIVE_CLIENT_HTTP_${res.statusCode}` }));
          const body = Buffer.concat(chunks).toString('utf8');
          try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('invalid-json'), { code: 'LIVE_CLIENT_INVALID_RESPONSE' })); }
        });
      });
    } catch { return reject(Object.assign(new Error('live-client-request-failed'), { code: 'LIVE_CLIENT_CONNECTION_FAILED' })); }
    req.on('timeout', () => req.destroy(Object.assign(new Error('live-client-timeout'), { code: 'LIVE_CLIENT_TIMEOUT' })));
    req.on('error', error => reject(Object.assign(new Error('live-client-request-failed'), { code: /^LIVE_CLIENT_/.test(error?.code || '') ? error.code : 'LIVE_CLIENT_TLS_OR_CONNECTION_FAILED' })));
    req.end();
  });
}

class LiveClientDataClient {
  constructor({ ca, request = requestLiveClient, now = () => new Date().toISOString() } = {}) { this.ca = ca; this.request = request; this.now = now; }
  async read({ championByName = {}, sessionId = '', revision = 1, manualPlayerIndex = null } = {}) {
    const [activePlayerName, players, gameStats] = await Promise.all([
      this.request({ endpoint: ENDPOINTS.activePlayerName, ca: this.ca }),
      this.request({ endpoint: ENDPOINTS.playerList, ca: this.ca }),
      this.request({ endpoint: ENDPOINTS.gameStats, ca: this.ca }).catch(() => null)
    ]);
    if (typeof activePlayerName !== 'string' || !Array.isArray(players)) throw Object.assign(new Error('invalid-live-client-response'), { code: 'LIVE_CLIENT_INVALID_RESPONSE' });
    return normalizeLiveClientSnapshot({ activePlayerName, players, gameStats }, { championByName, sessionId, revision, updatedAt: this.now(), manualPlayerIndex });
  }
}

module.exports = { requestLiveClient, LiveClientDataClient };
