'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('LCU roster diagnostics stay compact until the user opens the disclosure',()=>{
  const html=read('src/index.html'),app=read('src/app.js'),css=read('src/meta.css');
  assert.match(html,/<details id="draft-roster-details" class="draft-roster-details">/);
  assert.match(html,/<summary>Detalles de roster y diagnóstico<\/summary><div class="lcu-diagnostics"/);
  assert.match(app,/state\.enabled&&rosterDetails\.dataset\.userClosed!=='true'\)rosterDetails\.open=true/);
  assert.match(css,/\.draft-roster-panel\{padding:9px 12px!important/);
});

test('tooltip surfaces scroll internally with invisible local scrollbars',()=>{
  const css=read('src/meta.css'),windowCss=read('src/tooltip-window.css'),renderer=read('src/tooltip.js'),app=read('src/app.js');
  for(const selector of ['.tooltip-scroll-content','.build-item-tooltip','.rune-tooltip','.aram-augment-tooltip'])assert.ok(css.includes(selector));
  assert.match(css,/scrollbar-width:none/);
  assert.match(css,/::-webkit-scrollbar[^}]*display:none/);
  assert.match(windowCss,/\.tooltip-scroll-content\{[^}]*overflow-y:auto/);
  assert.match(windowCss,/max-height:min\(84dvh,calc\(100dvh - 18px\)\)/);
  assert.match(renderer,/tabindex="0" role="region"/);
  assert.match(renderer,/contentHeight\+24/);
  assert.match(app,/tooltip\.classList\.add\('tooltip-scroll-content'\);tooltip\.tabIndex=0/);
});

test('Ranked overlay limits visible variants and offers full label access',()=>{
  const overlay=read('src/overlay.js'),app=read('src/app.js'),main=read('src/main.js'),css=read('src/meta.css');
  assert.match(overlay,/visible=rows\.slice\(0,3\),extra=rows\.slice\(3\)/);
  assert.match(overlay,/title="'\+esc\(row\.label\)\+'" aria-label="'\+esc\(row\.label\)/);
  assert.match(app,/title="'\+escapeHtml\(option\.label\|\|text\('Alternativa','Alternative'\)\)\+'" aria-label/);
  assert.match(overlay,/class="overlay-fit-more"/);
  assert.match(css,/\.overlay-selected-build \.overlay-selected-fit>p\{[^}]*-webkit-line-clamp:3/);
  assert.match(css,/\.overlay-more-variants>summary/);
  assert.match(main,/width: 430, height: 620, minWidth: 360, minHeight: 420, resizable: true/);
});

test('Ranked and Mayhem overlays hide scrollbar chrome while keeping content scrollable',()=>{
  const css=read('src/overlay-drag.css'),renderer=read('src/overlay.js');
  for(const selector of ['.overlay-body','.overlay-inner','.overlay-mayhem-pane','.overlay-champion-results','.overlay-augment-search-results'])assert.ok(css.includes(selector));
  assert.match(css,/\.overlay-inner\{overflow-y:auto/);
  assert.match(css,/\.overlay-mayhem-pane\{overflow-y:auto/);
  assert.match(css,/\.overlay-body::-webkit-scrollbar[^}]*display:none/);
  assert.match(css,/\.overlay-inner::-webkit-scrollbar[^}]*display:none/);
  assert.match(css,/\.overlay-top-augment-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/\.overlay-augment-row\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(renderer,/overlay-augment-icon[^>]*><img/);
  assert.match(renderer,/overlay-top-augment-name/);
  assert.match(renderer,/compactVariantLabel\(row\.label\)/);
  assert.match(css,/\.overlay-scenario-tabs button,\.overlay-variant-tabs button\{[^}]*overflow-wrap:anywhere/);
  assert.match(css,/\.overlay-selected-build>\.overlay-items>\.overlay-item\.selected\{[^}]*outline:0/);
});

test('overlay passes mouse and focus through to League until interaction mode is enabled',()=>{
  const main=read('src/main.js'),overlay=read('src/overlay.js'),html=read('src/overlay.html');
  assert.match(main,/show: false, frame: false, alwaysOnTop: true, focusable: false/);
  assert.match(main,/let overlayInteractive=false[\s\S]*overlayWindow\.setIgnoreMouseEvents\(!overlayInteractive,\{forward:true\}\)/);
  assert.match(main,/globalShortcut\.register\('Control\+Alt\+I'/);
  assert.match(main,/function setOverlayInteractive\(active\)/);
  assert.match(main,/const TOOLTIP_HIDE_DELAY_MS=700/);
  assert.match(overlay,/onOverlayInteractionState\(active=>/);
  assert.match(html,/Ctrl \+ Shift \+ Espacio para mostrar\/ocultar/);
});
