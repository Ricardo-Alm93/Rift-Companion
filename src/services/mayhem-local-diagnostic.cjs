'use strict';

// One-shot, read-only diagnostic for the documented Live Client Data routes.
// It deliberately inspects only the local active player plus event names.
const https = require('node:https');
const { ENDPOINTS: LCU_ENDPOINTS } = require('../adapters/lcu-champ-select-adapter');
const LCDA_ENDPOINTS = Object.freeze({
  allGameData: '/liveclientdata/allgamedata',
  eventData: '/liveclientdata/eventdata',
  activePlayer: '/liveclientdata/activeplayer'
});

const AUGMENT_FIELD = /augment/i;
const safeError = error => {
  const code = String(error?.code || '');
  if (/^(?:LCU_HTTP|MAYHEM_DIAG_HTTP)_\d{3}$/.test(code) || /^MAYHEM_DIAG_(?:ENDPOINT_NOT_ALLOWED|RESPONSE_TOO_LARGE|INVALID_JSON|TIMEOUT|CONNECTION_FAILED)$/.test(code)) return code;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) return 'MAYHEM_DIAG_CONNECTION_FAILED';
  if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)) return 'MAYHEM_DIAG_TLS_VALIDATION_FAILED';
  return 'MAYHEM_DIAG_TLS_OR_CONNECTION_FAILED';
};

function requestLoopback({ endpoint, allowed, port = 2999, ca, password, timeoutMs = 2500, requestImpl = https.request }) {
  if (!allowed.includes(endpoint)) return Promise.reject(Object.assign(new Error('invalid endpoint'), { code: 'MAYHEM_DIAG_ENDPOINT_NOT_ALLOWED' }));
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (password) headers.Authorization = `Basic ${Buffer.from(`riot:${password}`, 'utf8').toString('base64')}`;
    let req;
    try {
      req = requestImpl({ hostname: '127.0.0.1', servername: 'localhost', port, path: endpoint, method: 'GET', ca, rejectUnauthorized: true, headers, timeout: timeoutMs, agent: false }, res => {
        const chunks = []; let length = 0;
        res.on('data', chunk => { length += chunk.length; if (length > 2_000_000) { req.destroy(Object.assign(new Error('too large'), { code: 'MAYHEM_DIAG_RESPONSE_TOO_LARGE' })); return; } chunks.push(chunk); });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(new Error('http error'), { code: `MAYHEM_DIAG_HTTP_${res.statusCode}` }));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(Object.assign(new Error('invalid JSON'), { code: 'MAYHEM_DIAG_INVALID_JSON' })); }
        });
      });
    } catch { return reject(Object.assign(new Error('request failed'), { code: 'MAYHEM_DIAG_CONNECTION_FAILED' })); }
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'MAYHEM_DIAG_TIMEOUT' })));
    req.on('error', error => reject(Object.assign(new Error('request failed'), { code: safeError(error) })));
    req.end();
  });
}

function fieldPaths(object, { maxDepth = 5, maxFields = 300 } = {}) {
  const found = []; let visited = 0;
  function walk(value, path, depth) {
    if (!value || typeof value !== 'object' || depth > maxDepth || visited >= maxFields) return;
    for (const [key, entry] of Object.entries(value)) {
      if (++visited > maxFields) break;
      const current = path ? `${path}.${key}` : key;
      if (AUGMENT_FIELD.test(key)) found.push(current);
      if (entry && typeof entry === 'object') walk(entry, current, depth + 1);
    }
  }
  walk(object, '', 0);
  return [...new Set(found)].slice(0, 40);
}

function augmentFieldEvidence(object) {
  const paths = fieldPaths(object);
  const identifiers = [];
  let visited = 0;
  function walk(value, path, underAugment, depth) {
    if (!value || typeof value !== 'object' || depth > 6 || visited > 400) return;
    for (const [key, entry] of Object.entries(value)) {
      if (++visited > 400) break;
      if (/^(?:allplayers|players)$/i.test(key.replace(/[^a-z]/gi, ''))) continue;
      const current = path ? `${path}.${key}` : key;
      const relevant = underAugment || AUGMENT_FIELD.test(key);
      if (relevant && /^(?:id|augmentid|name|slug)$/i.test(key) && ['string', 'number'].includes(typeof entry)) {
        const text = String(entry).trim();
        if (text && text.length <= 96 && /^[A-Za-z0-9_ .'-]+$/.test(text)) identifiers.push({ path: current, value: text });
      } else if (AUGMENT_FIELD.test(key) && ['string', 'number'].includes(typeof entry)) {
        const text = String(entry).trim();
        if (text && text.length <= 96 && /^[A-Za-z0-9_ .'-]+$/.test(text)) identifiers.push({ path: current, value: text });
      }
      if (entry && typeof entry === 'object') walk(entry, current, relevant, depth + 1);
    }
  }
  walk(object, '', false, 0);
  const unique = new Map(identifiers.map(row => [`${row.path}\u0000${row.value}`, row]));
  return { fieldPaths: paths, candidateIdentifiers: [...unique.values()].slice(0, 40) };
}

function eventSummary(value) {
  const rows = Array.isArray(value?.Events) ? value.Events : Array.isArray(value?.events) ? value.events : [];
  const safeRows = rows.map(row => ({ name: String(row?.EventName || row?.name || ''), id: Number(row?.EventID ?? row?.id), time: Number(row?.EventTime ?? row?.time) })).filter(row => /^[A-Za-z][A-Za-z0-9_ -]{0,48}$/.test(row.name));
  const names = safeRows.map(row => row.name);
  const augmentNamed = [...new Set(names.filter(name => AUGMENT_FIELD.test(name)))];
  const candidateEvents = safeRows.filter(row => AUGMENT_FIELD.test(row.name)).map(row => ({ eventName: row.name, eventId: Number.isSafeInteger(row.id) && row.id >= 0 ? row.id : null, eventTime: Number.isFinite(row.time) && row.time >= 0 ? row.time : null })).slice(-40);
  return { count: rows.length, eventNames: [...new Set(names)].slice(-80), augmentNamedEvents: augmentNamed, candidateEvents };
}

function summarizeLcda(responses) {
  const all = responses.allGameData?.ok ? responses.allGameData.value : null;
  const own = all?.activePlayer && typeof all.activePlayer === 'object' ? all.activePlayer : {};
  const game = all?.gameData && typeof all.gameData === 'object' ? all.gameData : {};
  const allAugmentEvidence = all ? augmentFieldEvidence({ activePlayer: own, gameData: game }) : { fieldPaths: [], candidateIdentifiers: [] };
  const activePlayerEvidence = responses.activePlayer?.ok ? augmentFieldEvidence(responses.activePlayer.value) : { fieldPaths: [], candidateIdentifiers: [] };
  return {
    endpoints: Object.fromEntries(Object.entries(responses).map(([name, result]) => [name, result?.ok ? { ok: true } : { ok: false, code: result?.code || 'MAYHEM_DIAG_READ_FAILED' }])),
    allGameDataShape: !all ? null : {
      topLevelFields: Object.keys(all || {}).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)).slice(0, 40),
      playerCount: Array.isArray(all?.allPlayers) ? all.allPlayers.length : null,
      ownActivePlayerFields: Object.keys(own).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)).slice(0, 60),
      gameMode: typeof game.gameMode === 'string' ? game.gameMode.slice(0, 40) : null,
      mapNumber: Number.isSafeInteger(Number(game.mapNumber)) ? Number(game.mapNumber) : null,
      augmentFieldPaths: allAugmentEvidence.fieldPaths,
      augmentCandidateIdentifiers: allAugmentEvidence.candidateIdentifiers
    },
    activePlayerAugmentFieldPaths: activePlayerEvidence.fieldPaths,
    activePlayerAugmentCandidateIdentifiers: activePlayerEvidence.candidateIdentifiers,
    events: responses.eventData?.ok ? eventSummary(responses.eventData.value) : null,
    conclusion: 'No se infiere una selección de aumento a partir de ausencia de campos. Solo una ruta/campo de aumento o evento explícito observado sería una señal candidata; requiere validación real en Mayhem.'
  };
}

async function runMayhemLocalDiagnostic({ ca, lcu = null, request = requestLoopback, now = () => new Date().toISOString() } = {}) {
  const entries = await Promise.all(Object.entries(LCDA_ENDPOINTS).map(async ([name, endpoint]) => {
    try { return [name, { ok: true, value: await request({ endpoint, allowed: Object.values(LCDA_ENDPOINTS), ca }) }]; }
    catch (error) { return [name, { ok: false, code: safeError(error) }]; }
  }));
  const responseMap = Object.fromEntries(entries);
  const result = { schemaVersion: 1, capturedAt: now(), scope: 'local-read-only-snapshot', lcu: lcu || { status: 'not-queried' }, lcda: summarizeLcda(responseMap) };
  return result;
}

module.exports = { LCDA_ENDPOINTS, requestLoopback, fieldPaths, augmentFieldEvidence, eventSummary, summarizeLcda, runMayhemLocalDiagnostic, LCU_ENDPOINTS };
