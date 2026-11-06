'use strict';

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const { ENDPOINTS, fromSession, queueInfoFromGameflow } = require('../adapters/lcu-champ-select-adapter');
const execFileAsync = promisify(execFile);

async function discoverClientExecutable(platform = process.platform) {
  if (platform !== 'win32') return '';
  const script = "$p=Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath; if($p){[Console]::Out.Write($p)}";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 4500, maxBuffer: 4096 });
    const value = String(stdout || '').trim();
    return path.basename(value).toLowerCase() === 'leagueclientux.exe' ? value : '';
  } catch { return ''; }
}

async function readLockfile(executablePath, readFile = fs.readFile) {
  if (!executablePath || path.basename(executablePath).toLowerCase() !== 'leagueclientux.exe') return null;
  const base = path.dirname(executablePath), candidates = [path.join(base, 'lockfile'), path.join(path.dirname(base), 'lockfile')];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate); if (!stat.isFile() || stat.size > 2048) continue;
      const text = String(await readFile(candidate, 'utf8')).trim(), fields = text.split(':');
      if (fields.length < 5 || !/^LeagueClient(?:Ux)?$/i.test(fields[0])) continue;
      const pid = Number(fields[1]), port = Number(fields[2]), password = fields[3], protocol = fields[4];
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535 || !password || password.length > 256 || protocol.toLowerCase() !== 'https') continue;
      return { pid, port, password };
    } catch { /* Try the other adjacent install location without revealing file errors. */ }
  }
  return null;
}

function requestLcu({ port, password, endpoint, ca, timeoutMs = 2500, requestImpl = https.request }) {
  if (!Object.values(ENDPOINTS).includes(endpoint) || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(Object.assign(new Error('invalid-request'), { code: 'LCU_INVALID_REQUEST' }));
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`riot:${password}`, 'utf8').toString('base64');
    const req = requestImpl({ hostname: '127.0.0.1', servername: 'localhost', port, path: endpoint, method: 'GET', ca, rejectUnauthorized: true, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }, timeout: timeoutMs, agent: false }, res => {
      const chunks = []; let length = 0;
      res.on('data', chunk => { length += chunk.length; if (length > 2_000_000) { req.destroy(Object.assign(new Error('response-too-large'), { code: 'LCU_RESPONSE_TOO_LARGE' })); return; } chunks.push(chunk); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(new Error('lcu-http-error'), { code: `LCU_HTTP_${res.statusCode}` }));
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('lcu-timeout'), { code: 'LCU_TIMEOUT' })));
    req.on('error', error => reject(Object.assign(new Error('lcu-request-failed'), { code: error?.code === 'LCU_TIMEOUT' || error?.code === 'LCU_RESPONSE_TOO_LARGE' ? error.code : 'LCU_TLS_OR_CONNECTION_FAILED' })));
    req.end();
  });
}

class LcuDraftClient extends EventEmitter {
  constructor({ championByKey = {}, championByName = {}, liveClient = null, caPath = path.join(__dirname, '..', 'adapters', 'riotgames.pem'), discover = discoverClientExecutable, readCredential = readLockfile, request = requestLcu, pollMs = 1500, now = () => new Date().toISOString(), platform = process.platform } = {}) {
    super(); this.championByKey = championByKey; this.championByName = championByName; this.liveClient = liveClient; this.caPath = caPath; this.discover = discover; this.readCredential = readCredential; this.request = request; this.pollMs = pollMs; this.now = now; this.platform = platform;
    this.enabled = false; this.timer = null; this.busy = false; this.generation = 0; this.identity = ''; this.draftSessionId = ''; this.version = 0; this.rosterKey = ''; this.failures = 0;
    this.clientDetected = null; this.lcuConnected = false; this.phase = ''; this.lastUpdatedAt = ''; this.lastErrorCode = ''; this.lastCompletedRoster = null; this.diagnosticLog = [];
    this.queueInfo = { queueId: null, mode: 'unknown', modeVerified: false }; this.queueReadAt = 0;
    this.liveStatus = 'idle'; this.liveRoster = null; this.liveParticipants = []; this.liveErrorCode = ''; this.liveAttempts = 0; this.nextLiveAttemptAt = 0; this.lastManualLiveAt = 0; this.liveSessionId = ''; this.manualLivePlayerIndex = null;
    this.currentRoster = null; this.state = { status: 'integration_disabled', source: 'lcu', roster: null };
  }
  getState() {
    const state = structuredClone(this.state), roster = state.roster || state.retainedRoster || this.lastCompletedRoster;
    return { ...state, enabled: this.enabled, retainedRoster: structuredClone(this.lastCompletedRoster), liveRoster: structuredClone(this.liveRoster), liveParticipants: structuredClone(this.liveParticipants), diagnostics: { clientDetected: this.clientDetected, lcuConnected: this.lcuConnected, liveClientStatus: this.liveStatus, liveAttempts: this.liveAttempts, phase: this.phase, queueId: this.queueInfo.queueId, queueMode: this.queueInfo.mode, queueModeVerified: this.queueInfo.modeVerified, playerChampionId: roster?.player?.championId || '', playerStatus: roster?.player?.status || 'unknown', alliesConfirmed: (roster?.allies || []).filter(row => row.confirmed && row.championId).length, enemiesVisibleConfirmed: (roster?.enemies || []).filter(row => row.visible && row.confirmed && row.championId).length, lastUpdatedAt: this.lastUpdatedAt || roster?.updatedAt || '', errorCode: this.lastErrorCode, liveErrorCode: this.liveErrorCode, log: structuredClone(this.diagnosticLog) } };
  }
  setEnabled(value) {
    const enabled = value === true;
    if (enabled === this.enabled) return this.getState();
    this.enabled = enabled; this.generation++; clearTimeout(this.timer); this.timer = null; this.identity = ''; this.draftSessionId = ''; this.version = 0; this.rosterKey = ''; this.failures = 0; this.phase = ''; this.lastErrorCode = ''; this.queueInfo = { queueId: null, mode: 'unknown', modeVerified: false }; this.queueReadAt = 0;
    if (!enabled) { this.clientDetected = null; this.lcuConnected = false; this.lastUpdatedAt = ''; this.publish({ status: 'integration_disabled', source: 'lcu', roster: null, retainedRoster: this.lastCompletedRoster }); return this.getState(); }
    this.clientDetected = null; this.lcuConnected = false; this.lastUpdatedAt = '';
    this.publish({ status: 'searching_client', source: 'lcu', roster: null }); this.schedule(0, this.generation); return this.getState();
  }
  stop() { this.enabled = false; this.generation++; clearTimeout(this.timer); this.timer = null; this.busy = false; }
  schedule(delay, generation) { if (!this.enabled || generation !== this.generation) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.poll(generation), delay); this.timer.unref?.(); }
  async poll(generation = this.generation) {
    if (!this.enabled || generation !== this.generation) return;
    if (this.busy) { this.schedule(this.pollMs, generation); return; }
    this.busy = true; let delay = this.pollMs, phaseRead = false;
    try {
      if (this.platform !== 'win32') { this.clientDetected = false; this.lcuConnected = false; this.phase = ''; this.publish({ status: 'unsupported_platform', source: 'lcu', roster: null }); delay = 10000; return; }
      const executable = await this.discover(this.platform);
      if (!this.enabled || generation !== this.generation) return;
      if (!executable) { this.clientDetected = false; this.lcuConnected = false; this.phase = ''; this.lastErrorCode = ''; this.resetDraft(); this.publish({ status: 'client_not_found', source: 'lcu', roster: null, retainedRoster: this.lastCompletedRoster }); this.failures = 0; delay = 3000; return; }
      this.clientDetected = true;
      const credential = await this.readCredential(executable);
      if (!credential) { this.lcuConnected = false; this.phase = ''; this.lastErrorCode = ''; this.resetDraft(); this.publish({ status: 'client_detected', source: 'lcu', roster: null, retainedRoster: this.lastCompletedRoster }); this.failures = Math.min(this.failures + 1, 4); delay = Math.min(10000, this.pollMs * (2 ** this.failures)); return; }
      const identity = `${credential.pid}:${credential.port}`;
      if (identity !== this.identity) { this.identity = identity; this.resetDraft(); this.resetLiveSnapshot(); this.queueInfo = { queueId: null, mode: 'unknown', modeVerified: false }; this.queueReadAt = 0; this.publish({ status: 'client_detected', phase: 'connecting', source: 'lcu', roster: null }); }
      const ca = await fs.readFile(this.caPath);
      const phasePayload = await this.request({ port: credential.port, password: credential.password, endpoint: ENDPOINTS.phase, ca });
      if (!this.enabled || generation !== this.generation) return;
      phaseRead = true; this.lcuConnected = true; this.lastErrorCode = ''; this.lastUpdatedAt = this.now();
      const phase = typeof phasePayload === 'string' ? phasePayload : String(phasePayload?.phase || '');
      const priorPhase = this.phase;
      this.phase = phase;
      if (phase !== priorPhase) this.recordDiagnostic('phase_transition', { from: priorPhase || 'unknown', to: phase || 'unknown' });
      if (phase === 'ChampSelect' || phase === 'InProgress') {
        if (phase !== priorPhase || (!this.queueInfo.modeVerified && Date.now() - this.queueReadAt >= 15000)) await this.refreshQueueInfo(credential, ca);
      } else if (phase === 'Lobby' || phase === 'None') {
        this.queueInfo = { queueId: null, mode: 'unknown', modeVerified: false }; this.queueReadAt = 0;
      }
      if (phase !== 'ChampSelect') {
        const complete = this.state.roster?.confirmed === true ? structuredClone(this.state.roster) : null;
        if (complete) this.lastCompletedRoster = complete;
        else if (priorPhase === 'ChampSelect') this.lastCompletedRoster = null;
        this.resetDraft(); this.failures = 0; delay = 3000;
        if (phase === 'InProgress' && this.liveClient && !this.liveRoster && this.liveStatus !== 'identity_unresolved') {
          const result = await this.tryReadLiveClient(generation, ca);
          if (result === 'retry') delay = this.liveRetryDelay();
          else delay = 3000;
        } else if (phase === 'InProgress' && this.liveRoster) this.liveStatus = 'snapshot_ready';
        else if (phase !== 'InProgress' && priorPhase === 'InProgress') this.resetLiveSnapshot();
        const status = phase === 'InProgress' ? (this.liveRoster ? 'live_snapshot' : this.liveStatus === 'identity_unresolved' ? 'live_identity_unresolved' : 'live_waiting') : 'client_connected';
        this.publish({ status, phase: phase || 'unknown', source: this.liveRoster ? 'live_client' : 'lcu', roster: this.liveRoster, retainedRoster: this.lastCompletedRoster, liveParticipants: this.liveParticipants }); return;
      }
      if (phase !== priorPhase) { this.lastCompletedRoster = null; this.resetDraft(); this.publish({ status: 'client_connected', phase, source: 'lcu', roster: null, retainedRoster: null }); }
      const session = await this.request({ port: credential.port, password: credential.password, endpoint: ENDPOINTS.session, ca });
      if (!this.enabled || generation !== this.generation) return;
      this.lastUpdatedAt = this.now();
      if (!this.draftSessionId) this.draftSessionId = crypto.randomUUID();
      const candidate = fromSession({ phase, session, championByKey: this.championByKey, draftSessionId: this.draftSessionId, version: this.version + 1, updatedAt: this.now(), queueInfo: this.queueInfo });
      const comparison = { ...candidate, version: 0, updatedAt: '' }, key = JSON.stringify(comparison);
      if (key !== this.rosterKey) { this.version++; this.rosterKey = key; candidate.version = this.version; candidate.updatedAt = this.now(); this.currentRoster = structuredClone(candidate); this.recordDiagnostic('roster_changed', { roster: candidate }); this.publish({ status: 'draft_detected', phase, source: 'lcu', roster: candidate, retainedRoster: null }); }
      this.failures = 0;
    } catch (error) {
      if (generation === this.generation && this.enabled) { this.lastErrorCode = safeLcuErrorCode(error); if (!phaseRead) this.lcuConnected = false; this.failures = Math.min(this.failures + 1, 5); delay = Math.min(15000, this.pollMs * (2 ** this.failures)); this.recordDiagnostic('read_error', { errorCode: this.lastErrorCode }); this.publish({ status: 'read_error', phase: this.phase || 'unknown', source: 'lcu', roster: this.currentRoster, retainedRoster: this.lastCompletedRoster }); }
    } finally {
      this.busy = false;
      if (this.enabled && generation === this.generation) this.schedule(delay, generation);
    }
  }
  resetDraft() { this.draftSessionId = ''; this.version = 0; this.rosterKey = ''; this.currentRoster = null; }
  async refreshQueueInfo(credential, ca) {
    this.queueReadAt = Date.now();
    try { const payload = await this.request({ port: credential.port, password: credential.password, endpoint: ENDPOINTS.gameflowSession, ca }); this.queueInfo = queueInfoFromGameflow(payload); }
    catch { this.queueInfo = { queueId: null, mode: 'unknown', modeVerified: false }; }
    return this.queueInfo;
  }
  liveRetryDelay() { return Math.min(15000, 2000 * (2 ** Math.max(0, this.liveAttempts - 1))); }
  resetLiveSnapshot() { this.liveStatus = 'idle'; this.liveRoster = null; this.liveParticipants = []; this.liveErrorCode = ''; this.liveAttempts = 0; this.nextLiveAttemptAt = 0; this.lastManualLiveAt = 0; this.liveSessionId = ''; this.manualLivePlayerIndex = null; }
  async tryReadLiveClient(generation = this.generation, ca = null, { manual = false, manualPlayerIndex = null } = {}) {
    if (!this.enabled || generation !== this.generation || !this.liveClient) return 'unavailable';
    if (this.liveRoster && !manual) return 'ready';
    const nowMs = Date.now();
    const explicitIdentity = Number.isInteger(manualPlayerIndex) && manualPlayerIndex >= 0 && manualPlayerIndex < 10;
    if (manual && !explicitIdentity && nowMs - this.lastManualLiveAt < 15000) { this.liveErrorCode = 'LIVE_CLIENT_REFRESH_THROTTLED'; return 'throttled'; }
    if (!manual && (this.liveAttempts >= 5 || nowMs < this.nextLiveAttemptAt)) return 'exhausted';
    if (manual) this.lastManualLiveAt = nowMs; else { this.liveAttempts++; this.nextLiveAttemptAt = nowMs + this.liveRetryDelay(); }
    this.liveStatus = 'connecting'; this.liveErrorCode = '';
    try {
      const cert = ca || await fs.readFile(this.caPath);
      const selectedIndex = manualPlayerIndex ?? this.manualLivePlayerIndex;
      const roster = await this.liveClient.read({ championByName: this.championByName, sessionId: this.liveSessionId || (this.liveSessionId = crypto.randomUUID()), revision: (this.liveRoster?.revision || 0) + 1, manualPlayerIndex: selectedIndex });
      if (!this.enabled || generation !== this.generation || this.phase !== 'InProgress') return 'stale';
      const snapshot = { ...roster, ...this.queueInfo };
      this.liveRoster = roster.status === 'ready' ? snapshot : null; this.liveParticipants = roster.participants || []; this.liveStatus = roster.status === 'identity_unresolved' ? 'identity_unresolved' : 'snapshot_ready'; this.liveErrorCode = ''; if (explicitIdentity && roster.status === 'ready') this.manualLivePlayerIndex = manualPlayerIndex;
      this.lastUpdatedAt = this.now(); this.recordDiagnostic('live_snapshot', { roster });
      return this.liveRoster ? 'ready' : 'identity_unresolved';
    } catch (error) {
      this.liveErrorCode = safeLiveErrorCode(error); this.liveStatus = 'waiting'; this.recordDiagnostic('live_read_error', { errorCode: this.liveErrorCode });
      return 'retry';
    }
  }
  async refreshLiveSnapshot({ manualPlayerIndex = null } = {}) {
    if (!this.enabled || this.phase !== 'InProgress') return this.getState();
    const generation = this.generation, ca = await fs.readFile(this.caPath);
    await this.tryReadLiveClient(generation, ca, { manual: true, manualPlayerIndex });
    const status = this.liveRoster ? 'live_snapshot' : this.liveStatus === 'identity_unresolved' ? 'live_identity_unresolved' : 'live_waiting';
    this.publish({ status, phase: this.phase, source: this.liveRoster ? 'live_client' : 'lcu', roster: this.liveRoster, retainedRoster: this.lastCompletedRoster, liveParticipants: this.liveParticipants });
    return this.getState();
  }
  recordDiagnostic(event, details = {}) {
    const roster = details.roster || this.state.roster || this.lastCompletedRoster, safePhase = String(details.to || this.phase || '').slice(0, 24);
    const entry = { at: String(this.now()), event: String(event).slice(0, 32), phase: safePhase, from: details.from ? String(details.from).slice(0, 24) : undefined, to: details.to ? String(details.to).slice(0, 24) : undefined, ownStatus: ['intent','hovered','locked','unknown'].includes(roster?.player?.status) ? roster.player.status : 'unknown', alliesKnown: (roster?.allies || []).filter(row => row.championId).length, alliesConfirmed: (roster?.allies || []).filter(row => row.confirmed && row.championId).length, enemiesVisible: (roster?.enemies || []).filter(row => row.visible && row.championId).length, enemiesConfirmed: (roster?.enemies || []).filter(row => row.visible && row.confirmed && row.championId).length, errorCode: String(details.errorCode || '').slice(0, 32) };
    this.diagnosticLog.push(entry); if (this.diagnosticLog.length > 60) this.diagnosticLog.splice(0, this.diagnosticLog.length - 60);
  }
  publish(state) {
    const key = JSON.stringify(state), old = JSON.stringify(this.state);
    if (key === old) return;
    if (state.status !== this.state.status) this.recordDiagnostic(`status_${state.status}`, { roster: state.roster || state.retainedRoster });
    this.state = structuredClone(state); this.emit('state', this.getState());
  }
}

module.exports = { discoverClientExecutable, readLockfile, requestLcu, LcuDraftClient };

function safeLcuErrorCode(error) {
  const code = String(error?.code || '');
  if (/^LCU_HTTP_(?:401|403|404|429|500|502|503|504)$/.test(code)) return code;
  if (code === 'LCU_TIMEOUT') return code;
  if (code === 'LCU_RESPONSE_TOO_LARGE') return code;
  if (code === 'LCU_TLS_OR_CONNECTION_FAILED') return code;
  return 'LCU_READ_FAILED';
}

function safeLiveErrorCode(error) {
  const code = String(error?.code || '');
  if (/^LIVE_CLIENT_HTTP_(?:401|403|404|429|500|502|503|504)$/.test(code)) return code;
  if (['LIVE_CLIENT_TIMEOUT', 'LIVE_CLIENT_RESPONSE_TOO_LARGE', 'LIVE_CLIENT_INVALID_RESPONSE', 'LIVE_CLIENT_REFRESH_THROTTLED'].includes(code)) return code;
  if (code === 'LIVE_CLIENT_TLS_OR_CONNECTION_FAILED' || code === 'LIVE_CLIENT_CONNECTION_FAILED') return code;
  return 'LIVE_CLIENT_READ_FAILED';
}
