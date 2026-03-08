/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          AI AUTO-PLAY — VÒNG LINH THỦ  (standalone v3)          ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  CÁCH DÙNG (tùy chọn, không bắt buộc):                         ║
 * ║   Thêm dòng sau vào cuối <body> của index.html:                 ║
 * ║   <script src="ai_autoplay.js"></script>                        ║
 * ║                                                                  ║
 * ║  Người chơi bình thường KHÔNG cần file này.                     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
(function () {
  'use strict';

  // Per-character attack-range profiles (từ tickWeapons() source)
  const CHAR_PROFILE = {
    luu_phong:    { optimalDist: 80,  fleeDist: 35,  approachDist: 140 },
    kim_cang:     { optimalDist: 75,  fleeDist: 30,  approachDist: 130 },
    tu_linh:      { optimalDist: 90,  fleeDist: 40,  approachDist: 150 },
    hoa_long:     { optimalDist: 85,  fleeDist: 35,  approachDist: 150 },
    am_sat:       { optimalDist: 140, fleeDist: 70,  approachDist: 220 },
    huyen_nguyet: { optimalDist: 160, fleeDist: 80,  approachDist: 260 },
    thiet_tam:    { optimalDist: 220, fleeDist: 110, approachDist: 340 },
    loi_than:     { optimalDist: 200, fleeDist: 100, approachDist: 320 },
    bang_vuong:   { optimalDist: 190, fleeDist: 95,  approachDist: 310 },
  };
  const DEFAULT_PROFILE = { optimalDist: 150, fleeDist: 75, approachDist: 250 };

  // Card scoring: main weapon > evolve > dmg/atkspd/lifesteal > epic > rare > common
  const HIGH_PRIO_STATS = new Set(['tốc độ tấn công', 'sát thương', 'hút máu']);

  function scoreCard(cardEl) {
    const cls     = cardEl.className || '';
    const typeTxt = (cardEl.querySelector('.lv-card-type')?.textContent || '').trim().toUpperCase();
    const nameLow = (cardEl.querySelector('.lv-card-name')?.textContent || '').toLowerCase().trim();
    const wpnName = (Game?.player?.charData?.weapon || '').toLowerCase();
    if (wpnName && nameLow === wpnName)                 return 1000;
    if (cls.includes('evolve') || typeTxt === 'EVOLVE') return 900;
    if (HIGH_PRIO_STATS.has(nameLow))                   return 700;
    if (cls.includes('epic')   || typeTxt === 'EPIC')   return 400;
    if (cls.includes('rare')   || typeTxt === 'RARE')   return 200;
    return 80;
  }

  const CFG_AI = {
    CARD_PICK_DELAY:    500,
    RESTART_DELAY:     3000,
    META_DELAY:         400,
    SKILL_RANGE:        280,
    ENEMY_CLUSTER_CNT:    5,
  };

  const PET_PRIORITY = [
    'pet_tiger','pet_dragon','pet_eagle','pet_snake','pet_turtle','pet_fox',
  ];
  const POT_PRIORITY = [
    ['damage',0],['damage',1],['damage',2],
    ['mobility',2],['mobility',0],
    ['survival',0],['damage',3],
    ['mobility',1],['survival',1],['survival',2],['survival',3],
    ['fortune',0],
  ];
  const POT_META = {
    survival: { maxLv:[10,4,4,4], baseCost:[480,900,1200,2100] },
    damage:   { maxLv:[10,4,3,3], baseCost:[600,1200,1800,2700] },
    mobility: { maxLv:[5,4,4,2],  baseCost:[480,900,1200,2700]  },
    fortune:  { maxLv:[4,1,1,0],  baseCost:[720,4800,3900,0]    },
  };
  function potCost(base,lv){const m=[1,2,4,6,6,6,6,6,6,6];return base*m[Math.min(lv,m.length-1)];}

  let aiEnabled=false, _rafId=null, _restartTimer=null;
  let _lastSkillTick=0, _cardPickScheduled=false, _aiSetBossMode=false;

  function log(msg){
    console.log(`%c[AI] ${msg}`,'color:#a060ff;font-size:11px');
    const el=document.getElementById('ai-log');
    if(el&&aiEnabled){el.textContent=msg;el.className='active';}
  }
  function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
  function activeScreen(){
    const el=document.querySelector('.screen.active');
    return el?el.id.replace('screen-',''):'';
  }

  // Cycle target-priority button đến mode mong muốn
  // TARGET_PRIORITY_ORDER = ['nearest','boss','elite','lowest_hp']
  function setTargetPriority(desired){
    const ORDER=['nearest','boss','elite','lowest_hp'];
    for(let i=0;i<ORDER.length;i++){
      const btn=document.getElementById('target-priority-btn');
      const cur=btn?ORDER.find(m=>btn.classList.contains('mode-'+m))||'nearest':'nearest';
      if(cur===desired)return;
      Game.cycleTargetPriority();
    }
  }

  function manageBossTargetPriority(){
    if(!Game.isRunning())return;
    const bossActive=Game.bossSpawned&&!Game.bossKilled;
    if(bossActive&&!_aiSetBossMode){
      _aiSetBossMode=true;
      setTargetPriority('boss');
      log('🔴 BOSS — ưu tiên: boss');
    }else if(!bossActive&&_aiSetBossMode){
      _aiSetBossMode=false;
      setTargetPriority('nearest');
      log('✅ Boss hạ — về nearest');
    }
  }

  async function doMetaSpend(){
    await sleep(CFG_AI.META_DELAY);
    log('Meta-spend...');
    for(const id of PET_PRIORITY){
      if(Save.hasPet(id))continue;
      const pet=PETS.find(p=>p.id===id);
      if(pet&&Save.get().gold>=pet.cost&&Save.buyPet(id))log(`Pet: ${pet.name}`);
    }
    for(const id of PET_PRIORITY){if(Save.hasPet(id)){Save.equipPet(id);break;}}
    const ulist=Save.get().unlockedChars||[];
    for(const c of [...CHARS].sort((a,b)=>b.cost-a.cost)){
      if(c.cost>0&&!ulist.includes(c.id)&&Save.spendGold(c.cost)){
        ulist.push(c.id);Save.get().unlockedChars=ulist;Save.save();
        log(`Unlock: ${c.name}`);
      }
    }
    let changed=true,guard=0;
    while(changed&&guard++<300){
      changed=false;
      for(const[br,idx]of POT_PRIORITY){
        const meta=POT_META[br];
        const maxLv=meta.maxLv[idx]||0,base=meta.baseCost[idx]||0;
        if(!base||!maxLv)continue;
        const curLv=Save.getPotentialLevel(br,idx);
        if(curLv>=maxLv)continue;
        if(Save.spendGold(potCost(base,curLv))){
          Save.upgradePotential(br,idx);
          log(`Pot [${br}][${idx}] lv${curLv+1}`);
          changed=true;break;
        }
      }
    }
    log(`Done. Vàng: ${Save.get().gold}◈`);
  }

  function pickBestCharAndMap(){
    const sd=Save.get();
    const unlocked=CHARS.filter(c=>c.cost===0||(sd.unlockedChars||[]).includes(c.id));
    const bestChar=unlocked.reduce((b,c)=>c.cost>b.cost?c:b,unlocked[0]);
    let bestMapIdx=0;
    for(let i=MAPS.length-1;i>=0;i--){
      if(i===0||(sd.completedMaps||[]).includes(MAPS[i-1].id)){bestMapIdx=i;break;}
    }
    return{charId:bestChar.id,mapIdx:bestMapIdx};
  }

  async function doStartRun(){
    _aiSetBossMode=false;
    await doMetaSpend();
    await sleep(CFG_AI.META_DELAY);
    const{charId,mapIdx}=pickBestCharAndMap();
    log(`Run: ${charId} @ map${mapIdx}`);
    const sd=Save.get();
    if(sd.firstPlay!==false){sd.firstPlay=false;Save.save();}
    Tutorial.check(charId,mapIdx);
  }

  function computeMovement(){
    const player=Game.player,enemies=Game.enemies;
    if(!player||!enemies)return{x:0,y:0};
    const charId=player.charData?.id||'luu_phong';
    const profile=CHAR_PROFILE[charId]||DEFAULT_PROFILE;
    const px=player.x,py=player.y;

    // Boss mode: tiến vào đánh boss, chỉ lùi khi quá sát
    const bossActive=Game.bossSpawned&&!Game.bossKilled;
    if(bossActive){
      const boss=enemies.find(e=>e.isBoss&&!e.dead);
      if(boss){
        const dx=boss.x-px,dy=boss.y-py;
        const dist=Math.sqrt(dx*dx+dy*dy)||1;
        if(dist<profile.fleeDist)return{x:-dx/dist,y:-dy/dist};
        if(dist>profile.optimalDist)return{x:dx/dist,y:dy/dist};
        return{x:0,y:0};
      }
    }

    // Minion mode: 3-zone kiting
    let nearest=null,nearestDist=Infinity,clusterCount=0;
    const clusterR=profile.optimalDist*1.5;
    for(const e of enemies){
      if(e.dead)continue;
      const dx=e.x-px,dy=e.y-py,d=Math.sqrt(dx*dx+dy*dy);
      if(d<nearestDist){nearestDist=d;nearest=e;}
      if(d<clusterR)clusterCount++;
    }
    if(!nearest){
      const cx=1200-px,cy=900-py,cl=Math.sqrt(cx*cx+cy*cy)||1;
      return{x:(cx/cl)*Math.min(1,cl/600)*0.3,y:(cy/cl)*Math.min(1,cl/600)*0.3};
    }
    const crowded=clusterCount>=CFG_AI.ENEMY_CLUSTER_CNT;
    const effFlee=crowded?profile.optimalDist*0.7:profile.fleeDist;
    const effApproach=crowded?profile.optimalDist*1.6:profile.approachDist;
    const dxN=nearest.x-px,dyN=nearest.y-py,lenN=nearestDist||1;
    if(nearestDist<effFlee){
      let fx=0,fy=0;
      for(const e of enemies){
        if(e.dead)continue;
        const dx=px-e.x,dy=py-e.y,d=Math.sqrt(dx*dx+dy*dy);
        if(d<profile.optimalDist*2&&d>0){const t=1-d/(profile.optimalDist*2);const w=2.5*t*t+0.2;fx+=(dx/d)*w;fy+=(dy/d)*w;}
      }
      const fl=Math.sqrt(fx*fx+fy*fy)||1;return{x:fx/fl,y:fy/fl};
    }
    if(nearestDist>effApproach)return{x:dxN/lenN,y:dyN/lenN};
    if(crowded){
      let fx=0,fy=0;
      for(const e of enemies){
        if(e.dead)continue;
        const dx=px-e.x,dy=py-e.y,d=Math.sqrt(dx*dx+dy*dy);
        if(d<clusterR&&d>0){fx+=dx/d;fy+=dy/d;}
      }
      const fl=Math.sqrt(fx*fx+fy*fy)||1;return{x:fx/fl*0.4,y:fy/fl*0.4};
    }
    return{x:0,y:0};
  }

  function tryUseSkill(now){
    if(now-_lastSkillTick<180)return;
    _lastSkillTick=now;
    const player=Game.player,enemies=Game.enemies;
    if(!player||!enemies||!player.activeReady)return;
    const px=player.x,py=player.y;
    // Boss: cast bất kể khoảng cách
    if(Game.bossSpawned&&!Game.bossKilled){
      const boss=enemies.find(e=>e.isBoss&&!e.dead);
      if(boss){const dx=boss.x-px,dy=boss.y-py,d=Math.sqrt(dx*dx+dy*dy)||1;try{player.useActive({x:dx/d,y:dy/d});log('Skill→boss!');}catch(_){}return;}
    }
    let nearest=null,nearestDist=Infinity;
    for(const e of enemies){
      if(e.dead)continue;
      const dx=e.x-px,dy=e.y-py,d=Math.sqrt(dx*dx+dy*dy);
      if(d<CFG_AI.SKILL_RANGE&&d<nearestDist){nearestDist=d;nearest=e;}
    }
    if(!nearest)return;
    const dir={x:(nearest.x-px)/(nearestDist||1),y:(nearest.y-py)/(nearestDist||1)};
    try{player.useActive(dir);log('Skill!');}catch(_){}
  }

  function schedulePickCard(){
    if(_cardPickScheduled)return;
    _cardPickScheduled=true;
    setTimeout(()=>{
      _cardPickScheduled=false;
      const cards=Array.from(document.querySelectorAll('#levelup-cards .lv-card'));
      if(!cards.length)return;
      const best=cards.reduce((b,c)=>scoreCard(c)>scoreCard(b)?c:b,cards[0]);
      log(`Card: "${best.querySelector('.lv-card-name')?.textContent}" (${scoreCard(best)})`);
      best.click();
    },CFG_AI.CARD_PICK_DELAY);
  }

  function tick(now){
    if(!aiEnabled)return;
    _rafId=requestAnimationFrame(tick);
    const screen=activeScreen();
    if(screen==='game'){
      const player=Game.player;
      if(!player||player.dead)return;
      manageBossTargetPriority();
      const s=Input.getState();const m=computeMovement();s.joyX=m.x;s.joyY=m.y;
      tryUseSkill(now);return;
    }
    if(screen==='levelup'){schedulePickCard();return;}
    if(screen==='result'||screen==='menu'){
      if(!_restartTimer){
        _restartTimer=setTimeout(async()=>{
          _restartTimer=null;if(aiEnabled)await doStartRun();
        },screen==='menu'?1200:CFG_AI.RESTART_DELAY);
      }
    }
  }

  function startAI(){
    if(aiEnabled)return;aiEnabled=true;_aiSetBossMode=false;
    log('AI bật');updatePanel();_rafId=requestAnimationFrame(tick);
    const s=activeScreen();
    if(s==='menu'||s==='result'){
      _restartTimer=setTimeout(async()=>{_restartTimer=null;if(aiEnabled)await doStartRun();},800);
    }
  }
  function stopAI(){
    aiEnabled=false;
    if(_rafId){cancelAnimationFrame(_rafId);_rafId=null;}
    if(_restartTimer){clearTimeout(_restartTimer);_restartTimer=null;}
    try{const s=Input.getState();s.joyX=0;s.joyY=0;}catch(_){}
    if(_aiSetBossMode){setTargetPriority('nearest');_aiSetBossMode=false;}
    log('AI tắt');updatePanel();
  }
  function watchScreens(){
    new MutationObserver(()=>{if(!aiEnabled||_rafId)return;_rafId=requestAnimationFrame(tick);})
      .observe(document.body,{attributes:true,subtree:true,attributeFilter:['class']});
  }

  const CSS=`
    #ai-panel{position:fixed;bottom:100px;right:12px;z-index:99999;
      background:rgba(4,2,12,.92);border:1.5px solid rgba(120,60,220,.6);
      border-radius:12px;padding:12px 14px 10px;width:168px;
      backdrop-filter:blur(8px);font-family:'Segoe UI',sans-serif;
      user-select:none;touch-action:none;box-shadow:0 0 18px rgba(100,40,200,.3);}
    #ai-title{text-align:center;letter-spacing:3px;font-size:9px;
      font-weight:700;color:#6030a0;margin-bottom:10px;}
    #ai-btn{width:100%;padding:8px 0;font-size:12px;font-weight:700;
      letter-spacing:2px;border-radius:7px;border:1.5px solid rgba(120,60,220,.7);
      background:rgba(120,60,220,.12);color:#8040cc;cursor:pointer;transition:all .2s;-webkit-appearance:none;}
    #ai-btn.on{background:linear-gradient(135deg,rgba(140,60,255,.75),rgba(60,0,130,.85));
      border-color:#c090ff;color:#fff;box-shadow:0 0 14px rgba(160,96,255,.6);}
    #ai-btn.boss{background:linear-gradient(135deg,rgba(200,30,30,.8),rgba(100,0,0,.9));
      border-color:#ff6060;color:#fff;box-shadow:0 0 14px rgba(255,60,60,.6);}
    #ai-status{text-align:center;color:#3a1850;letter-spacing:.5px;
      margin-top:7px;font-size:9.5px;min-height:13px;}
    #ai-status.on{color:#8040c0;}
    #ai-status.boss{color:#ff6060;font-weight:700;}
    #ai-sep{border:none;border-top:1px solid rgba(100,40,200,.2);margin:8px 0;}
    .ai-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;}
    .ai-row label{color:#4a2870;font-size:8.5px;letter-spacing:.5px;min-width:62px;}
    .ai-row input{flex:1;margin-left:6px;accent-color:#a060ff;cursor:pointer;}
    .ai-row span{font-size:8.5px;color:#7040a0;min-width:28px;text-align:right;}
    #ai-profile{margin-top:5px;font-size:8px;color:#4a2070;text-align:center;
      letter-spacing:.5px;min-height:12px;}
    #ai-log{margin-top:4px;color:#3a1850;font-size:8.5px;line-height:1.5;
      min-height:13px;word-break:break-all;}
    #ai-log.active{color:#6030a0;}
    #ai-log.boss{color:#ff5050;}
  `;

  function injectPanel(){
    const st=document.createElement('style');st.textContent=CSS;document.head.appendChild(st);
    const d=document.createElement('div');d.id='ai-panel';
    d.innerHTML=`
      <div id="ai-title">🤖 AI AUTO-PLAY</div>
      <button id="ai-btn">▶ BẬT AI</button>
      <div id="ai-status">Chờ lệnh...</div>
      <hr id="ai-sep">
      <div class="ai-row">
        <label>SKILL R</label>
        <input id="ai-skill-r" type="range" min="100" max="400" step="20" value="280">
        <span id="ai-skill-val">280</span>
      </div>
      <div id="ai-profile">—</div>
      <div id="ai-log">—</div>`;
    document.body.appendChild(d);
    document.getElementById('ai-btn').addEventListener('click',()=>aiEnabled?stopAI():startAI());
    document.getElementById('ai-skill-r').addEventListener('input',function(){
      CFG_AI.SKILL_RANGE=+this.value;document.getElementById('ai-skill-val').textContent=this.value;
    });
    setInterval(()=>{
      const profEl=document.getElementById('ai-profile');
      const btnEl=document.getElementById('ai-btn');
      const stEl=document.getElementById('ai-status');
      if(!profEl||!aiEnabled)return;
      const p=Game?.player;
      const bossNow=Game?.bossSpawned&&!Game?.bossKilled;
      const charId=p?.charData?.id;
      const prof=charId?(CHAR_PROFILE[charId]||DEFAULT_PROFILE):null;
      profEl.textContent=prof?`${charId.replace('_',' ')} | opt:${prof.optimalDist}px`:'—';
      if(bossNow){
        btnEl.className='on boss';stEl.textContent='🔴 ĐÁ BOSS';stEl.className='boss';
        const lg=document.getElementById('ai-log');if(lg)lg.className='boss';
      }else if(aiEnabled){btnEl.className='on';stEl.textContent='🟢 Đang chạy';stEl.className='on';}
    },300);
  }

  function updatePanel(){
    const btn=document.getElementById('ai-btn');
    const st=document.getElementById('ai-status');
    const lg=document.getElementById('ai-log');
    if(!btn)return;
    if(aiEnabled){btn.className='on';btn.textContent='⏹ TẮT AI';st.textContent='🟢 Đang chạy';st.className='on';}
    else{btn.className='';btn.textContent='▶ BẬT AI';st.textContent='Chờ lệnh...';st.className='';if(lg){lg.textContent='—';lg.className='';}}
  }

  function boot(){
    const id=setInterval(()=>{
      if(typeof Game!=='undefined'&&typeof Input!=='undefined'&&typeof Save!=='undefined'&&
         typeof UI!=='undefined'&&typeof Tutorial!=='undefined'&&
         typeof CHARS!=='undefined'&&typeof MAPS!=='undefined'&&typeof PETS!=='undefined'&&
         activeScreen()!=='loading'){
        clearInterval(id);injectPanel();watchScreens();log('Ready.');
      }
    },200);
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',boot):boot();
})();
