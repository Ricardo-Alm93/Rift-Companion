'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { runMayhemLocalDiagnostic } = require('../src/services/mayhem-local-diagnostic.cjs');
const { discoverClientExecutable, readLockfile, requestLcu } = require('../src/services/lcu-draft-client.js');
const { ENDPOINTS, queueInfoFromGameflow } = require('../src/adapters/lcu-champ-select-adapter.js');

async function readLcuSnapshot(ca) {
  const executable = await discoverClientExecutable('win32');
  if (!executable) return { status: 'client-not-detected' };
  const credential = await readLockfile(executable);
  if (!credential) return { status: 'client-detected-lcu-credentials-unavailable' };
  try {
    const phase = await requestLcu({ ...credential, endpoint: ENDPOINTS.phase, ca });
    const summary = { status: 'connected', phase: String(typeof phase === 'string' ? phase : phase?.phase || 'unknown').slice(0, 32) };
    try {
      const gameflow = await requestLcu({ ...credential, endpoint: ENDPOINTS.gameflowSession, ca });
      const queue = queueInfoFromGameflow(gameflow);
      summary.queueId = queue.queueId;
      summary.mode = queue.mode;
      summary.modeVerified = queue.modeVerified;
    } catch (error) { summary.gameflowSessionError = /^LCU_HTTP_\d{3}$/.test(error?.code || '') ? error.code : 'LCU_SESSION_READ_FAILED'; }
    return summary;
  } catch (error) {
    return { status: 'disconnected-or-unavailable', errorCode: /^LCU_HTTP_\d{3}$/.test(error?.code || '') ? error.code : 'LCU_READ_FAILED' };
  }
}

async function main() {
  const ca = await fs.readFile(path.join(__dirname, '../src/adapters/riotgames.pem'));
  const lcu = await readLcuSnapshot(ca);
  const watching = process.argv.includes('--watch');
  const samples = [];
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();
  const outputDir = path.join(__dirname, '../work');
  const outputPath = path.join(outputDir, 'mayhem-local-diagnostic.json');
  let lastSignal = '';
  let previous = null;
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  await fs.mkdir(outputDir, { recursive: true });
  do {
    const currentLcu = watching ? await readLcuSnapshot(ca) : lcu;
    const result = await runMayhemLocalDiagnostic({ ca, lcu: currentLcu });
    const signal = JSON.stringify({
      phase: result.lcu.phase || '', queueId: result.lcu.queueId || null,
      endpointAvailability: result.lcda.endpoints,
      allPlayerAugmentPaths: result.lcda.allGameDataShape?.augmentFieldPaths || [],
      allPlayerAugmentIds: result.lcda.allGameDataShape?.augmentCandidateIdentifiers || [],
      activePlayerAugmentPaths: result.lcda.activePlayerAugmentFieldPaths,
      activePlayerAugmentIds: result.lcda.activePlayerAugmentCandidateIdentifiers || [],
      eventNames: result.lcda.events?.eventNames || [],
      augmentEvents: result.lcda.events?.candidateEvents || []
    });
    if (!samples.length || signal !== lastSignal) {
      const elapsedMs = Date.now() - startedAt;
      const eventNames = result.lcda.events?.eventNames || [];
      const priorEventNames = previous?.lcda.events?.eventNames || [];
      const currentPaths = [...(result.lcda.allGameDataShape?.augmentFieldPaths || []), ...(result.lcda.activePlayerAugmentFieldPaths || [])];
      const previousPaths = [...(previous?.lcda.allGameDataShape?.augmentFieldPaths || []), ...(previous?.lcda.activePlayerAugmentFieldPaths || [])];
      const connectionChanges = Object.entries(result.lcda.endpoints).flatMap(([endpoint, status]) => {
        const before = previous?.lcda.endpoints?.[endpoint];
        return before && JSON.stringify(before) !== JSON.stringify(status) ? [{ endpoint, from: before.ok ? 'connected' : before.code, to: status.ok ? 'connected' : status.code }] : [];
      });
      const phase = result.lcu.phase || 'unknown';
      const transitions = {
        phase: previous && previous.lcu.phase !== phase ? { from: previous.lcu.phase || 'unknown', to: phase } : null,
        gameStartDetected: phase === 'InProgress' && previous?.lcu.phase !== 'InProgress',
        gameEndOrReturnToLobby: ['Lobby', 'None'].includes(phase) && previous?.lcu.phase === 'InProgress',
        lcdaConnectionChanges: connectionChanges,
        newlyAvailableEventNames: eventNames.filter(name => !priorEventNames.includes(name)),
        removedEventNames: priorEventNames.filter(name => !eventNames.includes(name)),
        newlyObservedAugmentFields: currentPaths.filter(name => !previousPaths.includes(name))
      };
      samples.push({ capturedAt: result.capturedAt, elapsedMs, lcu: result.lcu, lcda: result.lcda, transitions });
      if (samples.length > 100) samples.shift();
      lastSignal = signal;
      if (result.lcu.phase === 'InProgress' && !samples.some(sample => sample.lcu.phase === 'InProgress' && sample.gameStartElapsedMs != null)) {
        samples[samples.length - 1].gameStartElapsedMs = elapsedMs;
      }
      previous = result;
    }
    const report = { schemaVersion: 2, diagnostic: 'local-mayhem-interfaces', mode: watching ? 'watch' : 'snapshot', startedAt: startedIso, elapsedMs: Date.now() - startedAt, sampleCount: samples.length, samples };
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (!watching || stopped) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  } while (!stopped);
  process.stdout.write(`Sanitized report updated: ${outputPath}\nSamples: ${samples.length}; watch elapsed: ${Date.now() - startedAt}ms\n`);
}

main().catch(() => {
  process.stderr.write('Mayhem local diagnostic failed before producing a report. No credentials or raw API payloads were logged.\n');
  process.exitCode = 1;
});
