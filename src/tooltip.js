(()=>{
  const host=document.getElementById('tooltip-content');
  let requestId=0;
  function measure(){
    const scroll=host.firstElementChild,tooltip=scroll?.firstElementChild;if(!scroll||!tooltip)return;
    // Measure the natural content, not the viewport-sized wrapper. If the
    // tooltip is taller than the display, the wrapper becomes the scroller.
    const box=tooltip.getBoundingClientRect(),screenWidth=window.screen?.availWidth||window.innerWidth||480,screenHeight=window.screen?.availHeight||window.innerHeight||700,maxHeight=Math.max(220,screenHeight-24),contentHeight=Math.max(tooltip.scrollHeight,tooltip.offsetHeight,box.height),contentWidth=Math.max(tooltip.scrollWidth,tooltip.offsetWidth,box.width),isItem=tooltip.classList.contains('build-item-tooltip'),minHeight=isItem?520:320;
    // The tooltip window resizes itself after each hover. Measuring against
    // innerHeight traps it at the previous short height, so use the display's
    // available dimensions and let the main process clamp to the work area.
    window.rift?.reportTooltipSize({requestId,width:Math.ceil(Math.min(Math.max(contentWidth+24,isItem?480:360),Math.min(480,screenWidth-16))),height:Math.ceil(Math.min(Math.max(contentHeight+24,minHeight),maxHeight))});
  }
  window.rift?.onTooltipContent(payload=>{
    requestId=typeof payload==='object'?payload.requestId:0;
    host.innerHTML=`<div class="tooltip-scroll-content" tabindex="0" role="region" aria-label="Detalles desplazables">${(typeof payload==='string'?payload:payload?.html)||''}</div>`;
    requestAnimationFrame(()=>requestAnimationFrame(measure));
  });
  host.addEventListener('pointerenter',()=>window.rift?.setTooltipPointerInside(true));
  host.addEventListener('pointerleave',()=>window.rift?.setTooltipPointerInside(false));
  host.addEventListener('wheel',event=>{const scroller=host.firstElementChild;if(!event.deltaY||!scroller)return;scroller.scrollTop+=event.deltaY;event.preventDefault()},{passive:false});
  host.addEventListener('keydown',event=>{if(event.key==='Escape')window.rift?.hideOverlayTooltip()});
  document.documentElement.dataset.tooltipReady='true';
  window.addEventListener('resize',measure);
})();
