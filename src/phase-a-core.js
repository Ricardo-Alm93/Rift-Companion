(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.RiftPhaseA=api})(typeof globalThis!=='undefined'?globalThis:this,()=>{
  const roles=['','top','jungle','mid','adc','support'];
  function validateRoster({rows=[],mine='',opponent=''},ids){
    const valid=new Set(ids),errors=[],used=new Set();const filled=rows.filter(r=>r.champion);
    for(const r of filled){if(!valid.has(r.champion))errors.push('champion');if(!['ally','enemy'].includes(r.team))errors.push('team');if(!roles.includes(r.role||''))errors.push('role');if(used.has(r.champion))errors.push('duplicate');used.add(r.champion)}
    const ally=filled.filter(r=>r.team==='ally'),enemy=filled.filter(r=>r.team==='enemy');
    if(ally.length>5||enemy.length>5)errors.push('size');if(!ally.some(r=>r.champion===mine))errors.push('mine');
    if(opponent&&!enemy.some(r=>r.champion===opponent))errors.push('opponent');
    const myPlayer=ally.find(r=>r.champion===mine);return {valid:!errors.length,errors:[...new Set(errors)],ally,enemy,myPlayer,coverage:filled.length,complete:filled.length===10&&ally.length===5&&enemy.length===5&&filled.every(r=>r.role),canQuery:!!(myPlayer?.role&&opponent&&enemy.some(r=>r.champion===opponent))};
  }
  const invertTeams=rows=>rows.map(r=>({...r,team:r.team==='ally'?'enemy':r.team==='enemy'?'ally':'none'}));
  const observedSkills=order=>Array.from({length:18},(_,i)=>/^[QWER]$/.test(order?.[i])?order[i]:'');
  const nonstandardSkillChampions=new Set(['Aphelios','Elise','Jayce','Karma','Nidalee','Udyr']);
  function completeStandardSkillOrder(championId,order=[],priority=[]){
    const levels=observedSkills(order),proposedLevels=[];
    if(levels.slice(0,18).every(Boolean))return {levels,proposedLevels,status:'published'};
    if(nonstandardSkillChampions.has(String(championId||''))||order.length!==15)return {levels,proposedLevels,status:'incomplete'};
    const source=order.slice(0,15),basic=['Q','W','E'];
    if(source.some(skill=>!['Q','W','E','R'].includes(skill))||source[5]!=='R'||source[10]!=='R'||source.filter(skill=>skill==='R').length!==2)return {levels,proposedLevels,status:'incomplete'};
    const counts=Object.fromEntries([...basic,'R'].map(skill=>[skill,source.filter(value=>value===skill).length]));
    if(basic.some(skill=>counts[skill]>5)||basic.reduce((sum,skill)=>sum+counts[skill],0)!==13)return {levels,proposedLevels,status:'incomplete'};
    const orderPriority=priority.map(value=>String(value).toUpperCase());
    if(orderPriority.length!==3||new Set(orderPriority).size!==3||basic.some(skill=>!orderPriority.includes(skill)))return {levels,proposedLevels,status:'incomplete'};
    levels[15]='R';counts.R++;proposedLevels.push(16);
    for(let index=16;index<18;index++){
      const skill=orderPriority.find(value=>counts[value]<5);
      if(!skill)return {levels:observedSkills(order),proposedLevels:[],status:'incomplete'};
      levels[index]=skill;counts[skill]++;proposedLevels.push(index+1);
    }
    if(counts.R!==3||basic.some(skill=>counts[skill]!==5))return {levels:observedSkills(order),proposedLevels:[],status:'incomplete'};
    return {levels,proposedLevels,status:'reconstructed-standard'};
  }
  function safeGuides(raw){const parsed=JSON.parse(raw||'[]');if(!Array.isArray(parsed)||parsed.length>1000)throw new Error('Invalid guides');return parsed.map(g=>{if(!g||typeof g!=='object'||Array.isArray(g)||typeof g.id!=='string'||typeof g.champion!=='string'||!['ranked','aram'].includes(g.mode))throw new Error('Invalid guide');for(const key of ['id','champion','enemy','role','build','skills','tips','augments','source'])if(g[key]!=null&&typeof g[key]!=='string')throw new Error('Invalid text field');for(const key of ['itemIds','buildBlocks'])if(g[key]!=null&&(!Array.isArray(g[key])||g[key].length>100))throw new Error('Invalid item blocks');if(g.buildBlocks?.some(block=>!Array.isArray(block)||block.length>6||block.some(id=>!/^\d{1,8}$/.test(String(id)))))throw new Error('Invalid item IDs');const out={};for(const [key,value]of Object.entries(g)){if(['__proto__','constructor','prototype'].includes(key))continue;if(typeof value==='string'&&value.length>20000)throw new Error('Text too long');out[key]=value}return out})}
  function buildEvidence(row){return row?._curated?'CURATED':row?._suggested||row?._fallback||row?._assembled?'RULE_BASED':'OBSERVED'}
  return {roles,validateRoster,invertTeams,observedSkills,completeStandardSkillOrder,safeGuides,buildEvidence};
});
