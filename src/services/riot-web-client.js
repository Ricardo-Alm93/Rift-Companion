const PLATFORM_ROUTES = Object.freeze({
  br1: 'americas', eun1: 'europe', euw1: 'europe', jp1: 'asia', kr: 'asia', la1: 'americas', la2: 'americas', na1: 'americas', oc1: 'sea', ph2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', vn2: 'sea', tr1: 'europe', ru: 'europe'
});

class RiotApiError extends Error {
  constructor(code, status, retryAfterMs = 0) {
    const messages = { not_configured: 'Riot Web API no está configurada.', unauthorized: 'La clave de Riot expiró o no es válida.', forbidden: 'Riot rechazó el acceso para esta clave o endpoint.', not_found: 'Riot no encontró el recurso solicitado.', rate_limited: 'Riot limitó temporalmente las solicitudes.', server_error: 'Riot Web API no está disponible temporalmente.', network_error: 'No se pudo conectar con Riot Web API.' };
    super(messages[code] || 'La solicitud a Riot Web API falló.');
    this.name = 'RiotApiError';
    this.code = code;
    this.status = status || 0;
    this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

class RiotWebClient {
  constructor({ getApiKey = () => process.env.RIOT_API_KEY, fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 10000, cacheTtlMs = 10 * 60 * 1000 } = {}) {
    this.getApiKey = getApiKey;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
    this.calls = new Map();
    this.blockedUntil = new Map();
    this.lastStatus = 'not_checked';
  }

  diagnostics() {
    return { configured: Boolean(String(this.getApiKey() || '').trim()), status: this.lastStatus, cacheEntries: this.cache.size };
  }

  routeFor(platform) {
    const route = PLATFORM_ROUTES[String(platform || '').toLowerCase()];
    if (!route) throw new RiotApiError('network_error');
    return route;
  }

  async platformStatus(platform) {
    this.routeFor(platform);
    return this.request({ host: `${platform}.api.riotgames.com`, path: `/lol/status/v4/platform-data`, bucket: `${platform}:status`, ttlMs: 60_000 });
  }

  async accountByRiotId(gameName, tagLine, platform) {
    const route = this.routeFor(platform);
    const name = String(gameName || '').trim(), tag = String(tagLine || '').trim();
    if (!name || !tag || name.length > 64 || tag.length > 16) throw new RiotApiError('network_error');
    const key = `account:${route}:${name.toLocaleLowerCase()}:${tag.toLocaleLowerCase()}`;
    return this.request({ host: `${route}.api.riotgames.com`, path: `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, bucket: `${route}:account-v1:by-riot-id`, cacheKey: key });
  }

  async matchIds(puuid, platform, { start = 0, count = 5 } = {}) {
    const route = this.routeFor(platform), safeId = String(puuid || '');
    if (!/^[\w-]{10,100}$/.test(safeId)) throw new RiotApiError('network_error');
    const boundedCount = Math.max(1, Math.min(10, Math.trunc(Number(count) || 5)));
    const boundedStart = Math.max(0, Math.min(100, Math.trunc(Number(start) || 0)));
    return this.request({ host: `${route}.api.riotgames.com`, path: `/lol/match/v5/matches/by-puuid/${encodeURIComponent(safeId)}/ids?start=${boundedStart}&count=${boundedCount}`, bucket: `${route}:match-v5:ids`, cacheKey: `matches:${route}:${safeId}:${boundedStart}:${boundedCount}` });
  }

  async match(matchId, platform) {
    const route = this.routeFor(platform), id = String(matchId || '');
    if (!/^[A-Z0-9]{2,8}_\d{5,20}$/i.test(id)) throw new RiotApiError('network_error');
    return this.request({ host: `${route}.api.riotgames.com`, path: `/lol/match/v5/matches/${encodeURIComponent(id)}`, bucket: `${route}:match-v5:match`, cacheKey: `match:${route}:${id}`, ttlMs: 24 * 60 * 60 * 1000 });
  }

  async request({ host, path, bucket, cacheKey = '', ttlMs = this.cacheTtlMs }) {
    const apiKey = String(this.getApiKey() || '').trim();
    if (!apiKey) { this.lastStatus = 'not_configured'; throw new RiotApiError('not_configured'); }
    if (!/^[a-z0-9-]+\.api\.riotgames\.com$/i.test(host) || !path.startsWith('/') || path.startsWith('//')) throw new RiotApiError('network_error');
    const cached = cacheKey && this.cache.get(cacheKey);
    if (cached && this.now() - cached.at < ttlMs) { this.lastStatus = 'available_cached'; return structuredClone(cached.value); }
    const regionBucket = bucket.split(':')[0];
    const blockedUntil = Math.max(this.blockedUntil.get(bucket) || 0, this.blockedUntil.get(`${regionBucket}:application`) || 0);
    if (blockedUntil > this.now()) { this.lastStatus = 'rate_limited'; throw new RiotApiError('rate_limited', 429, blockedUntil - this.now()); }
    await this.waitForWindow(`${regionBucket}:application`);
    await this.waitForWindow(bucket);
    let response;
    try {
      response = await this.fetchImpl(`https://${host}${path}`, { method: 'GET', headers: { 'X-Riot-Token': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch { this.lastStatus = 'unavailable'; throw new RiotApiError('network_error'); }
    if (!response.ok) {
      const status = response.status;
      let code = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : 'network_error';
      const retryHeader = Number(response.headers?.get?.('retry-after'));
      const retryAfterMs = status === 429 ? (Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : 1000) : 0;
      if (status === 429) {
        this.blockedUntil.set(bucket, this.now() + retryAfterMs);
        this.blockedUntil.set(`${regionBucket}:application`, this.now() + retryAfterMs);
      }
      this.lastStatus = status === 401 ? 'expired_or_invalid' : status === 403 ? 'rejected' : status === 429 ? 'rate_limited' : status >= 500 ? 'unavailable' : 'error';
      throw new RiotApiError(code, status, retryAfterMs);
    }
    let data;
    try { data = await response.json(); } catch { this.lastStatus = 'error'; throw new RiotApiError('server_error', response.status); }
    this.lastStatus = 'available';
    if (cacheKey) this.cache.set(cacheKey, { at: this.now(), value: structuredClone(data) });
    return data;
  }

  async waitForWindow(bucket) {
    const now = this.now(), calls = (this.calls.get(bucket) || []).filter(at => at > now - 120_000);
    let slot = Math.max(now, calls.at(-1) || now);
    while (true) {
      const withinTwoMinutes = calls.filter(at => at > slot - 120_000 && at <= slot);
      if (withinTwoMinutes.length >= 100) { slot = withinTwoMinutes[0] + 120_000; continue; }
      if (bucket.endsWith(':application')) {
        const withinOneSecond = calls.filter(at => at > slot - 1_000 && at <= slot);
        if (withinOneSecond.length >= 20) { slot = withinOneSecond[0] + 1_000; continue; }
      }
      break;
    }
    calls.push(slot); calls.sort((a, b) => a - b); this.calls.set(bucket, calls);
    if (slot > now) await this.sleep(slot - now);
  }
}

module.exports = { RiotWebClient, RiotApiError, PLATFORM_ROUTES };
