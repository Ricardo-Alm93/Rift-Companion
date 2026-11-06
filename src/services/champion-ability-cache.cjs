'use strict';

const { normalizeChampionAbilityProfile } = require('../domain/champion-abilities');

function championAbilityResource({ version, locale, championId }) {
  const v = String(version || ''), l = String(locale || ''), id = String(championId || '');
  if (!/^\d+\.\d+\.\d+$/.test(v) || !['en_US', 'es_ES'].includes(l) || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id)) throw new Error('Invalid champion detail cache key');
  return `cdn/${v}/data/${l}/champion/${id}.json`;
}

class ChampionAbilityCache {
  constructor({ fetchJson, readCache = async () => null, writeCache = async () => {} } = {}) {
    if (typeof fetchJson !== 'function') throw new TypeError('fetchJson is required');
    this.fetchJson = fetchJson; this.readCache = readCache; this.writeCache = writeCache;
    this.memory = new Map(); this.inFlight = new Map();
  }
  async get({ version, locale, championId }) {
    const resource = championAbilityResource({ version, locale, championId });
    const key = `${version}/${locale}/${championId}`;
    if (this.memory.has(key)) return this.memory.get(key);
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const task = (async () => {
      let profile = await Promise.resolve().then(() => this.readCache({ version, locale, championId })).catch(() => null);
      if (profile?.version !== version || profile?.locale !== locale || profile?.championId !== championId) profile = null;
      if (!profile) {
        const response = await this.fetchJson(resource);
        profile = normalizeChampionAbilityProfile(response, { version, locale, championId, retrievedAt: new Date().toISOString() });
        await Promise.resolve().then(() => this.writeCache({ version, locale, championId }, profile)).catch(() => {});
      }
      this.memory.set(key, profile);
      return profile;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }
  clearMemory() { this.memory.clear(); this.inFlight.clear(); }
}

module.exports = { championAbilityResource, ChampionAbilityCache };
