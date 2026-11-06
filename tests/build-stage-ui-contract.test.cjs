'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Ranked stage selection travels through the validated Electron bridge and updates one shared build', () => {
  const app=read('src/app.js'),overlay=read('src/overlay.js'),main=read('src/main.js'),preload=read('src/preload.js');
  assert.match(app,/function selectRankedScenario/);assert.match(app,/onOverlayBuildChoice/);
  assert.match(preload,/overlay:build-choice/);assert.match(main,/['standard','lane','team']/);
  assert.match(overlay,/data-ranked-scenario/);assert.match(overlay,/data-ranked-variant/);
  assert.doesNotMatch(overlay,/function rankedStagePlanHtml/);assert.doesNotMatch(app,/section.className='engine-stage-plan'/);
});

test('Ranked overlay muestra solo la guía compacta y conserva habilidades detalladas en la app principal', () => {
  const overlay = read('src/overlay.js');
  const app = read('src/app.js');
  const rankedStart = overlay.lastIndexOf('return `<div class="overlay-mode-title">${label}</div><div class="overlay-champ">');
  const rankedEnd = overlay.indexOf('}function stripOverlayCompetitiveRates', rankedStart);
  assert.ok(rankedStart >= 0 && rankedEnd > rankedStart, 'Ranked template is identifiable');
  const rankedMarkup = overlay.slice(rankedStart, rankedEnd);
  assert.doesNotMatch(rankedMarkup, /renderRankedTabs|overlay-ranked-view-tabs|ORDEN DE HABILIDADES|overlay-summoner-list|skillGrid\(|summonerSpellCards\(/);
  assert.match(rankedMarkup, /overlay-selected-build/);
  assert.match(rankedMarkup, /overlay-route-comparison/);
  assert.match(rankedMarkup, /overlay-selected-fit/);
  assert.match(app, /skill-grid|skill-order|skill-priority/i, 'skills remain available in the main study view');
});
