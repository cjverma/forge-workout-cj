import { ctx } from "./runtime.js";
import { ACTIVE_MULT, USER, calcBMR, calcTarget, isoDate, isoToday, latestWeightLog, phaseFor, restingFor } from "./phase.js";
import { esc, mdLite, showToast } from "./ui.js";
import { save } from "./state.js";
import { API_CFG, queueDayMeta, queueMutation, queueSettings } from "./sync.js";
import { FIBRE_TARGET, SUGAR_LIMIT, SODIUM_LIMIT } from "./constants.js";

function fetchT(url, opts, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

// ── NUTRITION ──────────────────────────────────────────
function nutShift(delta){
  const d=new Date(_nutDate+"T12:00:00");d.setDate(d.getDate()+delta);
  const next=d.toISOString().slice(0,10);
  if(next>isoToday())return;
  _nutDate=next;_pendingFood=null;_foodChatOpen=false;_foodSearchOpen=false;_foodSearchQ="";renderNutrition();
}
function nutDateLabel(iso){
  const today=isoToday();
  const d=new Date(iso+"T12:00:00");
  const lbl=d.toLocaleDateString("en-AU",{weekday:"short",month:"short",day:"numeric"});
  return iso===today?lbl+" (Today)":lbl;
}
function getDayData(date){
  if(!S.nutrition.days[date])S.nutrition.days[date]={items:[]};
  const d=S.nutrition.days[date];
  if(!d.items)d.items=[];
  return d;
}
let _nutUnlocked={}; // session-only edit unlocks per date
function nutLocked(date){return date<isoToday()&&!_nutUnlocked[date];}
function unlockNut(date){_nutUnlocked[date]=true;renderNutrition();showToast("Editing unlocked for this day");}
function lockNut(date){delete _nutUnlocked[date];renderNutrition();}
// ── 7-DAY TRENDS + DRAWER ──
function buildTrendData(){
  const out=[];const lw=latestWeightLog()||USER.weightKg;
  for(let i=6;i>=0;i--){
    const d=new Date(isoToday()+"T12:00:00");d.setDate(d.getDate()-i);
    const iso=isoDate(d);
    const nd=S.nutrition.days?.[iso]||{};
    const items=nd.items||[];
    const consumed=items.reduce((s,it)=>s+(it.kcal||0),0);
    const protein=items.reduce((s,it)=>s+(it.protein||0),0);
    const fibre=items.reduce((s,it)=>s+(it.fibre||0),0);
    const active=nd.active||0;
    const burn=(nd.restingOverride!=null?nd.restingOverride:calcBMR(lw))+Math.round(active*ACTIVE_MULT);
    out.push({iso,lbl:"SMTWTFS"[d.getDay()],protein,fibre,consumed,burn:consumed||active?burn:0,deficit:consumed?burn-consumed:null,trained:trainedOn(iso)||active>0,isToday:iso===isoToday()});
  }
  return out;
}
function tbarChart(title,data,getVal,getCol,legend){
  const vals=data.map(getVal);
  const nonNull=vals.filter(v=>v!=null&&v!==0).map(v=>Math.abs(v));
  if(!nonNull.length)nonNull.push(1);
  const hi=Math.max(...nonNull);
  // Only use values above 40% of max to set the floor — prevents a partial
  // today (e.g. 31g at 2pm) collapsing the scale so 176/182/196 look identical.
  const significant=nonNull.filter(v=>v>hi*0.4);
  const lo=significant.length?Math.min(...significant):0;
  const spread=hi-lo;
  const floor=Math.max(0,lo-spread*1.2);
  const range=hi-floor||1;
  return`<div class="trend-card"><div class="trend-title">${title}${legend?`<span class="trend-legend">${legend}</span>`:""}</div><div class="tbars">${data.map((d,i)=>{
    const v=vals[i];
    const h=v==null?0:Math.max(3,Math.round((Math.abs(v)-floor)/range*54));
    return`<div class="tbar-col"><div class="tbar-val">${v==null?"":Math.round(Math.abs(v))}</div><div class="tbar" style="height:${h}px;background:${getCol(d,v)}"></div><div class="tbar-lbl${d.isToday?" today":""}">${d.lbl}</div></div>`;
  }).join("")}</div></div>`;
}
function weight30Chart(){
  const wts=S.nutrition.weights||{};
  const keys=Object.keys(wts).sort().slice(-30);
  if(keys.length<2)return`<div class="trend-card"><div class="trend-title">Weight · 30 days</div><div style="font-size:11px;color:var(--dim)">Need at least 2 weigh-ins.</div></div>`;
  return`<div class="trend-card"><div class="trend-title">Weight · 30 days</div>${buildSparkline(keys,wts,true)}</div>`;
}
function renderDrawer(){
  const t=buildTrendData();
  const pTarget=Math.round(USER.targetKg*2);
  document.getElementById("drawerContent").innerHTML=`
    <div class="drawer-head"><div class="drawer-title">Insights</div><button class="drawer-close" onclick="closeDrawer()">✕</button></div>
    <div class="st-sec">7-Day Trends</div>
    ${tbarChart("Protein g/day",t,d=>d.protein,(d,v)=>v>=pTarget?"var(--green)":"var(--b2)",`target ${pTarget}g`)}
    ${tbarChart("Calorie burn",t,d=>d.burn,d=>d.trained?"var(--orange)":"var(--b2)",`<span style="color:var(--orange)">▮</span> trained · <span style="color:var(--b2)">▮</span> rest`)}
    ${tbarChart("Daily deficit",t,d=>d.deficit,(d,v)=>v==null?"var(--b2)":v>=0?"var(--green)":"var(--red)","green = deficit")}
    ${weight30Chart()}
    <div class="st-sec">AI Coaching</div>
    <div class="ai-card" style="margin-bottom:10px"><div class="ai-card-title">🔄 Machine Busy?</div><input class="ai-inp" id="si" placeholder='e.g. "chest press 20kg is busy"'><button class="ai-btn" onclick="aiRun('sub')">Find Alternative</button><div class="ai-out" id="so"></div></div>
    <div class="ai-card"><div class="ai-card-title">💤 How Hard Should I Train?</div><div class="g2"><div><label class="ai-lbl">CPAP Score</label><input class="ai-sm" id="sl" type="number" placeholder="91"></div><div><label class="ai-lbl">Energy (1-10)</label><input class="ai-sm" id="en" type="number" placeholder="7"></div><div><label class="ai-lbl">Soreness (1-10)</label><input class="ai-sm" id="sr" type="number" placeholder="3"></div><div><label class="ai-lbl">Calf Pain</label><select class="ai-sm" id="cp"><option value="none">None</option><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option></select></div></div><button class="ai-btn" onclick="aiRun('recovery')">Analyse Recovery</button><div class="ai-out" id="ro"></div></div>
    <details class="st-acc">
      <summary><div><div>🏆 Personal Records</div><div class="st-acc-sub">Est. 1RM · progress over time</div></div></summary>
      <div class="st-acc-inner">
    ${(()=>{
      // EX_NAMES keyed by canonical name-slug (same as _prCanonMap values)
      const EX_NAMES={};
      for(const[,dd] of Object.entries(PROG))for(const ex of(dd.exercises||[])){const cid=canonicalId(ex.id);if(!EX_NAMES[cid])EX_NAMES[cid]=ex.name;}
      // Custom exercises live in S.custom (not PROG) — seed their names too so
      // PR entries stored under "c_<ts>" ids resolve to real names
      for(const arr of Object.values(S.custom||{}))for(const ex of(arr||[])){const cid=canonicalId(ex.id);if(!EX_NAMES[cid])EX_NAMES[cid]=ex.name;}
      const exName=id=>EX_NAMES[id]||(id.startsWith("c_")?"Custom exercise":id);
      // Leaderboard card (top 5 by est 1RM across all PRs)
      const allPRs=Object.entries(S.prs||{});
      let leaderHtml="";
      if(allPRs.length){
        const rows=allPRs
          .map(([id,entries])=>{if(!entries||!entries.length)return null;const best=entries.reduce((b,e)=>e.est>b.est?e:b,entries[0]);return{id,best};})
          .filter(Boolean)
          .sort((a,b)=>b.best.est-a.best.est)
          .slice(0,5)
          .map(({id,best},idx)=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--b1);font-size:12px"><span style="color:var(--dim);width:14px">${idx+1}</span><span style="flex:1;color:var(--mid)">${exName(id)}</span><span style="font-weight:700;color:var(--white)">${best.est}kg</span></div>`)
          .join("");
        leaderHtml=`<div style="background:var(--s2);border:1px solid var(--b1);border-radius:12px;padding:14px 16px;margin-bottom:12px"><div style="font-size:10px;color:var(--dim);letter-spacing:0.5px;margin-bottom:8px">STRONGEST LIFTS (EST. 1RM)</div>${rows}</div>`;
      }
      // Per-exercise rows: all exercises with PRs first, then key exercises without
      const KEY_IDS=["chest_press_machine","incline_chest_press_machine","pec_fly_machine","seated_cable_row","chest_supported_row","tricep_extension_machine","leg_press_machine","seated_leg_curl","hip_abduction_machine","seated_calf_raise","hammer_curl"];
      const withPR=Object.keys(S.prs||{});
      // Merge: PRd exercises + key exercises not yet PR'd (dedupe by name)
      const seenNames=new Set();
      const exList=[];
      // First: all exercises that have PRs
      withPR.forEach(id=>{const name=exName(id);if(!seenNames.has(name)){seenNames.add(name);exList.push({id,name});}});
      // Then: key exercises without PRs yet (skip if same name already added)
      KEY_IDS.forEach(id=>{const name=exName(id);if(!seenNames.has(name)&&!withPR.includes(id)){seenNames.add(name);exList.push({id,name});}});
      const exRows=exList.map(({id,name})=>{
        const pr=bestPR(id);
        const prEntries=S.prs[id]||[];
        const dateMap={};
        prEntries.forEach(e=>{if(!dateMap[e.date]||e.est>dateMap[e.date])dateMap[e.date]=e.est;});
        const sparkKeys=Object.keys(dateMap).sort();
        const sparkHtml=sparkKeys.length>=2?buildSparkline(sparkKeys,dateMap,false):"";
        return `<div class="rule-item" onclick="closeDrawer();setTimeout(()=>{const el=document.getElementById('ex-${id}');if(el)el.scrollIntoView({behavior:'smooth',block:'center'});},200)" style="cursor:pointer">
          <div class="rule-ttl">${name}</div>
          <div class="rule-desc">${pr?`Est. 1RM: ${pr.est}kg · ${pr.weight}kg×${pr.reps} · ${pr.date}`:"No PR recorded yet"}</div>
          ${sparkHtml}
        </div>`;
      }).join("");
      return leaderHtml+exRows;
    })()}
      </div>
    </details>
    <details class="st-acc">
      <summary><div><div>🦴 Spine Rules</div><div class="st-acc-sub">Movement restrictions</div></div></summary>
      <div class="st-acc-inner">
        <div class="rule-item"><div class="rule-ttl">No overhead movements</div><div class="rule-desc">Standard lat pulldown, overhead press, any reach under load.</div></div>
        <div class="rule-item"><div class="rule-ttl">No axial compression</div><div class="rule-desc">Barbell squat, deadlift, good mornings. Permanently off the table.</div></div>
        <div class="rule-item"><div class="rule-ttl">Bike first, always</div><div class="rule-desc">Hip flexion decompresses the spine before any loading. Never skip.</div></div>
        <div class="rule-item"><div class="rule-ttl">Nerve symptom · sit down immediately</div><div class="rule-desc">3+ episodes in one session means end or modify the session.</div></div>
        <div class="rule-item"><div class="rule-ttl">Core gently braced throughout</div><div class="rule-desc">Light stomach tightening during all exercises. Protects the lumbar spine.</div></div>
      </div>
    </details>`;
}
function openDrawer(){renderDrawer();document.getElementById("drawer").classList.add("open");document.getElementById("drawerOverlay").classList.add("open");}
function closeDrawer(){document.getElementById("drawer").classList.remove("open");document.getElementById("drawerOverlay").classList.remove("open");}
function macroPie(protein,carbs,fat,fibre){
  const pK=Math.round(protein*4),cK=Math.round(carbs*4),fK=Math.round(fat*9),fiK=Math.round(fibre*2);
  const tot=pK+cK+fK+fiK;
  if(!tot)return'';
  const p=(pK/tot*100).toFixed(1),pc=((pK+cK)/tot*100).toFixed(1),pcf=((pK+cK+fK)/tot*100).toFixed(1);
  return`<div class="mpie-wrap"><div class="mpie-donut" style="background:conic-gradient(var(--chart-p) 0% ${p}%,var(--chart-c) ${p}% ${pc}%,var(--chart-f) ${pc}% ${pcf}%,var(--chart-fi) ${pcf}% 100%)"><div class="mpie-hole"></div></div><div class="mpie-legend"><div class="mpie-row"><span class="mpie-dot" style="background:var(--chart-p)"></span>Protein<span class="mpie-val">${pK} kcal</span></div><div class="mpie-row"><span class="mpie-dot" style="background:var(--chart-c)"></span>Carbs<span class="mpie-val">${cK} kcal</span></div><div class="mpie-row"><span class="mpie-dot" style="background:var(--chart-f)"></span>Fat<span class="mpie-val">${fK} kcal</span></div>${fibre?`<div class="mpie-row"><span class="mpie-dot" style="background:var(--chart-fi)"></span>Fibre<span class="mpie-val">${fibre}g</span></div>`:""}</div></div>`;
}
export function renderNutrition(){
  const date=_nutDate;
  const ro=nutLocked(date);
  {const _p=phaseFor(isoToday());if(_p)recordWeekCompliance(_p);}
  const day=getDayData(date);
  const lw=latestWeightLog()||USER.weightKg;
  const bmr=calcBMR(lw);
  const resting=restingFor(date,day);
  const restOvr=day.restingOverride!=null?day.restingOverride:null;
  const active=day.active||0;
  const totalBurn=resting+Math.round(active*ACTIVE_MULT);
  const {target,phase}=calcTarget(resting,Math.round(active*ACTIVE_MULT),date);
  const shock=day.shockProtocol;
  const finalTarget=shock?1500:target;
  const items=day.items||[];
  const consumed=items.reduce((s,i)=>s+i.kcal,0);
  const protein=items.reduce((s,i)=>s+(i.protein||0),0);
  const carbs=items.reduce((s,i)=>s+(i.carbs||0),0);
  const fat=items.reduce((s,i)=>s+(i.fat||0),0);
  const fibre=items.reduce((s,i)=>s+(i.fibre||0),0);
  const sugar=items.reduce((s,i)=>s+(i.sugar||0),0);
  const sodium=items.reduce((s,i)=>s+(i.sodium||0),0);
  const pct=finalTarget?Math.min(100,Math.round((consumed/finalTarget)*100)):0;
  const netDef=consumed-totalBurn;
  // Protein target: 2g × goal weight, +10% on days with training or logged active burn
  const trained=trainedOn(date)||active>0;
  const pTarget=Math.round(USER.targetKg*2*(trained?1.1:1));
  const ratio=finalTarget?consumed/finalTarget:0;
  const pillCls=ratio<0.9?"tpill-green":ratio<=1.1?"tpill-amber":"tpill-red";
  const pillTxt=ratio<0.9?"Under target":ratio<=1.1?"On track":"Over target";
  const foodListHtml=items.length?items.map(it=>{const t=it.time?new Date(it.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"";return`<div class="food-item"><div style="flex:1"><div class="food-name">${esc(it.name)}${t?`<span style="font-size:10px;color:var(--dim);font-weight:400;margin-left:6px">${t}</span>`:""}</div><div class="food-macros">P ${it.protein||0}g · C ${it.carbs||0}g · F ${it.fat||0}g</div></div><div style="display:flex;align-items:center;gap:4px"><div class="food-kcal">${it.kcal} kcal</div>${ro?"":`<button class="food-del" onclick="delFood('${date}','${it.id}')">Delete</button>`}</div></div>`;}).join(""):"";
  const wts=S.nutrition.weights||{};
  const allWtKeys=Object.keys(wts).sort();
  const WT_PAGE=5;
  const wtTotalPages=Math.max(1,Math.ceil(allWtKeys.length/WT_PAGE));
  if(_wtPage>=wtTotalPages)_wtPage=wtTotalPages-1;
  const wtPageStart=Math.max(0,allWtKeys.length-WT_PAGE*(_wtPage+1));
  const wtPageEnd=allWtKeys.length-WT_PAGE*_wtPage;
  const wtKeys=allWtKeys.slice(wtPageStart,wtPageEnd||undefined);
  const sparkHtml=buildSparkline(allWtKeys.slice(-30),wts);
  const arrHtml=arrivalEst();
  const liveBMR=calcBMR(latestWeightLog()||USER.weightKg);
  const remaining=Math.max(0,finalTarget-consumed);
  document.getElementById("tc").innerHTML=`<div class="nut-wrap">
    <div class="nut-head">
      <div><div class="nut-kicker">Nutrition</div><div class="nut-title">${nutDateLabel(date)}</div></div>
      <div class="nut-nav-btns">
        ${date<isoToday()?`<button onclick="${ro?`unlockNut('${date}')`:`lockNut('${date}')`}" title="${ro?"Unlock editing":"Lock editing"}">${ro?"✏️":"🔓"}</button>`:""}
        <button onclick="nutShift(-1)">‹</button>
        <button onclick="nutShift(1)" ${date>=isoToday()?"disabled style='opacity:.3'":""}>›</button>
      </div>
    </div>

    <!-- Intake hero card -->
    <div class="nut-card nut-hero">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <div class="nut-card-title">Intake</div>
        <div class="target-pill-g ${pillCls}">${pillTxt}</div>
      </div>
      <div class="nut-ring-wrap">
        <svg width="128" height="128" viewBox="0 0 128 128">
          <circle cx="64" cy="64" r="56" fill="none" stroke="var(--hero-line)" stroke-width="10"/>
          <circle cx="64" cy="64" r="56" fill="none" stroke="var(--hero-accent)" stroke-width="10" stroke-linecap="round"
            stroke-dasharray="351.86" stroke-dashoffset="${(351.86*(1-Math.min(pct,100)/100)).toFixed(1)}"
            transform="rotate(-90 64 64)" class="nut-ring-fill"/>
        </svg>
        <div class="nut-ring-text">
          <div class="nut-ring-big">${remaining.toLocaleString()}</div>
          <div class="nut-ring-small">kcal remaining</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--hero-fg-dim);margin-bottom:4px">${consumed.toLocaleString()} eaten · ${finalTarget.toLocaleString()} target${shock?" · shock day":""}</div>
      <div class="net-line ${netDef<=0?"net-green":"net-red"}" style="text-align:left;margin-bottom:0">${netDef<=0?"✓ Deficit":"⚠ Surplus"} ${Math.abs(netDef).toLocaleString()} kcal vs burn</div>
      ${phase?(()=>{
        // Active compliance: raw Watch kcal vs the phase's daily active target
        const aTgt=phaseActiveTarget(phase,date);
        const aPct=aTgt?Math.round(active/aTgt*100):0;
        const lbl=aPct>=95?"Excellent":aPct>=80?"Good":"Needs improvement";
        const met=aPct>=95;
        const remain=Math.max(0,aTgt-active);
        return`<div style="font-size:11px;color:${met?"var(--hero-pos)":"var(--hero-fg-dim)"};margin-top:4px;text-align:left">⚡ Active ${active.toLocaleString()} / ${aTgt.toLocaleString()} · ${aPct}%${remain>0?` · ${remain.toLocaleString()} kcal remaining`:""} · ${lbl}</div>`;
      })():""}
      ${macroPie(protein,carbs,fat,fibre)}
      <div class="macro-row">
        <div class="macro-chip"><div class="macro-val" style="${protein>=pTarget?"color:var(--hero-pos)":""}">${protein}<span style="font-size:11px;color:var(--hero-fg-faint)">/${pTarget}g</span></div><div class="macro-lbl">Protein${trained?" ⚡":""}</div></div>
        <div class="macro-chip"><div class="macro-val">${carbs}g</div><div class="macro-lbl">Carbs</div></div>
        <div class="macro-chip"><div class="macro-val">${fat}g</div><div class="macro-lbl">Fat</div></div>
      </div>
      <div class="macro-row">
        <div class="macro-chip"><div class="macro-val" style="font-size:14px;${fibre>=FIBRE_TARGET?"color:var(--hero-pos)":""}">${fibre}<span style="font-size:10px;color:var(--hero-fg-faint)">/${FIBRE_TARGET}g</span></div><div class="macro-lbl">Fibre</div></div>
        <div class="macro-chip"><div class="macro-val" style="font-size:14px;${sugar>SUGAR_LIMIT?"color:var(--amber)":""}">${sugar}g</div><div class="macro-lbl">Sugar</div></div>
        <div class="macro-chip"><div class="macro-val" style="font-size:14px;${sodium>SODIUM_LIMIT?"color:var(--amber)":""}">${sodium.toLocaleString()}<span style="font-size:10px;color:var(--hero-fg-faint)">mg</span></div><div class="macro-lbl">Sodium</div></div>
      </div>
      ${ro?"":`<button class="shock-btn${shock?" active":""}" onclick="toggleShock('${date}')">${shock?"⚡ Shock Day Active · Tap to Disable":"⚡ Shock Day (force 1500 kcal)"}</button>`}
    </div>

    <!-- Food log card -->
    <div class="nut-card">
      <div class="nut-card-title">Food Log${items.length?` <span style="font-size:11px;font-weight:400;color:var(--dim)">${items.length} item${items.length!==1?"s":""} · ${consumed.toLocaleString()} kcal</span>`:""}</div>
      ${foodListHtml?`<div class="food-list" style="margin-bottom:10px">${foodListHtml}</div>`:""}
      ${_pendingFood?(()=>{
        const arr=Array.isArray(_pendingFood)?_pendingFood:[_pendingFood];
        const tot=arr.reduce((s,p)=>s+p.kcal,0);
        const rows=arr.map(p=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--b1)"><div><div style="font-size:13px;font-weight:600">${esc(p.name)}</div><div style="font-size:11px;color:var(--dim)">${p.kcal} kcal · P ${p.protein}g · C ${p.carbs}g · F ${p.fat}g</div></div>${arr.length>1?`<button class="food-del" onclick="dropPending('${p.id}')">✕</button>`:""}</div>`).join("");
        return`<div class="pending-food">${rows}<div class="pending-macros" style="margin-top:8px">Total: ${tot} kcal</div><div class="pending-btns"><button class="pf-add" onclick="confirmFood('${date}')">✓ Add ${arr.length>1?"all "+arr.length:""}</button><button class="pf-redo" onclick="redoFood()">Re-enter</button></div></div>`;
      })():""}
      ${ro?"":_foodSearchOpen?(()=>{
        const allFoods=buildFoodHistory(date);
        const q=_foodSearchQ.toLowerCase().trim();
        const filtered=q?allFoods.filter(f=>f.name.toLowerCase().includes(q)):allFoods;
        const rows=filtered.slice(0,40).map(f=>{
          const args=`'${date}','${(f.name||"").replace(/\\/g,"\\\\").replace(/'/g,"\\'")}',${f.kcal},${f.protein||0},${f.carbs||0},${f.fat||0},${f.fibre||0},${f.sugar||0},${f.sodium||0}`;
          return`<div onclick="quickAddRecent(${args});_foodSearchOpen=false;_foodSearchQ='';renderNutrition()" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--b1);cursor:pointer;active:background:var(--s2)">
            <div>
              <div style="font-size:13px;font-weight:600;color:var(--white)">${esc(f.name)}</div>
              <div style="font-size:11px;color:var(--dim);margin-top:2px">${f.kcal} kcal · P ${f.protein||0}g · C ${f.carbs||0}g · F ${f.fat||0}g${f.kcal>0?` · <span style="color:var(--amber)">${Math.round((f.protein||0)*400/f.kcal)}% protein</span>`:""}${f.n>1?` · ${f.n}×`:""}</div>
            </div>
            <span style="font-size:20px;color:var(--amber);padding-left:12px">+</span>
          </div>`;
        }).join("");
        return`<div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <input id="foodSearchInp" type="search" placeholder="Search past foods…" value="${esc(_foodSearchQ)}"
              oninput="filterFoodSearch(this.value,'${date}')"
              style="flex:1;background:var(--s2);border:1px solid var(--b2);border-radius:10px;padding:10px 13px;font-size:14px;color:var(--white);font-family:'Inter',sans-serif;outline:none"
              autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            <button onclick="_foodSearchOpen=false;_foodSearchQ='';renderNutrition()" style="background:transparent;border:none;color:var(--dim);font-size:22px;cursor:pointer;padding:0 4px">✕</button>
          </div>
          <div id="foodSearchResults" style="max-height:340px;overflow-y:auto">${rows||`<div style="color:var(--dim);font-size:13px;padding:16px 0;text-align:center">No matches found</div>`}</div>
        </div>`;
      })():_foodChatOpen?(()=>{
        const recents=recentFoods(date);
        const chips=recents.length?`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${recents.map(f=>`<button onclick="quickAddRecent('${date}','${esc(f.name).replace(/'/g,"\\'")}',${f.kcal},${f.protein||0},${f.carbs||0},${f.fat||0},${f.fibre||0},${f.sugar||0},${f.sodium||0})" style="background:var(--s2);border:1px solid var(--b2);border-radius:99px;padding:6px 12px;font-family:'Inter',sans-serif;font-size:11px;color:var(--lt);cursor:pointer">+ ${esc(f.name)} <span style="color:var(--dim)">${f.kcal}</span></button>`).join("")}</div>`:"";
        return`<div><input class="food-ta" id="foodMealName" placeholder="Meal name (optional — e.g. Morning oats, Post-workout)" style="margin-bottom:7px;height:auto;min-height:0;padding:10px 13px;font-size:13px;resize:none" maxlength="60" value="${esc(_foodDraftMealName)}" oninput="_foodDraftMealName=this.value"><textarea class="food-ta" id="foodTa" placeholder="What did you eat? e.g. 2 eggs on toast, chicken wrap..." rows="3" oninput="_foodDraftText=this.value">${esc(_foodDraftText)}</textarea><div class="ai-out" id="foodOut"></div><div class="food-chat-btns"><button class="food-submit" onclick="askFood()">Estimate with AI</button><button class="food-cancel" onclick="closeFood()">Cancel</button></div>${chips}</div>`;
      })():`${!items.length?`<div style="font-size:12px;color:var(--dim);margin-bottom:10px;text-align:center">Nothing logged yet · ${(finalTarget-0).toLocaleString()} kcal remaining</div>`:""}
<div style="display:flex;gap:8px;align-items:center"><button class="add-food-btn" style="flex:1" onclick="openFood()">+ Log a Meal</button><button onclick="_foodSearchOpen=true;_foodSearchQ='';renderNutrition();setTimeout(()=>{const i=document.getElementById('foodSearchInp');if(i)i.focus();},50)" title="Search past logs" style="flex:0 0 auto;padding:11px 14px;background:transparent;border:1px dashed var(--b2);border-radius:8px;font-size:14px;cursor:pointer;color:var(--dim);font-family:'Inter',sans-serif;font-weight:600;letter-spacing:1px;white-space:nowrap">🔍</button></div>`}
    </div>

    <!-- Body card: daily burn inputs + weight logging in one place -->
    <div class="nut-card">
      <div class="nut-card-title">Body</div>
      <div class="burn-row">
        <div class="burn-col"><input class="burn-inp" id="bvRest" type="number" inputmode="numeric" enterkeyhint="done" value="${resting}" ${ro?'disabled':''} onchange="saveBurn('${date}','resting',this.value)" onfocus="this.select()"><div class="burn-lbl">Resting${restOvr!=null?" (custom)":""}</div></div>
        <div class="burn-sep"></div>
        <div class="burn-col"><input class="burn-inp" id="bvAct" type="number" inputmode="numeric" enterkeyhint="done" placeholder="0" value="${active||""}" ${ro?'disabled':''} onchange="saveBurn('${date}','active',this.value)" onfocus="this.select()"><div class="burn-lbl">Active</div></div>
        <div class="burn-sep"></div>
        <div class="burn-col"><div class="burn-val">${totalBurn}</div><div class="burn-lbl">Total</div></div>
        <div class="burn-sep"></div>
        <div class="burn-col${ro?"":" tappable"}" ${ro?"":`onclick="toggleWtOpen()"`} style="cursor:${ro?"default":"pointer"}">
          <div class="burn-val" style="${allWtKeys.length?"":"color:var(--dim)"}">${(()=>{if(!allWtKeys.length)return"—";const cur=wts[allWtKeys[allWtKeys.length-1]];const curFmt=Number(cur).toFixed(1);if(allWtKeys.length<2)return curFmt;const delta=cur-wts[allWtKeys[allWtKeys.length-2]];const arrow=delta<0?'<span style="font-size:11px;color:var(--green)"> ↓'+Math.abs(delta).toFixed(1)+"</span>":delta>0?'<span style="font-size:11px;color:var(--red)"> ↑'+delta.toFixed(1)+"</span>":"";return curFmt+arrow;})()}</div>
          <div class="burn-lbl">Weight${allWtKeys.length?" kg":""}</div>
        </div>
      </div>
      ${ro?"":_wtOpen
        ? `<div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--b1)"><input class="wt-inp" id="wtInp" type="number" step="0.1" placeholder="e.g. 138.5" inputmode="decimal" enterkeyhint="done" style="flex:1" onkeydown="if(event.key==='Enter'){event.preventDefault();saveWeight('${date}');}"><button class="wt-save" onclick="saveWeight('${date}')">Save</button><button class="food-cancel" onclick="toggleWtOpen()">✕</button></div>`
        : `<button onclick="toggleWtOpen()" style="width:100%;margin-top:10px;padding:9px;background:transparent;border:1px dashed var(--b2);border-radius:8px;font-family:'Inter',sans-serif;font-size:12px;font-weight:600;letter-spacing:1px;color:var(--dim);cursor:pointer;text-transform:uppercase">${allWtKeys.length?"+ Update Weight":"+ Log Weight"}</button>`
      }
    </div>

    <div class="st-sec">Progress</div>

    ${phaseCardHtml()}

    ${S.dietReview?.text?`<!-- Weekly AI diet review · generated server-side by the Sunday-midnight cron; button re-runs it on demand -->
    <details class="st-acc">
      <summary><div><div>🥗 Weekly Diet Review</div><div class="st-acc-sub">Week of ${new Date(S.dietReview.weekStart+"T12:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})} · AI feedback on your goals</div></div></summary>
      <div class="st-acc-inner"><div style="font-size:13px;color:var(--lt);line-height:1.7;padding-top:12px">${mdLite(S.dietReview.text)}</div>
      <button id="dietRevBtn" onclick="generateDietReview()" ${_dietRevBusy?"disabled":""} style="margin-top:12px;background:transparent;border:1px dashed var(--b2);border-radius:8px;padding:9px 14px;font-family:'Inter',sans-serif;font-size:12px;font-weight:600;color:var(--dim);cursor:pointer;width:100%">${_dietRevBusy?"Reviewing your week…":"↻ Regenerate review"}</button></div>
    </details>`:`
    <button id="dietRevBtn" onclick="generateDietReview()" ${_dietRevBusy?"disabled":""} style="margin:0 0 14px;background:transparent;border:1px dashed var(--b2);border-radius:10px;padding:12px 14px;font-family:'Inter',sans-serif;font-size:13px;font-weight:600;color:var(--dim);cursor:pointer;width:100%">${_dietRevBusy?"🥗 Reviewing your week…":"🥗 Generate Weekly Diet Review"}</button>`}

    <!-- Weight history & trend -->
    <details class="st-acc" ${_wtExpanded?"open":""} ontoggle="_wtExpanded=this.open">
      <summary><div><div>⚖️ Weight History</div><div class="st-acc-sub">${allWtKeys.length?`${allWtKeys.length} entries · trend, arrival estimate`:"No entries yet"}</div></div></summary>
      <div class="st-acc-inner">
      ${sparkHtml}
      ${wtKeys.length?`<table style="width:100%;border-collapse:collapse;margin:10px 0 6px;font-size:12px">${wtKeys.slice().reverse().map((k,i)=>{const prev=wtKeys[wtKeys.length-2-i];const diff=prev!=null?wts[k]-wts[prev]:null;const col=diff==null?"":diff<0?"var(--green)":diff>0?"var(--red)":"var(--dim)";const diffTxt=diff==null?"":diff===0?"–":(diff>0?"+":"")+diff.toFixed(1)+"kg";return`<tr style="border-bottom:1px solid var(--b1)"><td style="padding:7px 0;color:var(--dim)">${k}</td><td style="padding:7px 0;font-weight:700;color:var(--white);text-align:right">${Number(wts[k]).toFixed(1)} kg</td><td style="padding:7px 0;text-align:right;color:${col};width:56px">${diffTxt}</td>${ro?"":`<td style="padding:7px 0;text-align:right;width:32px"><button onclick="delWeight('${k}')" style="background:transparent;border:none;color:var(--dim);font-size:13px;cursor:pointer;padding:2px 4px">✕</button></td>`}</tr>`;}).join("")}</table>${wtTotalPages>1?`<div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--dim)">${_wtPage>0?`<button onclick="wtPage(${_wtPage-1})" style="background:var(--b1);border:none;color:var(--white);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer">← Newer</button>`:`<span></span>`}<span>Page ${_wtPage+1} of ${wtTotalPages}</span>${_wtPage<wtTotalPages-1?`<button onclick="wtPage(${_wtPage+1})" style="background:var(--b1);border:none;color:var(--white);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer">Older →</button>`:`<span></span>`}</div>`:""}<div class="wt-arrival" style="margin-top:8px">${arrHtml}</div><div class="wt-bmr">BMR (current): ${liveBMR} kcal</div>`:""}
      </div>
    </details>

    <div style="height:20px"></div>
  </div>`;
}
ctx.renderNutrition=renderNutrition;
// Resting/active calorie fields are always-editable inputs (same pattern as
// the workout tab's weight/reps inputs) — commit on change, no tap-to-reveal
// step. Also queues a nutrition_day_meta mutation so these persist through
// the database like weight log already does (previously local-only: any
// server sync would silently wipe them back to the calculated default).
function saveBurn(date,field,val){
  if(nutLocked(date))return;
  val=String(val||"").trim();
  if(field==="resting"){
    if(!S.nutrition.days[date])S.nutrition.days[date]={items:[]};
    if(val===""){delete S.nutrition.days[date].restingOverride;}
    else{const n=parseInt(val);if(isNaN(n)||n<800||n>4000){showToast("Enter 800-4000");renderNutrition();return;}S.nutrition.days[date].restingOverride=n;}
  }else{
    const n=val===""?0:parseInt(val);if(isNaN(n)||n<0){showToast("Enter a valid number");renderNutrition();return;}
    getDayData(date).active=n;
  }
  save();
  queueDayMeta(date);
  // Surgical: don't rebuild the DOM if the user is tapping straight from one
  // burn field into the other — replacing the card mid-tap destroys the
  // target input before focus lands on it, dismissing the iOS keyboard
  // (same issue documented in saveF() for the workout tab's weight/reps
  // inputs). Only re-render once focus has actually left both fields, so
  // the Total/target/progress numbers still refresh once editing is done.
  setTimeout(()=>{
    const a=document.activeElement;
    if(!a||(a.id!=="bvRest"&&a.id!=="bvAct"))renderNutrition();
  },0);
}
function toggleShock(date){
  if(nutLocked(date))return;const day=getDayData(date);day.shockProtocol=!day.shockProtocol;save();queueDayMeta(date);renderNutrition();}
function openFood(){_foodChatOpen=true;_pendingFood=null;renderNutrition();setTimeout(()=>{const ta=document.getElementById("foodTa");if(ta)ta.focus();},50);}
function closeFood(){_foodChatOpen=false;_foodDraftText="";_foodDraftMealName="";renderNutrition();}
let _dietRevBusy=false;
async function generateDietReview(){
  if(_dietRevBusy)return;
  _dietRevBusy=true;renderNutrition();
  try{
    const r=await fetchT(API_CFG.baseUrl+"/api/cron-diet-review",{method:"POST",headers:{"Authorization":"Bearer "+API_CFG.token}},30000);
    const d=await r.json().catch(()=>({}));
    if(r.status===401){showToast("❌ Auth failed · app token doesn't match FORGE_API_TOKEN");return;}
    if(d.skipped){showToast("No food logged this week yet — nothing to review");return;}
    if(!r.ok||!d.ok)throw new Error(d.error||"error");
    await loadServerState(false);
    showToast("✅ Diet review ready");
  }catch(e){
    showToast("❌ Diet review failed — try again");
  }finally{
    _dietRevBusy=false;renderNutrition();
  }
}

// ── PHASE CARD: compliance, health, pause, verdict, AI review ───────────────
const COMPLIANCE_WEIGHTS={calories:0.35,active:0.25,protein:0.20,workouts:0.15,weighins:0.05};
function mondayOfIso(dateIso){const dow=noonUTC(dateIso).getUTCDay();return addDaysIso(dateIso,dow===0?-6:1-dow);}
// Weighted compliance for [weekStartIso .. endIso]. Returns {calculating:true}
// until at least one day has food logged (NaN-safe denominators throughout).
function weekCompliance(p,weekStartIso,endIso){
  const days=[];
  for(let i=0;i<7;i++){const d=addDaysIso(weekStartIso,i);if(d>endIso)break;days.push(d);}
  if(!days.length)return{calculating:true};
  let calOk=0,calLogged=0,protSum=0,protDays=0,actSum=0,actTgtSum=0,workoutDays=0,expWorkout=0,weighins=0;
  for(const d of days){
    const nd=S.nutrition?.days?.[d]||{};const items=nd.items||[];
    const kcal=items.reduce((s,it)=>s+(it.kcal||0),0);
    if(kcal>0){
      calLogged++;
      if(kcal<=p.eatKcal*1.05)calOk++;
      protSum+=items.reduce((s,it)=>s+(it.protein||0),0);protDays++;
    }
    actSum+=nd.active||0;actTgtSum+=phaseActiveTarget(p,d);
    if(!isRestDay(d)){expWorkout++;if(trainedOn(d))workoutDays++;}
    if((S.nutrition.weights||{})[d]!=null)weighins++;
  }
  if(!calLogged)return{calculating:true};
  const m={
    calories:Math.round(calOk/calLogged*100),
    active:Math.min(100,Math.round(actTgtSum?actSum/actTgtSum*100:0)),
    protein:Math.min(100,Math.round(protDays?(protSum/protDays)/(USER.targetKg*2)*100:0)),
    workouts:Math.min(100,Math.round(expWorkout?workoutDays/expWorkout*100:100)),
    weighins:Math.round(weighins/days.length*100),
  };
  m.overall=Math.round(Object.entries(COMPLIANCE_WEIGHTS).reduce((s,[k,w])=>s+m[k]*w,0));
  return m;
}
// Live health colour — same distance bands as the phase-end verdict, applied
// to today's curve point instead of the phase target.
function phaseHealth(p,todayIso){
  const avg=sevenDayAvg(todayIso);
  if(avg==null)return null;
  const d=avg-phaseCurveKg(p,todayIso);
  if(d<=1)return{colour:"green",label:d<-1?"Ahead of schedule":"On track"};
  if(d<=2)return{colour:"yellow",label:"Slightly behind"};
  if(d<=4)return{colour:"orange",label:"Moderately behind"};
  return{colour:"red",label:"Off track — reassess"};
}
// End-of-phase colour bands with the user's prescribed actions, verbatim rule
function phaseVerdict(p,finalAvg){
  const d=finalAvg-p.targetKg;
  if(d<=1)return{band:"green",title:"🟢 On Target",action:"No changes. Continue to the next phase exactly as planned."};
  if(d<=2)return{band:"yellow",title:"🟡 Slightly Behind",action:"Keep calories the same. Increase average active calories by 100/day. Recalculate the next phase."};
  if(d<=4)return{band:"orange",title:"🟠 Moderately Behind",action:"Decision point — Option A: extend the timeline if Feb 20 is flexible. Option B: tighten the next phase in a calculated way (more activity, modest calorie reduction). The original numbers no longer apply as-is."};
  return{band:"red",title:"🔴 Reassess",action:"Stop and reassess before pushing harder: review calorie adherence, food-logging accuracy, Apple Watch data, training consistency, sleep and recovery, Zepbound dose and response, and any injury or illness. Only then adjust calories, activity, or the timeline."};
}
// Exactly one rule-based actionable recommendation (deterministic, no AI)
function coachRecommendation(p,todayIso,comp){
  const h=phaseHealth(p,todayIso);
  if(!h||!comp||comp.calculating)return"Log food and weight consistently this week to unlock recommendations.";
  if(h.colour==="green"&&comp.overall>=90)return"Excellent adherence — avoid the temptation to cut calories further.";
  if(h.colour==="green")return"Stay the course.";
  if(comp.active<90)return"Increase active calories by roughly 100/day next week.";
  if(comp.calories<80)return"Keep more days at or under the calorie target — that's the biggest lever right now.";
  return"Hold targets steady and prioritise consistency over intensity.";
}
// Append last week's score to the quiet compliance history once it's complete
function recordWeekCompliance(p){
  const t=isoToday();
  const thisMon=mondayOfIso(t);
  const lastMon=addDaysIso(thisMon,-7);
  if(lastMon<p.start)return;
  const run=getPhaseRun(p.id);
  if((run.weeks||[]).some(w=>w.week===lastMon))return;
  const comp=weekCompliance(p,lastMon,addDaysIso(lastMon,6));
  if(comp.calculating)return;
  const r=ensurePhaseRun(p.id);
  r.weeks=r.weeks||[];
  r.weeks.push({week:lastMon,overall:comp.overall,perMetric:comp});
  save();queueSettings();
}
let _phasePauseOpen=false;
function pausePhase(id,reason,extend){
  const run=ensurePhaseRun(id);
  run.pauses.push({start:isoToday(),reason,extend:!!extend,resumed:null});
  _phasePauseOpen=false;
  save();queueSettings();renderNutrition();
  showToast("⏸ Phase paused · "+reason+(extend?" · phase will extend":""));
}
function resumePhase(id){
  const open=ensurePhaseRun(id).pauses.find(pa=>!pa.resumed);
  if(open)open.resumed=isoToday();
  save();queueSettings();renderNutrition();
  showToast("▶ Phase resumed");
}
// Completion: verdict + immutable snapshot + quiet analytics, then lock.
// `manual` = the "Accept current result" override — never fight the user.
function completePhase(id,manual){
  const p=PHASES.find(x=>x.id===id);
  if(!p)return;
  const run=ensurePhaseRun(id);
  if(run.locked)return;
  const t=isoToday();
  const finalAvg=sevenDayAvg(t)??latestWeightLog()??p.startKg;
  const v=phaseVerdict(p,finalAvg);
  run.completedAt=t;run.outcome=v.band;run.locked=true;
  const weeks=run.weeks||[];
  const avgCompliance=weeks.length?Math.round(weeks.reduce((s,w)=>s+w.overall,0)/weeks.length):null;
  const phaseDays=Math.max(1,daysBetween(p.start,t));
  let kcalSum=0,kcalDays=0,actSum=0,recovery=0,pauseDays=0;
  for(let i=0;i<phaseDays;i++){
    const d=addDaysIso(p.start,i);
    const nd=S.nutrition?.days?.[d]||{};const items=nd.items||[];
    const kc=items.reduce((s,it)=>s+(it.kcal||0),0);
    if(kc>0){kcalSum+=kc;kcalDays++;}
    actSum+=nd.active||0;
    if(!isRestDay(d)&&!trainedOn(d))recovery++;
  }
  for(const pa of run.pauses){pauseDays+=Math.max(0,daysBetween(pa.start,pa.resumed||t));}
  S.phaseHistory=S.phaseHistory||{};
  S.phaseHistory[id]={
    version:p.version,strategy:p.strategy,start:p.start,plannedEnd:p.plannedEnd,
    effectiveEnd:effectiveEnd(p,t),completedAt:t,startKg:p.startKg,targetKg:p.targetKg,
    actualEndKg:finalAvg,eatKcal:p.eatKcal,
    activeTargets:{workout:p.activeTargetWorkout,rest:p.activeTargetRest},
    outcome:v.band,manual:!!manual,weeklyCompliance:weeks,
    stats:{avgCompliance,avgWeeklyLossKg:Math.round((p.startKg-finalAvg)/(phaseDays/7)*100)/100,
      avgKcal:kcalDays?Math.round(kcalSum/kcalDays):null,
      avgActive:Math.round(actSum/phaseDays),pauseDays,recoveryDays:recovery},
  };
  save();queueSettings();renderNutrition();
  showToast(manual?"✓ Checkpoint accepted at "+finalAvg+" kg":"🏁 Phase complete");
}
let _phaseRevBusy=false;
async function aiPhaseReview(id){
  const p=PHASES.find(x=>x.id===id);
  if(!p||_phaseRevBusy)return;
  _phaseRevBusy=true;renderNutrition();
  try{
    const t=isoToday();
    const end=effectiveEnd(p,t);
    const completion=Math.round(Math.min(100,Math.max(0,daysBetween(p.start,t)/Math.max(1,daysBetween(p.start,end))*100)));
    const comp=weekCompliance(p,mondayOfIso(t),t);
    const health=phaseHealth(p,t);
    const cor=phaseCorridor(p,t);
    const run=getPhaseRun(p.id);
    // Compact per-day JSON (daily totals only, never raw food strings) —
    // keeps the prompt token-safe.
    const days=[];
    for(let i=13;i>=0;i--){
      const d=addDaysIso(t,-i);
      const nd=S.nutrition?.days?.[d]||{};const items=nd.items||[];
      const w=(S.nutrition.weights||{})[d];
      if(!items.length&&!nd.active&&w==null)continue;
      days.push({date:d,kcal:items.reduce((s,it)=>s+(it.kcal||0),0),protein:items.reduce((s,it)=>s+(it.protein||0),0),active:nd.active||0,weight:w!=null?Number(w):null});
    }
    const prompt=`Phase check-in review.\nPhase: ${p.id} v${p.version} (${p.strategy}), ${p.start} → ${end}, ${p.startKg} → ${p.targetKg} kg, eat ${p.eatKcal} kcal/day fixed, Watch active targets ${p.activeTargetWorkout} (Mon-Sat) / ${p.activeTargetRest} (Sun), counted burn = resting ${p.restingKcal} + 0.75×active.\nPhase completion: ${completion}%\nPhase health: ${health?`${health.colour} — ${health.label}`:"unknown (no weigh-ins)"}\n7-day avg weight: ${sevenDayAvg(t)??"n/a"} kg · target range today: ${cor.lo}–${cor.hi} kg\nCurrent-week compliance: ${JSON.stringify(comp)}\nCompliance history (prior weeks): ${JSON.stringify((run.weeks||[]).map(w=>({week:w.week,overall:w.overall})))}\nLast 14 days daily totals: ${JSON.stringify(days)}\n\nAs my coach, review this phase check-in in 5-7 sentences: what is working, the single biggest risk given the health colour and compliance history (distinguish plateau-despite-compliance from poor adherence), and exactly ONE concrete adjustment for the coming week. Plain text only.`;
    const r=await fetchT(API_CFG.baseUrl+"/api/coach",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},body:JSON.stringify({prompt})},60000);
    const d=await r.json();
    if(!r.ok||!d.text)throw new Error(d.error||"failed");
    S.phaseReview={phase:p.id,text:d.text,at:Date.now()};
    save();queueSettings();
  }catch(e){
    showToast("AI unavailable · try again");
  }finally{
    _phaseRevBusy=false;renderNutrition();
  }
}
// The 🎯 phase card (Nutrition tab). Returns "" when no phase is relevant.
function phaseCardHtml(){
  const t=isoToday();
  const p=PHASES.find(x=>{
    const st=phaseState(x,t);
    return st==="active"||st==="paused"||(st==="completed"&&!getPhaseRun(x.id).locked);
  });
  if(!p)return"";
  const st=phaseState(p,t);
  const run=getPhaseRun(p.id);
  const end=effectiveEnd(p,t);
  const totalDays=Math.max(1,daysBetween(p.start,end));
  const dayIn=Math.min(Math.max(daysBetween(p.start,t)+1,1),totalDays);
  const pctDone=Math.round(Math.min(100,Math.max(0,daysBetween(p.start,t)/totalDays*100)));
  const avg=sevenDayAvg(t);
  const cor=phaseCorridor(p,t);
  const health=phaseHealth(p,t);
  const banked=bankedDays(p,t);
  const comp=weekCompliance(p,mondayOfIso(t),t);
  const proj=projectedFinish(t);
  const fmtD=iso=>new Date(iso+"T12:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short"});
  const healthCol=c=>c==="green"?"var(--green)":c==="yellow"?"var(--amber)":c==="orange"?"#e8853d":"var(--red)";
  const num=n=>n.toLocaleString();
  const nMuted=`font-size:12px;color:var(--dim)`;
  const row=(l,v)=>`<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px"><span style="color:var(--mid)">${l}</span><span style="font-weight:600">${v}</span></div>`;
  const openPause=run.pauses.find(pa=>!pa.resumed);

  // Lost / remaining stats
  const cur=avg??latestWeightLog();
  const lost=cur!=null?Math.round((p.startKg-cur)*10)/10:null;
  const lostPct=lost!=null?Math.round(lost/p.startKg*1000)/10:null;

  // Milestones (5-kg thresholds, shared list with checkMilestones)
  const reached=(S.milestones?.shownWeight5kg||[]).slice().sort((a,b)=>a-b)[0];
  const nextMs=cur!=null?[135,130,125,120,115,110,105,100,95,90].find(m=>m<cur):null;

  // Verdict (due once past effective end, or via Accept)
  let verdictHtml="";
  if(st==="completed"&&!run.locked){
    const finalAvg=avg??latestWeightLog()??p.startKg;
    const v=phaseVerdict(p,finalAvg);
    verdictHtml=`<div style="border:1px solid var(--b1);border-radius:12px;padding:12px 14px;margin-top:10px;background:var(--s2)">
      <div style="font-weight:700;font-size:14px;margin-bottom:4px">${v.title} · final 7-day avg ${finalAvg} kg vs target ${p.targetKg} kg</div>
      <div style="font-size:12px;color:var(--lt);line-height:1.6">${v.action}</div>
      <button onclick="completePhase('${p.id}',false)" style="margin-top:10px;width:100%;background:var(--accent);color:var(--accent-ink);border:none;border-radius:8px;padding:10px;font-family:'Inter',sans-serif;font-weight:700;font-size:13px;cursor:pointer">Record verdict & lock phase</button>
    </div>`;
  }
  const inLastWeek=daysBetween(t,end)<=7&&st!=="completed";

  // Sunday coach summary (visible Sunday → Saturday for the week just ended)
  let sundayHtml="";
  {
    const thisMon=mondayOfIso(t);
    const lastMon=addDaysIso(thisMon,-7);
    const showWeekMon=isRestDay(t)?thisMon:lastMon; // on Sunday summarise the week ending today
    if(showWeekMon>=p.start){
      const wEnd=addDaysIso(showWeekMon,6);
      const wc=weekCompliance(p,showWeekMon,wEnd>t?t:wEnd);
      const wN=Math.floor(daysBetween(p.start,showWeekMon)/7)+1;
      const ws=S.nutrition.weights||{};
      let wDelta=null;
      const w0=ws[showWeekMon]??ws[addDaysIso(showWeekMon,-1)],w1=ws[wEnd]??ws[addDaysIso(wEnd,-1)]??ws[t];
      if(w0!=null&&w1!=null)wDelta=Math.round((Number(w1)-Number(w0))*10)/10;
      if(!wc.calculating){
        sundayHtml=`<div style="border:1px solid var(--b1);border-radius:12px;padding:12px 14px;margin-top:10px;background:var(--s2)">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Week ${wN} summary</div>
          ${wDelta!=null?row("Weight",`${wDelta>0?"+":""}${wDelta} kg`):""}
          ${banked?row(banked.kg>=0?"Ahead of schedule":"Behind schedule",`${Math.abs(banked.kg)} kg`):""}
          ${row("Calories compliance",wc.calories+"%")}
          ${row("Active target",wc.active+"%")}
          ${row("Protein",wc.protein+"%")}
          <div style="font-size:12px;color:var(--accent-text);font-weight:600;margin-top:6px">→ ${coachRecommendation(p,t,wc)}</div>
        </div>`;
      }
    }
  }

  // Live status chip in the collapsed summary: %, range check, compliance
  const chipBits=[`${pctDone}%`];
  if(st==="paused")chipBits.push("⏸ paused");
  else if(st==="completed")chipBits.push("🏁 verdict ready");
  else if(avg!=null)chipBits.push(avg>=cor.lo&&avg<=cor.hi?"✓ In range":health?health.label:"");
  if(!comp.calculating)chipBits.push(`compliance ${comp.overall}%`);
  return`<details class="st-acc"${st==="completed"?" open":""}>
    <summary><div><div>🎯 ${p.id.replace("_"," ").replace(/^p/,"P")} · ${chipBits.filter(Boolean).join(" · ")}</div><div class="st-acc-sub">Day ${dayIn} of ${totalDays} · ${fmtD(p.start)} → ${fmtD(end)}${end!==p.plannedEnd?" (extended)":""} · ${p.startKg} → ${p.targetKg} kg · eat ${num(p.eatKcal)}/day</div></div></summary>
    <div class="st-acc-inner" style="padding-top:10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
        <span style="${nMuted}">Day ${dayIn} of ${totalDays}</span>
        <span style="font-weight:700;font-size:14px">${pctDone}%</span>
      </div>
      <div class="prog-bar-wrap" style="margin-bottom:12px"><div class="prog-bar-fill" style="width:${pctDone}%"></div></div>
      ${lost!=null?row("Lost this phase",`${lost>0?lost:0} kg (${lostPct>0?lostPct:0}%)`):""}
      ${cur!=null?row(`Remaining to ${p.targetKg}`,`${Math.max(0,Math.round((cur-p.targetKg)*10)/10)} kg`):""}
      ${cur!=null?row("Remaining to 90 (overall)",`${Math.max(0,Math.round((cur-USER.targetKg)*10)/10)} kg`):""}
      ${avg!=null?`<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px"><span style="color:var(--mid)">Target range today</span><span style="font-weight:600">${cor.lo}–${cor.hi} kg · You: ${avg} <span style="color:${health?healthCol(health.colour):"var(--dim)"}">${avg>=cor.lo&&avg<=cor.hi?"✓ In range":health?health.label:""}</span></span></div>`:`<div style="${nMuted};padding:4px 0">Log weigh-ins to see your target range check</div>`}
      ${banked?row(banked.days>=0?"Banked progress":"Schedule debt",`${banked.days>=0?"Ahead":"Behind"} ${Math.abs(banked.kg)} kg ≈ ${Math.abs(banked.days)} days ${banked.days>=0?"ahead":"behind"}`):""}
      ${proj.status==="ok"?row("Projected 90 kg",`≈ ${fmtD(proj.date)} ${proj.date.slice(0,4)} · Confidence: ${proj.confidence}`):row("Projected 90 kg","Trend stabilizing…")}
      ${nextMs!=null?row("Next milestone",`${nextMs} kg · ${Math.round((cur-nextMs)*10)/10} kg remaining${reached!=null?` · ✔ ${reached} reached`:""}`):""}
      <div style="border-top:1px solid var(--b1);margin-top:8px;padding-top:8px">
        <div style="font-size:10px;font-weight:700;letter-spacing:1px;color:var(--dim);text-transform:uppercase;margin-bottom:4px">This week's compliance</div>
        ${comp.calculating?`<div style="${nMuted}">Calculating… log a full day of food to start scoring</div>`:`
          ${row("Calories (35%)",comp.calories+"%")}
          ${row("Active (25%)",comp.active+"%")}
          ${row("Protein (20%)",comp.protein+"%")}
          ${row("Workouts (15%)",comp.workouts+"%")}
          ${row("Weigh-ins (5%)",comp.weighins+"%")}
          <div style="display:flex;justify-content:space-between;padding:6px 0 0;font-size:14px;font-weight:700"><span>Overall</span><span style="color:${comp.overall>=90?"var(--green)":comp.overall>=75?"var(--amber)":"var(--red)"}">${comp.overall}%</span></div>`}
      </div>
      ${health&&(health.colour==="yellow"||health.colour==="orange"||health.colour==="red")&&pctDone>=50&&st!=="completed"?`<div style="font-size:12px;color:var(--amber);margin-top:8px">⚠ Mid-phase drift — add ~100 kcal/day active or revisit the plan.</div>`:""}
      ${sundayHtml}
      ${verdictHtml}
      ${S.phaseReview?.phase===p.id&&S.phaseReview.text?`<div style="border:1px solid var(--b1);border-radius:12px;padding:12px 14px;margin-top:10px;background:var(--s2)"><div style="font-size:10px;font-weight:700;letter-spacing:1px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">🤖 Coach review · ${new Date(S.phaseReview.at).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</div><div style="font-size:12px;color:var(--lt);line-height:1.6">${mdLite(S.phaseReview.text)}</div></div>`:""}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button onclick="aiPhaseReview('${p.id}')" ${_phaseRevBusy?"disabled":""} style="flex:1;background:transparent;border:1px dashed var(--b2);border-radius:8px;padding:9px;font-family:'Inter',sans-serif;font-size:12px;font-weight:600;color:var(--dim);cursor:pointer">${_phaseRevBusy?"Reviewing…":"🤖 Review now"}</button>
        ${openPause?`<button onclick="resumePhase('${p.id}')" style="flex:1;background:var(--accent);color:var(--accent-ink);border:none;border-radius:8px;padding:9px;font-family:'Inter',sans-serif;font-size:12px;font-weight:700;cursor:pointer">▶ Resume</button>`
          :st!=="completed"?`<button onclick="_phasePauseOpen=!_phasePauseOpen;renderNutrition()" style="flex:1;background:transparent;border:1px dashed var(--b2);border-radius:8px;padding:9px;font-family:'Inter',sans-serif;font-size:12px;font-weight:600;color:var(--dim);cursor:pointer">⏸ Pause phase</button>`:""}
        ${inLastWeek?`<button onclick="completePhase('${p.id}',true)" style="flex:1;background:transparent;border:1px dashed var(--b2);border-radius:8px;padding:9px;font-family:'Inter',sans-serif;font-size:12px;font-weight:600;color:var(--dim);cursor:pointer">✓ Accept current result</button>`:""}
      </div>
      ${openPause?`<div style="${nMuted};margin-top:8px">Paused · ${esc(openPause.reason)} · ${Math.max(0,daysBetween(openPause.start,t))} day${daysBetween(openPause.start,t)===1?"":"s"}${openPause.extend?" · extends phase":" · deadline unchanged"}</div>`:""}
      ${_phasePauseOpen&&!openPause?`<div style="border:1px solid var(--b1);border-radius:12px;padding:12px;margin-top:10px;background:var(--s2)">
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">Pause reason</div>
        <div style="display:flex;gap:6px;margin-bottom:10px">${["Medical","Vacation","Other"].map(r=>`<button onclick="_phasePauseReason='${r}';renderNutrition()" style="flex:1;background:${_phasePauseReason===r?"var(--accent)":"var(--s1)"};color:${_phasePauseReason===r?"var(--accent-ink)":"var(--lt)"};border:1px solid var(--b2);border-radius:8px;padding:8px;font-family:'Inter',sans-serif;font-size:12px;font-weight:600;cursor:pointer">${r}</button>`).join("")}</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--lt);margin-bottom:10px"><input type="checkbox" id="pauseExtend" ${_phasePauseExtend?"checked":""} onchange="_phasePauseExtend=this.checked"> Extend the phase by the paused days</label>
        <button onclick="pausePhase('${p.id}',_phasePauseReason,document.getElementById('pauseExtend').checked)" style="width:100%;background:var(--accent);color:var(--accent-ink);border:none;border-radius:8px;padding:10px;font-family:'Inter',sans-serif;font-weight:700;font-size:13px;cursor:pointer">Confirm pause</button>
      </div>`:""}
    </div>
  </details>`;
}
let _phasePauseReason="Medical",_phasePauseExtend=true;
function redoFood(){_pendingFood=null;_foodChatOpen=true;_foodDraftText=_lastFoodText||"";_foodDraftMealName=_lastMealName||"";renderNutrition();setTimeout(()=>{const ta=document.getElementById("foodTa");if(ta)ta.focus();},50);}
async function askFood(){
  const ta=document.getElementById("foodTa");if(!ta)return;
  const txt=ta.value.trim();if(!txt){showToast("Describe what you ate first");return;}
  _lastFoodText=txt;_lastMealName=(document.getElementById("foodMealName")?.value||"").trim();
  const out=document.getElementById("foodOut");
  if(out){out.className="ai-out show";out.innerHTML='<span class="spin"></span>Estimating...';}
  try{
    const r=await fetchT(API_CFG.baseUrl+"/api/nutrition",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},body:JSON.stringify({text:txt})},60000);
    const d=await r.json();
    if(!r.ok||d.error)throw new Error(d.error||"error");
    const arr=Array.isArray(d.items)?d.items:(d.name?[d]:[]);
    if(!arr.length)throw new Error("empty");
    const mealName=(document.getElementById("foodMealName")?.value||"").trim().slice(0,60);
    const canonical=mealName?mealName.toLowerCase():null;
    // If a name is given with multiple items, merge into one combined entry
    if(mealName&&arr.length>1){
      const merged={id:"n_"+Date.now(),name:mealName,canonical,
        kcal:arr.reduce((s,i)=>s+i.kcal,0),protein:arr.reduce((s,i)=>s+(i.protein||0),0),
        carbs:arr.reduce((s,i)=>s+(i.carbs||0),0),fat:arr.reduce((s,i)=>s+(i.fat||0),0),
        fibre:arr.reduce((s,i)=>s+(i.fibre||0),0),sugar:arr.reduce((s,i)=>s+(i.sugar||0),0),
        sodium:arr.reduce((s,i)=>s+(i.sodium||0),0),time:Date.now()};
      _pendingFood=[merged];
    }else{
      _pendingFood=arr.map((it,i)=>({id:"n_"+Date.now()+"_"+i,name:mealName&&arr.length===1?mealName:it.name,canonical:canonical||it.name.toLowerCase(),kcal:it.kcal,protein:it.protein,carbs:it.carbs,fat:it.fat,fibre:it.fibre||0,sugar:it.sugar||0,sodium:it.sodium||0,time:Date.now()}));
    }
    if(out)out.className="ai-out";
    _foodChatOpen=false;_foodDraftText="";_foodDraftMealName="";renderNutrition();
  }catch(e){
    if(out){out.className="ai-out show";out.textContent="Could not estimate · try again or be more specific.";}
  }
}
function dropPending(id){
  if(!Array.isArray(_pendingFood))return;
  _pendingFood=_pendingFood.filter(p=>p.id!==id);
  if(!_pendingFood.length)_pendingFood=null;
  renderNutrition();
}
function confirmFood(date){
  if(nutLocked(date))return;
  if(!_pendingFood)return;
  const arr=Array.isArray(_pendingFood)?_pendingFood:[_pendingFood];
  const day=getDayData(date);
  arr.forEach(p=>{day.items.push({...p});queueMutation("nutrition_item_add",{date,item:p});});
  _pendingFood=null;save();checkMilestones();showToast(arr.length>1?arr.length+" items added ✓":"Food added ✓");renderNutrition();
}
// Full searchable food history for the "Search past logs" panel.
// Returns all unique foods ever logged (by canonical key), sorted by
// frequency desc then most-recently-logged desc. Excludes today.
function buildFoodHistory(excludeDate){
  const norm=n=>n.toLowerCase().replace(/\b(with|and|the|a|an|of|in|on|&)\b/g,' ').replace(/\s+/g,' ').trim().split(' ').slice(0,3).join(' ');
  const itemKey=it=>it.canonical||norm(it.name||"");
  const map={};
  for(const[d,day]of Object.entries(S.nutrition.days||{})){
    if(d===excludeDate)continue;
    for(const it of(day.items||[])){
      const k=itemKey(it);
      if(!k)continue;
      if(!map[k]){map[k]={name:it.name,kcal:it.kcal||0,protein:it.protein||0,carbs:it.carbs||0,fat:it.fat||0,fibre:it.fibre||0,sugar:it.sugar||0,sodium:it.sodium||0,n:0,last:d};}
      map[k].n++;
      if(d>map[k].last){map[k].last=d;map[k].name=it.name;map[k].kcal=it.kcal||0;map[k].protein=it.protein||0;map[k].carbs=it.carbs||0;map[k].fat=it.fat||0;map[k].fibre=it.fibre||0;map[k].sugar=it.sugar||0;map[k].sodium=it.sodium||0;}
    }
  }
  // Sort by protein efficiency (protein kcal / total kcal), frequency as tiebreaker
  const protRatio=e=>e.kcal>0?(e.protein*4)/e.kcal:0;
  return Object.values(map).sort((a,b)=>protRatio(b)-protRatio(a)||b.n-a.n||b.last.localeCompare(a.last));
}
function filterFoodSearch(q,date){
  _foodSearchQ=q;
  const container=document.getElementById("foodSearchResults");
  if(!container)return;
  const allFoods=buildFoodHistory(date);
  const lq=q.toLowerCase().trim();
  const filtered=lq?allFoods.filter(f=>f.name.toLowerCase().includes(lq)):allFoods;
  container.innerHTML=filtered.slice(0,40).map(f=>{
    const args=`'${date}','${(f.name||"").replace(/\\/g,"\\\\").replace(/'/g,"\\'")}',${f.kcal},${f.protein||0},${f.carbs||0},${f.fat||0},${f.fibre||0},${f.sugar||0},${f.sodium||0}`;
    return`<div onclick="quickAddRecent(${args});_foodSearchOpen=false;_foodSearchQ='';renderNutrition()" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--b1);cursor:pointer">
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--white)">${esc(f.name)}</div>
        <div style="font-size:11px;color:var(--dim);margin-top:2px">${f.kcal} kcal · P ${f.protein||0}g · C ${f.carbs||0}g · F ${f.fat||0}g${f.kcal>0?` · <span style="color:var(--amber)">${Math.round((f.protein||0)*400/f.kcal)}% protein</span>`:""}${f.n>1?` · ${f.n}×`:""}</div>
      </div>
      <span style="font-size:20px;color:var(--amber);padding-left:12px">+</span>
    </div>`;
  }).join("")||`<div style="color:var(--dim);font-size:13px;padding:16px 0;text-align:center">No matches found</div>`;
}
function quickAddRecent(date,name,kcal,protein,carbs,fat,fibre,sugar,sodium){
  if(nutLocked(date))return;
  const item={id:"n_"+Date.now(),name,kcal,protein,carbs,fat,fibre:fibre||0,sugar:sugar||0,sodium:sodium||0,time:Date.now()};
  getDayData(date).items.push(item);
  save();queueMutation("nutrition_item_add",{date,item});checkMilestones();showToast("Added "+name+" ✓");renderNutrition();
}
// Most-used meals across the last 60 days, ranked by frequency + recency.
// Groups near-identical AI-parsed names by a normalised key (first 3 words,
// stripped of filler) so "Chicken rice" and "Chicken rice bowl" accumulate
// into the same bucket. Recency boost means items eaten in the last 7 days
// always surface near the top even when counts are equal.
function recentFoods(excludeDate,limit=6){
  const norm=n=>n.toLowerCase().replace(/\b(with|and|the|a|an|of|in|on|&)\b/g,' ').replace(/\s+/g,' ').trim().split(' ').slice(0,3).join(' ');
  const itemKey=it=>it.canonical||norm(it.name||"");
  const counts={};
  const todayNames=new Set(((S.nutrition.days?.[excludeDate]||{}).items||[]).map(it=>itemKey(it)));
  const cutoff=(()=>{const d=new Date(excludeDate+"T12:00:00");d.setDate(d.getDate()-60);return isoDate(d);})();
  for(const[d,day]of Object.entries(S.nutrition.days||{})){
    if(d<cutoff||d===excludeDate)continue;
    for(const it of(day.items||[])){
      const k=itemKey(it);
      if(!k||todayNames.has(k))continue;
      if(!counts[k])counts[k]={n:0,item:it,last:d};
      counts[k].n++;
      if(d>counts[k].last){counts[k].last=d;counts[k].item=it;}
    }
  }
  const today=excludeDate;
  const daysSince=x=>Math.round((new Date(today+"T12:00:00")-new Date(x+"T12:00:00"))/86400000);
  const ranked=Object.values(counts)
    // Hide condiments/toppings: items under 60 kcal are rarely worth quick-logging
    .filter(e=>(e.item.kcal||0)>=60)
    // Require 2+ logs OR logged within 5 days (so a food appears the 2nd time without manual re-entry)
    .filter(e=>e.n>=2||daysSince(e.last)<=5)
    .sort((a,b)=>{
      const boost=x=>daysSince(x)<=3?4:daysSince(x)<=7?2:daysSince(x)<=14?1:0;
      const sa=a.n+boost(a.last), sb=b.n+boost(b.last);
      return sb-sa||b.last.localeCompare(a.last);
    });
  // Pin the daily protein oats/coffee if it exists and isn't logged today
  let pin=null;
  const oats=ranked.find(e=>/protein.*(oats|coffee|collagen)|oats.*coffee|collagen/i.test(e.item.name||""));
  if(oats)pin=oats;
  else{
    const yd=(()=>{const d=new Date(excludeDate+"T12:00:00");d.setDate(d.getDate()-1);return isoDate(d);})();
    const yItems=(S.nutrition.days?.[yd]||{}).items||[];
    const yMatch=yItems.find(it=>!todayNames.has(itemKey(it)));
    if(yMatch)pin=ranked.find(e=>e.item.name===yMatch.name)||{item:yMatch};
  }
  const rest=ranked.filter(e=>e!==pin);
  return(pin?[pin,...rest]:rest).slice(0,limit).map(e=>e.item);
}
function delFood(date,id){
  if(nutLocked(date))return;
  const day=getDayData(date);day.items=day.items.filter(i=>i.id!==id);save();queueMutation("nutrition_item_delete",{date,id});renderNutrition();
}
let _wtPage=0,_wtExpanded=false;
function wtPage(n){_wtPage=n;_wtExpanded=true;renderNutrition();}
function saveWeight(date){
  if(nutLocked(date))return;
  const inp=document.getElementById("wtInp");if(!inp)return;
  const val=parseFloat(inp.value);if(isNaN(val)||val<30||val>300){showToast("Enter a valid weight");return;}
  _wtPage=0;S.nutrition.weights[date]=val;_wtOpen=false;save();queueMutation("weight",{date,kg:val},"weight:"+date);checkMilestones();showToast("Weight logged ✓");renderNutrition();
}
function delWeight(date){
  _wtPage=0;delete S.nutrition.weights[date];save();queueMutation("weight_delete",{date});showToast("Entry removed");renderNutrition();
}
export function buildSparkline(keys,wts,summary){
  if(keys.length<2)return"";
  const vals=keys.map(k=>wts[k]);
  const mn=Math.min(...vals),mx=Math.max(...vals),range=mx-mn||1;
  const W=320,H=60,pad=6;
  const pts=vals.map((v,i)=>{const x=pad+(i/(vals.length-1))*(W-pad*2);const y=H-pad-((v-mn)/range)*(H-pad*2);return`${x.toFixed(1)},${y.toFixed(1)}`;});
  let tLine="";
  if(USER.targetKg>=mn&&USER.targetKg<=mx){const ty=(H-pad-((USER.targetKg-mn)/range)*(H-pad*2)).toFixed(1);tLine=`<line x1="${pad}" y1="${ty}" x2="${W-pad}" y2="${ty}" stroke="var(--green)" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>`;}
  let footer;
  if(summary){
    // Average monthly loss from the window's real time span
    const days=(new Date(keys[keys.length-1]+"T12:00:00")-new Date(keys[0]+"T12:00:00"))/86400000;
    if(days>=30){
      const delta=vals[vals.length-1]-vals[0];
      const perMonth=delta/days*30;
      const col=perMonth<0?"var(--green)":"var(--red)";
      footer=`<div class="wt-recent">Avg: <span style="color:${col};font-weight:700">${perMonth<=0?"":"+"}${perMonth.toFixed(1)} kg/month</span> · ${vals[0]}kg → ${vals[vals.length-1]}kg over ${Math.round(days)} days</div>`;
    }else{
      footer=`<div class="wt-recent">${vals[0]}kg → ${vals[vals.length-1]}kg · monthly avg unlocks in ${30-Math.round(days)} days</div>`;
    }
  }else{
    footer=`<div class="wt-recent">${keys.slice(-3).map(k=>`${k}: <span>${wts[k]}kg</span>`).join(" · ")}</div>`;
  }
  return`<div class="sparkline-wrap"><svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${tLine}<polyline points="${pts.join(" ")}" fill="none" stroke="var(--orange)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${vals.map((v,i)=>{const[x,y]=pts[i].split(",");return`<circle cx="${x}" cy="${y}" r="3" fill="var(--orange)"/>`;}).join("")}</svg></div>${footer}`;
}
function arrivalEst(){
  // Linear regression of weight against REAL days elapsed (not entry index),
  // so irregular weigh-in gaps don't distort the slope. Projects from the
  // smoothed trend-line value at the latest date, not the raw last reading,
  // so a single water-weight dip doesn't swing the estimate.
  const wts=S.nutrition.weights||{};const keys=Object.keys(wts).sort();
  if(keys.length<2)return`Estimated arrival: <b>need more data</b>`;
  const recent=keys.slice(-28);const n=recent.length;
  const t0=new Date(recent[0]+"T12:00:00").getTime();
  const xs=recent.map(k=>(new Date(k+"T12:00:00").getTime()-t0)/86400000);
  const ys=recent.map(k=>wts[k]);
  const span=xs[n-1]-xs[0];
  if(span<5)return`Estimated arrival: <b>need ~1 week of weigh-ins</b>`;
  const mx=xs.reduce((a,b)=>a+b,0)/n,my=ys.reduce((a,b)=>a+b,0)/n;
  const slope=xs.reduce((a,x,i)=>a+(x-mx)*(ys[i]-my),0)/xs.reduce((a,x)=>a+(x-mx)**2,0); // kg per day
  if(slope>=-0.01)return`Estimated arrival: <b>trend flat or rising · check deficit</b>`;
  const smoothed=my+slope*(xs[n-1]-mx); // trend-line weight at latest date
  const daysNeeded=Math.ceil((smoothed-USER.targetKg)/Math.abs(slope));
  if(daysNeeded>730)return`Estimated arrival: <b>over 2 years at this pace · check deficit</b>`;
  const arrival=new Date(recent[n-1]+"T12:00:00");arrival.setDate(arrival.getDate()+daysNeeded);
  const diff=Math.round((USER.goalDate-arrival)/86400000);
  const ahead=diff>0?` (${diff}d ahead)`:diff<0?` (${Math.abs(diff)}d behind)`:" (on track)";
  const rate=Math.abs(slope*7).toFixed(1);
  return`Estimated arrival: <b>${arrival.toLocaleDateString("en-AU",{month:"short",day:"numeric",year:"numeric"})}</b>${ahead} · losing ~${rate} kg/week`;
}
function handleHKSync(){
  const p=new URLSearchParams(location.search);if(!p.get("hksync"))return;
  const active=parseInt(p.get("active")||"0"),date=p.get("date")||isoToday();
  if(!isNaN(active)&&active>=0){getDayData(date).active=active;save();queueDayMeta(date);showToast(`⚡ Active calories synced (${active} kcal)`);}
  const url=new URL(location.href);url.searchParams.delete("hksync");url.searchParams.delete("active");url.searchParams.delete("date");
  history.replaceState({},"",url);
}
function getISOWeek(){const d=new Date();const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));t.setUTCDate(t.getUTCDate()+4-(t.getUTCDay()||7));const y=t.getUTCFullYear();const wn=Math.ceil(((t-new Date(Date.UTC(y,0,1)))/86400000+1)/7);return y+"W"+wn;}


window.nutShift=nutShift;
window.unlockNut=unlockNut;
window.lockNut=lockNut;
window.openDrawer=openDrawer;
window.closeDrawer=closeDrawer;
window.openFood=openFood;
window.askFood=askFood;
window.closeFood=closeFood;
window.confirmFood=confirmFood;
window.redoFood=redoFood;
window.dropPending=dropPending;
window.delFood=delFood;
window.quickAddRecent=quickAddRecent;
window.saveWeight=saveWeight;
window.delWeight=delWeight;
window.wtPage=wtPage;
function toggleWtOpen(){_wtOpen=!_wtOpen;renderNutrition();}
window.toggleWtOpen=toggleWtOpen;
window.nutDateLabel=nutDateLabel;
window.filterFoodSearch=filterFoodSearch;
ctx.renderNutrition=renderNutrition;
ctx.trainedOn=ctx.trainedOn;
