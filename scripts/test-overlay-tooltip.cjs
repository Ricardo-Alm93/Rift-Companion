'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const sourceRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('src');
const timeout = (promise, label, ms = 7000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
async function waitUntil(read, label, ms = 7000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function waitForMeasure(win, afterRequestId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('tooltip:measure', onMeasure);
      reject(new Error('Timed out waiting for tooltip size report'));
    }, 7000);
    const onMeasure = (event, size) => {
      if (event.sender !== win.webContents) {
        clearTimeout(timer);
        ipcMain.removeListener('tooltip:measure', onMeasure);
        reject(new Error('size report must come from the tooltip renderer'));
        return;
      }
      // The hidden tooltip can emit its previous measurement after a new hover
      // request has begun. Ignore it and wait for the current request instead.
      if (!(Number(size?.requestId) > afterRequestId)) return;
      clearTimeout(timer);
      ipcMain.removeListener('tooltip:measure', onMeasure);
      resolve(size);
    };
    ipcMain.on('tooltip:measure', onMeasure);
  });
}

app.whenReady().then(async () => {
  let overlay, win;
  try {
    overlay = new BrowserWindow({ show: false, width: 430, height: 720, webPreferences: { preload: path.join(sourceRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const context = vm.createContext({ BrowserWindow, ipcMain, screen, path, __dirname: sourceRoot, overlayWindow: overlay, tooltipWindow: null, pendingTooltipHtml: '', tooltipCursor: { x: 100, y: 100 }, tooltipRequestId: 0, tooltipActive: false, tooltipHideTimer: null, TOOLTIP_HIDE_DELAY_MS: 700, console, setTimeout, clearTimeout });
    const main = fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8');
    const functions = main.slice(main.indexOf('function createTooltipWindow(){'), main.indexOf('function createLauncher(){'));
    const handlers = main.slice(main.indexOf("ipcMain.on('overlay:tooltip-show'"), main.indexOf("ipcMain.on('overlay:champion-select'"));
    vm.runInContext((main.match(/function hideTooltip\(\)\{[^\n]+/)?.[0] || '') + '\n' + (main.match(/function scheduleTooltipHide\(\)\{[^\n]+/)?.[0] || '') + '\n' + functions + '\n' + handlers, context);
    await overlay.loadFile(path.join(sourceRoot, 'overlay.html'));
    overlay.showInactive();
    win = vm.runInContext('createTooltipWindow()', context);
    await timeout(new Promise(resolve => {
      if (!win.webContents.isLoading()) resolve();
      else win.webContents.once('did-finish-load', resolve);
    }), 'tooltip document load');
    await waitUntil(() => win.webContents.executeJavaScript("document.documentElement.dataset.tooltipReady === 'true' && Boolean(window.rift?.reportTooltipSize) && Boolean(document.getElementById('tooltip-content'))"), 'tooltip renderer ready handshake');

    const details = { name: 'Objeto de prueba', cost: 3200, stats: [{ icon: '✦', type: 'magic', value: 100, label: 'Poder de habilidad' }], effects: [{ name: 'Pasiva de prueba', body: 'Inflige 20 de daño adicional.' }], metadata: { components: [{ id: '1', name: 'Componente de prueba', cost: 400, icon: '' }], combineCost: 2800, patch: '16.22.1', source: 'Data Dragon' }, education: { whyFits: { title: 'Por qué encaja', text: 'Encaja con la habilidad y su prioridad de compra.' }, fit: 'Encaja con la habilidad y su prioridad de compra.', evidenceSummary: { level: 'documented', patch: '16.22.1', confidence: 0.95, sources: ['Riot Data Dragon'] } }, purchaseTags: ['Prueba local'] };
    const certification = { status: 'documented-interactions', statusLabel: 'Interacciones documentadas', legalStatus: 'legal', reviewStatus: 'partial', reviewStatusLabel: 'Parcial', patch: '16.22.1', findings: ['Hallazgo de revisión.'], alternativeContext: 'Alternativa contextual.' };
    await overlay.webContents.executeJavaScript('render({sections:{ranked:{title:"Ahri",items:[' + JSON.stringify(details) + '],certification:' + JSON.stringify(certification) + ',skills:[],tips:[]}}});');
    assert.equal(await overlay.webContents.executeJavaScript("document.querySelector('.overlay-build-certification')===null"), true, 'compact Ranked overlay omits technical certification panels');
    assert.equal(await overlay.webContents.executeJavaScript("![...document.querySelectorAll('#overlay-inner h3')].some(node=>/habilidades|hechizos|diagn[oó]stic/i.test(node.textContent))"), true, 'compact Ranked overlay omits skills, empty spell panels, and diagnostics');
    const requestBeforeItem = context.tooltipRequestId;
    const itemMeasured = waitForMeasure(win, requestBeforeItem);
    await overlay.webContents.executeJavaScript("document.querySelector('.overlay-item').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,clientX:150,clientY:300}))");
    const size = await itemMeasured;
    assert.ok(size.width >= 280 && size.height > 50, 'tooltip must report measured dynamic dimensions');
    assert.equal(win.isVisible(), true, 'tooltip must show only after a measured size arrives');
    const bounds = win.getBounds();
    assert.ok(bounds.width >= 280 && bounds.height > 50);
    const workArea=screen.getDisplayMatching(bounds).workArea;
    assert.ok(bounds.x>=workArea.x&&bounds.y>=workArea.y&&bounds.x+bounds.width<=workArea.x+workArea.width&&bounds.y+bounds.height<=workArea.y+workArea.height,'tooltip window remains inside the available desktop work area');
    assert.ok(await win.webContents.executeJavaScript("document.getElementById('tooltip-content').textContent.includes('Pasiva de prueba')"));
    assert.ok(await win.webContents.executeJavaScript("document.getElementById('tooltip-content').textContent.includes('Riot Data Dragon')"), 'shared tooltip must show evidence provenance');
    assert.equal(await win.webContents.executeJavaScript("(()=>{const t=document.getElementById('tooltip-content').textContent;return t.indexOf('Estadísticas base')<t.indexOf('POR QUÉ ENCAJA') && !t.includes('Qué aporta') && !t.includes('Qué sacrificas') && !document.querySelector('.item-recipe-details').open})()"), true, 'Ranked tooltip shows technical stats separately from one fit reason and keeps recipe details collapsed');
    assert.equal(win.isFocusable(), true, 'the detached tooltip can receive keyboard focus for accessible scrolling');

    const longDetails = { ...details, effects: Array.from({ length: 28 }, (_, index) => ({ name: `Efecto ${index + 1}`, body: `Descripción extendida ${index + 1}. `.repeat(18) })) };
    const longRequest = context.tooltipRequestId;
    const longMeasure = waitForMeasure(win, longRequest);
    await overlay.webContents.executeJavaScript('render({sections:{ranked:{title:"Ahri",items:[' + JSON.stringify(longDetails) + ']}}});document.querySelector(".overlay-item").dispatchEvent(new PointerEvent("pointerover",{bubbles:true,clientX:150,clientY:300}))');
    const longSize = await longMeasure;
    assert.ok(longSize.height < 700, 'long tooltip height is capped to the available viewport');
    assert.equal(await win.webContents.executeJavaScript("(()=>{const el=document.querySelector('.tooltip-scroll-content');return el&&el.scrollHeight>el.clientHeight&&getComputedStyle(el).overflowY==='auto'&&getComputedStyle(el).scrollbarWidth==='none'&&getComputedStyle(el.querySelector('.build-item-tooltip')).overflowY==='visible'})()"), true, 'long technical content remains scrollable in a scrollbar-hidden wrapper');
    await win.webContents.executeJavaScript("document.querySelector('.tooltip-scroll-content').dispatchEvent(new WheelEvent('wheel',{deltaY:360,bubbles:true,cancelable:true}))");
    await waitUntil(() => win.webContents.executeJavaScript("document.querySelector('.tooltip-scroll-content').scrollTop>0"), 'wheel-event scrolling inside long tooltip');
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('.tooltip-scroll-content').textContent.includes('Efecto 28')"), true, 'the end of long technical content remains present and accessible');
    await win.webContents.executeJavaScript("(()=>{const el=document.querySelector('.tooltip-scroll-content');el.scrollTop=0;el.dispatchEvent(new WheelEvent('wheel',{deltaY:3.25,deltaMode:0,bubbles:true,cancelable:true}))})()");
    await waitUntil(() => win.webContents.executeJavaScript("document.querySelector('.tooltip-scroll-content').scrollTop>0"), 'precision touchpad-style wheel scrolling');
    const screenshotDir=path.resolve('docs/assets/screenshots');fs.mkdirSync(screenshotDir,{recursive:true});fs.writeFileSync(path.join(screenshotDir,'ranked-tooltip-long-after.png'),(await win.webContents.capturePage()).toPNG());

    const hideEvent = timeout(new Promise(resolve => win.once('hide', resolve)), 'tooltip hide after pointer leaves tooltip');
    await overlay.webContents.executeJavaScript("document.querySelector('.overlay-item').dispatchEvent(new PointerEvent('pointerout',{bubbles:true}))");
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(win.isVisible(),true,'tooltip remains visible while pointer crosses the small gap to its external window');
    await win.webContents.executeJavaScript('window.rift.setTooltipPointerInside(true)');
    await new Promise(resolve=>setTimeout(resolve,240));
    assert.equal(win.isVisible(),true,'tooltip remains visible while the pointer is over its scrollable content');
    await win.webContents.executeJavaScript('window.rift.setTooltipPointerInside(false)');
    await hideEvent;
    assert.equal(win.isVisible(), false, 'tooltip must hide after leaving item');

    if (main.includes('tooltipActive')) {
      const staleRequest = context.tooltipRequestId - 1;
      await win.webContents.executeJavaScript('window.rift.reportTooltipSize({requestId:' + staleRequest + ',width:400,height:400})');
      assert.equal(win.isVisible(), false, 'late size report cannot reopen hidden tooltip');
    }

    await overlay.webContents.executeJavaScript('render({sections:{aram:{title:"Ahri",items:[' + JSON.stringify({ ...details, mode: 'aram' }) + '],augments:[{name:"Aumento destacado S",tier:"S",description:"Descripción destacada completa",rarity:"gold",icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22%23384f6e%22/%3E%3Ctext%20x%3D%2232%22%20y%3D%2242%22%20text-anchor%3D%22middle%22%20font-size%3D%2230%22%20fill%3D%22white%22%3E%E2%98%85%3C/text%3E%3C/svg%3E"},{name:"Aumento destacado A",tier:"A",description:"Descripción destacada completa",rarity:"gold",icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22%23384f6e%22/%3E%3Ctext%20x%3D%2232%22%20y%3D%2242%22%20text-anchor%3D%22middle%22%20font-size%3D%2230%22%20fill%3D%22white%22%3E%E2%98%85%3C/text%3E%3C/svg%3E"},{name:"Aumento destacado B",tier:"B",description:"Descripción destacada completa",rarity:"silver",icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22%23384f6e%22/%3E%3Ctext%20x%3D%2232%22%20y%3D%2242%22%20text-anchor%3D%22middle%22%20font-size%3D%2230%22%20fill%3D%22white%22%3E%E2%98%85%3C/text%3E%3C/svg%3E"},{name:"Aumento destacado C",tier:"C",description:"Descripción destacada completa",rarity:"silver",icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22%23384f6e%22/%3E%3Ctext%20x%3D%2232%22%20y%3D%2242%22%20text-anchor%3D%22middle%22%20font-size%3D%2230%22%20fill%3D%22white%22%3E%E2%98%85%3C/text%3E%3C/svg%3E"}],tieredAugments:[{name:"Aumento de prueba",tier:"A",appearanceRate:12.5,description:"Descripción completa del aumento",rarity:"gold",icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22%23384f6e%22/%3E%3Ctext%20x%3D%2232%22%20y%3D%2242%22%20text-anchor%3D%22middle%22%20font-size%3D%2230%22%20fill%3D%22white%22%3E%E2%98%85%3C/text%3E%3C/svg%3E"}]}}});document.querySelector("[data-overlay-tab=aram]").click();document.querySelector("[data-mayhem-tab=augments]").click();');
    const aramLayout=await overlay.webContents.executeJavaScript("(()=>{const body=getComputedStyle(document.body),inner=getComputedStyle(document.querySelector('#overlay-inner')),pane=getComputedStyle(document.querySelector('.overlay-mayhem-pane')),top=document.querySelector('.overlay-top-augment'),badge=top?.querySelector('.overlay-augment-icon .augment-tier-tag'),name=top?.querySelector('.overlay-top-augment-name'),icon=top?.querySelector('.overlay-augment-icon'),cards=[...document.querySelectorAll('.overlay-top-augment')],rects=cards.map(node=>node.getBoundingClientRect());return {bodyOverflowX:body.overflowX,bodyBar:body.scrollbarWidth,innerBar:inner.scrollbarWidth,innerOverflowY:inner.overflowY,paneBar:pane.scrollbarWidth,paneOverflowY:pane.overflowY,topCount:cards.length,badgeInsideIcon:!!badge&&icon.contains(badge),nameOutsideIcon:!!name&&!icon.contains(name),rows:new Set(rects.map(rect=>Math.round(rect.top))).size,rects:rects.map(rect=>[rect.left,rect.top,rect.width,rect.height]),columns:getComputedStyle(document.querySelector('.overlay-top-augment-grid')).gridTemplateColumns,viewport:innerWidth,overflow:document.querySelector('#overlay-inner').scrollWidth>document.querySelector('#overlay-inner').clientWidth}})()");
    assert.equal(aramLayout.bodyBar,'none');assert.equal(aramLayout.innerBar,'none');assert.equal(aramLayout.paneBar,'none');assert.equal(aramLayout.bodyOverflowX,'hidden');assert.equal(aramLayout.innerOverflowY,'auto');assert.equal(aramLayout.paneOverflowY,'auto');assert.equal(aramLayout.topCount,4);assert.equal(aramLayout.badgeInsideIcon,true);assert.equal(aramLayout.nameOutsideIcon,true);assert.equal(aramLayout.rows,2,'four featured augments use two horizontal columns at compact overlay width: '+JSON.stringify(aramLayout));assert.equal(aramLayout.overflow,false,'ARAM overlay content must not create horizontal overflow');
    for(const zoom of [1,1.2]){overlay.webContents.setZoomFactor(zoom);await overlay.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const fit=await overlay.webContents.executeJavaScript("(()=>({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,bar:getComputedStyle(document.querySelector('#overlay-inner')).scrollbarWidth,columns:getComputedStyle(document.querySelector('.overlay-top-augment-grid')).gridTemplateColumns}))()");assert.equal(fit.bar,'none');assert.ok(fit.scroll<=fit.viewport+1,'overlay remains horizontally clipped cleanly at zoom '+zoom+': '+JSON.stringify(fit));}overlay.webContents.setZoomFactor(1);
    const requestBeforeAramItem = context.tooltipRequestId;
    const aramItemMeasured = waitForMeasure(win, requestBeforeAramItem);
    await overlay.webContents.executeJavaScript("document.querySelector('.overlay-item').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,clientX:150,clientY:300}))");
    await aramItemMeasured;
    assert.equal(win.isVisible(), true, 'ARAM item tooltip visible after size report');
    assert.equal(await win.webContents.executeJavaScript("!!document.querySelector('.item-recipe-details')&&document.querySelector('.item-recipe-details').open===false"), true, 'ARAM tooltip retains its collapsed technical recipe/source section');

    const aramHide = timeout(new Promise(resolve => win.once('hide', resolve)), 'ARAM item tooltip hide');
    await overlay.webContents.executeJavaScript("document.querySelector('.overlay-item').dispatchEvent(new PointerEvent('pointerout',{bubbles:true}))");
    await aramHide;
    const requestBeforeAugment = context.tooltipRequestId;
    const augmentMeasured = waitForMeasure(win, requestBeforeAugment);
    await overlay.webContents.executeJavaScript("document.querySelector('.overlay-augment-card').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,clientX:150,clientY:400}))");
    await augmentMeasured;
    assert.equal(win.isVisible(), true, 'augment tooltip visible after size report');
    assert.equal(await win.webContents.executeJavaScript("document.getElementById('tooltip-content').textContent.includes('Descripción completa del aumento')"), true);
    await overlay.webContents.executeJavaScript('document.querySelector("[data-overlay-tab=aram]").click();document.querySelector("[data-mayhem-tab=augments]").click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await overlay.webContents.executeJavaScript("document.querySelector('#overlay-inner').textContent.includes('4 AUMENTOS DESTACADOS')"),true);
    fs.writeFileSync(path.join(screenshotDir,'mayhem-augment-grid-overlay.png'),(await overlay.webContents.capturePage()).toPNG());

    const mainSource=fs.readFileSync(path.join(sourceRoot,'main.js'),'utf8');assert.match(mainSource,/focusable:\s*false/,'overlay is non-focusable until interactive mode is enabled');assert.match(mainSource,/let overlayInteractive=false[\s\S]*overlayWindow\.setIgnoreMouseEvents\(!overlayInteractive,\{forward:true\}\)/,'overlay defaults to mouse pass-through');assert.match(mainSource,/Control\+Alt\+I/,'interactive mode has a keyboard toggle');
    console.log(JSON.stringify({ passed: true, sourceRoot, width: bounds.width, height: bounds.height, windowsDisplayScaleFactors:screen.getAllDisplays().map(display=>display.scaleFactor), screenshots:[path.join(screenshotDir,'ranked-tooltip-long-after.png'),path.join(screenshotDir,'mayhem-augment-grid-overlay.png')], checks: ['tooltip DOM/preload readiness handshake', 'actual tooltip measure IPC before show', 'viewport-capped long content', 'wheel and touchpad-style scrolling', 'invisible scrollbar', 'focusable tooltip display', 'pointer transfer delay across tooltip gap', 'hide after leaving tooltip', 'late size report rejection', 'ARAM item tooltip', 'ARAM augment tier badge and layout', 'no ARAM horizontal overflow at 100% and 120% app zoom', 'overlay focus and mouse passthrough'] }, null, 2));
    win.destroy(); overlay.destroy(); app.exit(0);
  } catch (error) {
    console.error(error);
    win?.destroy(); overlay?.destroy(); app.exit(1);
  }
});
setTimeout(() => app.exit(2), 30000);
