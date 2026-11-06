'use strict';

const { normalizeMerakiChampion, createCommunityDragonAdapter } = require('../domain/champion-knowledge-sources');

const MERAKI_URL = 'https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json';

function createMerakiAdapter({ fetchImpl = globalThis.fetch, readCache = async () => null, writeCache = async () => {}, timeoutMs = 12000 } = {}) {
  const inFlight = new Map();
  let snapshotTask = null;
  let snapshotValue = null, snapshotExpiresAt = 0;
  async function loadSnapshot() {
    if (snapshotValue && Date.now() < snapshotExpiresAt) return snapshotValue;
    if (snapshotTask) return snapshotTask;
    snapshotTask = (async () => {
      const cached = await readCache('__dataset__');
      if (!fetchImpl) return cached?.payload ? { ...cached, status: 'cached-offline' } : null;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(MERAKI_URL, { headers: cached?.etag ? { 'If-None-Match': cached.etag } : {}, signal: controller.signal });
        if (response.status === 304 && cached?.payload) return { ...cached, status: 'not-modified' };
        if (!response.ok) throw new Error(`Meraki HTTP ${response.status}`);
        const payload = await response.json(), retrievedAt = new Date().toISOString();
        const value = { payload, etag: response.headers?.get?.('etag') || '', lastModified: response.headers?.get?.('last-modified') || '', retrievedAt, status: 'fresh' };
        await writeCache('__dataset__', value);
        return value;
      } catch (error) {
        if (cached?.payload) return { ...cached, status: 'cached-stale-or-offline', warning: String(error?.message || 'source unavailable') };
        return { status: controller.signal.aborted ? 'source-timeout' : 'source-error', error: String(error?.message || 'source unavailable') };
      } finally { clearTimeout(timer); }
    })();
    try {
      snapshotValue = await snapshotTask;
      snapshotExpiresAt = Date.now() + (snapshotValue?.payload ? 60 * 60 * 1000 : 60 * 1000);
      return snapshotValue;
    } finally { snapshotTask = null; }
  }
  async function getChampion({ championId, expectedPatch = '', now = () => new Date() } = {}) {
    const id = String(championId || '');
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(id)) throw new Error('Invalid champion ID');
    if (inFlight.has(id)) return inFlight.get(id);
    const work = (async () => {
      const snapshot = await loadSnapshot();
      if (!snapshot?.payload) return { championId: id, status: snapshot?.status || 'source-unavailable', records: [], error: snapshot?.error || '' };
      const profile = normalizeMerakiChampion(snapshot.payload, id, { expectedPatch, fetchedAt: snapshot.retrievedAt || now().toISOString(), lastModified: snapshot.lastModified || '' });
      if (snapshot.status === 'cached-stale-or-offline' && profile.status !== 'champion-not-found') profile.status = 'cached-stale-source';
      return profile;
    })();
    inFlight.set(id, work);
    try { return await work; } finally { inFlight.delete(id); }
  }
  return { source: 'meraki-lolstaticdata', getChampion };
}

module.exports = { MERAKI_URL, createMerakiAdapter, communityDragonAdapter: createCommunityDragonAdapter() };
