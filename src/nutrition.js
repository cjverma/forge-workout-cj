import { ctx } from "./runtime.js";
import { ACTIVE_MULT, USER, actualDeficit, activeCalibration, activeMult, dayDeficitCheck, eatKcalFor, calcBMR, calcTarget, isoDate, isoToday, latestWeightLog, phaseActiveTargets, phaseFor, phaseRequiredDeficit, proteinTargetG, restingFor, restingForPhase } from "./phase.js";
import { esc, fmtDate, mdLite, showToast, icon} from "./ui.js";
import { save } from "./state.js";
import { API_CFG, queueDayMeta, queueMutation, queueSettings } from "./sync.js";
import { FEATURES, FIBRE_TARGET, SUGAR_LIMIT, SODIUM_LIMIT, PROG, PR_ALIAS, kg1 } from "./constants.js";

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
// iOS large title: "Today", "Yesterday" or the weekday; the full date rides
// above it as the kicker, the same way the Workout tab heads a day.
function nutDateLabel(iso){
  const today=isoToday();
  if(iso===today)return"Today";
  if(iso===addDaysIso(today,-1))return"Yesterday";
  const d=new Date(iso+"T12:00:00Z");
  return daysBetween(iso,today)<7?d.toLocaleDateString("en-US",{weekday:"long",timeZone:"UTC"}):d.toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"});
}
function nutDateKicker(iso){return new Date(iso+"T12:00:00Z").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",timeZone:"UTC"});}
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
  if(keys.length<2)return`<div class="trend-card"><div class="trend-title">Weight over 30 days</div><div style="font-size:11px;color:var(--dim)">Need at least 2 weigh-ins.</div></div>`;
  return`<div class="trend-card"><div class="trend-title">Weight over 30 days</div>${buildSparkline(keys,wts,true)}</div>`;
}
// Targets hit this week, kept off the goal card (user, Oct 28: "count days
// logged, not days goal met; treat that separately, in the drawer").
function weekTargetsHtml(){
  const t=isoToday(),p=phaseFor(t);
  if(!p)return"";
  const c=weekCompliance(p,mondayOfIso(t),t);
  const row=(l,v)=>`<div class="st-row" style="cursor:default"><div class="st-info"><div class="st-ttl">${l}</div></div><div style="font-variant-numeric:tabular-nums;color:var(--mid)">${v}</div></div>`;
  const of=n=>c.finishedDays?`${n} of ${c.finishedDays} days`:"Starts tomorrow";
  return`<div class="st-sec">Targets Hit This Week</div><div class="st-group">
    ${row("Food at or under target",of(c.foodDays))}
    ${row("Watch active target met",of(c.activeDays))}
    ${row("Score so far",c.overall==null?"Starts after today":c.overall+"%")}
  </div>`;
}
function renderDrawer(){
  const t=buildTrendData();
  const pTarget=proteinTargetG();
  document.getElementById("drawerContent").innerHTML=`
    <div class="drawer-head"><div class="drawer-title">Insights</div><button class="drawer-close" onclick="closeDrawer()">✕</button></div>
    <div class="st-sec">7-Day Trends</div>
    ${tbarChart("Protein g/day",t,d=>d.protein,(d,v)=>v>=pTarget?"var(--green)":"var(--b2)",`target ${pTarget}g`)}
    ${tbarChart("Calorie burn",t,d=>d.burn,d=>d.trained?"var(--orange)":"var(--b2)",`<span style="color:var(--orange)">▮</span> trained, <span style="color:var(--b2)">▮</span> rest`)}
    ${tbarChart("Daily deficit",t,d=>d.deficit,(d,v)=>v==null?"var(--b2)":v>=0?"var(--green)":"var(--red)","green = deficit")}
    ${weight30Chart()}
    ${weekTargetsHtml()}
    <div class="st-sec">AI Coaching</div>
    <div class="ai-card" style="margin-bottom:10px"><div class="ai-card-title">${icon("refresh",20)} Machine Busy?</div><input class="ai-inp" id="si" placeholder='e.g. "chest press 20kg is busy"'><button class="ai-btn" onclick="aiRun('sub')">Find Alternative</button><div class="ai-out" id="so"></div></div>
    <div class="ai-card"><div class="ai-card-title">${icon("moon",20)} How Hard Should I Train?</div><div class="g2"><div><label class="ai-lbl">CPAP Score</label><input class="ai-sm" id="sl" type="number" placeholder="91"></div><div><label class="ai-lbl">Energy (1-10)</label><input class="ai-sm" id="en" type="number" placeholder="7"></div><div><label class="ai-lbl">Soreness (1-10)</label><input class="ai-sm" id="sr" type="number" placeholder="3"></div><div><label class="ai-lbl">Calf Pain</label><select class="ai-sm" id="cp"><option value="none">None</option><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option></select></div></div><button class="ai-btn" onclick="aiRun('recovery')">Analyse Recovery</button><div class="ai-out" id="ro"></div></div>
    ${FEATURES.prList?`    <details class="st-acc">
      <summary><div><div>${icon("trophy",20)} Personal Records</div><div class="st-acc-sub">Best set, progress over time</div></div></summary>
      <div class="st-acc-inner">
    ${(()=>{
      // EX_NAMES keyed by canonical name-slug (same as _prCanonMap values)
      const EX_NAMES={};
      for(const[,dd] of Object.entries(PROG))for(const ex of(dd.exercises||[])){const cid=canonicalId(ex.id);if(!EX_NAMES[cid])EX_NAMES[cid]=ex.name;}
      // Custom exercises live in S.custom (not PROG) — seed their names too so
      // PR entries stored under "c_<ts>" ids resolve to real names
      for(const arr of Object.values(S.custom||{}))for(const ex of(arr||[])){const cid=canonicalId(ex.id);if(!EX_NAMES[cid])EX_NAMES[cid]=ex.name;}
      // Alias-aware: a non-canonical slug must resolve to the canonical name,
      // or it renders a phantom row under the retired name.
      const exName=id=>{const c=PR_ALIAS[id]||id;return EX_NAMES[c]||ctx.prName(c);};
      // Leaderboard card (top 5 by est 1RM across all PRs)
      const allPRs=Object.entries(S.prs||{});
      let leaderHtml="";
      if(allPRs.length){
        const rows=allPRs
          .map(([id,entries])=>{if(!entries||!entries.length)return null;const best=entries.reduce((b,e)=>e.est>b.est?e:b,entries[0]);return{id,best};})
          .filter(Boolean)
          .sort((a,b)=>b.best.est-a.best.est)
          .slice(0,5)
          .map(({id,best},idx)=>`<div class="lift-row"><span class="lift-rank">${idx+1}</span><span class="lift-name">${esc(exName(id))}</span><span class="lift-val">${best.weight}<span class="lift-unit">kg × ${best.reps}</span></span></div>`)
          .join("");
        leaderHtml=`<div class="lift-board"><div class="lift-cap">Strongest Lifts</div>${rows}</div>`;
      }
      // Per-exercise rows: all exercises with PRs first, then key exercises without
      // Canonical slugs only. The retired hip-abduction slug lived here after
      // the rename and rendered a phantom Hip Abduction Machine row that could
      // never hold a PR, because every write goes to the canonical key.
      const KEY_IDS=["chest_press_machine","incline_chest_press_machine","pec_fly_machine","seated_cable_row","chest_supported_row","seated_pulldown_neutral_grip","tricep_extension_machine","leg_press_machine","seated_leg_curl","outer_thigh_machine","inner_thigh_machine","seated_calf_raise","hammer_curl"].map(id=>PR_ALIAS[id]||id);
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
        return `<div class="rule-item">
          <div class="pr-head">
            <div class="pr-open" onclick="closeDrawer();setTimeout(()=>{const el=document.getElementById('ex-${id}');if(el)el.scrollIntoView({behavior:'smooth',block:'center'});},200)">
              <div class="rule-ttl">${name}</div>
              <div class="rule-desc">${pr?`${pr.weight}kg × ${pr.reps}, ${fmtDate(pr.date)}, est. 1RM ${pr.est}kg`:"No PR recorded yet"}</div>
            </div>
            ${pr?`<button class="pr-del" onclick="event.stopPropagation();dropPR('${id}')" title="Remove this PR" aria-label="Remove PR for ${esc(name)}">${icon("trash",15)}</button>`:""}
          </div>
          ${sparkHtml}
        </div>`;
      }).join("");
      return leaderHtml+exRows;
    })()}
      </div>
    </details>`:""}
    <details class="st-acc">
      <summary><div><div>${icon("shield",20)} Spine Rules</div><div class="st-acc-sub">Movement restrictions</div></div></summary>
      <div class="st-acc-inner">
        <div class="rule-item"><div class="rule-ttl">No overhead movements</div><div class="rule-desc">Standard lat pulldown, overhead press, any reach under load.</div></div>
        <div class="rule-item"><div class="rule-ttl">No axial compression</div><div class="rule-desc">Barbell squat, deadlift, good mornings. Permanently off the table.</div></div>
        <div class="rule-item"><div class="rule-ttl">Bike first, always</div><div class="rule-desc">Hip flexion decompresses the spine before any loading. Never skip.</div></div>
        <div class="rule-item"><div class="rule-ttl">Nerve symptom: sit down immediately</div><div class="rule-desc">3+ episodes in one session means end or modify the session.</div></div>
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
  const finalTarget=shock?1200:target;
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
  // Protein target: shared proteinTargetG() (1.8g × current weight), +10% on
  // days with training or logged active burn.
  const trained=trainedOn(date)||active>0;
  const pTarget=Math.round(proteinTargetG()*(trained?1.1:1));
  const ratio=finalTarget?consumed/finalTarget:0;
  const pillCls=ratio<0.9?"tpill-green":ratio<=1.1?"tpill-amber":"tpill-red";
  const pillTxt=ratio<0.9?"Under target":ratio<=1.1?"On track":"Over target";
  const foodListHtml=items.length?items.map(it=>{const t=it.time?new Date(it.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"";return`<div class="food-item"><div style="flex:1"><div class="food-name">${esc(it.name)}${t?`<span style="font-size:10px;color:var(--dim);font-weight:400;margin-left:6px">${t}</span>`:""}</div><div class="food-macros">P ${it.protein||0}g, C ${it.carbs||0}g, F ${it.fat||0}g</div></div><div style="display:flex;align-items:center;gap:4px"><div class="food-kcal">${it.kcal} kcal</div>${ro?"":`<button class="food-del" onclick="delFood('${date}','${it.id}')">Delete</button>`}</div></div>`;}).join(""):"";
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
  // "Fits what's left": today only, once there is real room and protein to go.
  const pLeft=Math.max(0,pTarget-Math.round(protein));
  _fitSugg=(!ro&&date===isoToday()&&remaining>=100&&pLeft>=10)?foodSuggestions(date,remaining,pLeft):[];
  const fitHtml=_fitSugg.length?`<div class="fit-sugg"><div class="fit-sugg-cap">Fits what's left: ${remaining.toLocaleString()} kcal, ${pLeft} g protein</div>${_fitSugg.map((f,i)=>`<button class="fit-sugg-row" onclick="addFoodSuggestion('${date}',${i})"><span class="fit-sugg-name">${esc(f.name)}</span><span class="fit-sugg-meta">${f.kcal} kcal, ${f.protein} g protein</span><span class="fit-sugg-add">${icon("plus",18)}</span></button>`).join("")}</div>`:"";
  document.getElementById("tc").innerHTML=`<div class="nut-wrap">
    <div class="nut-head">
      <div><div class="nut-kicker">${nutDateKicker(date)}</div><div class="nut-title">${nutDateLabel(date)}</div></div>
      <div class="nut-nav-btns">
        ${date<isoToday()?`<button onclick="${ro?`unlockNut('${date}')`:`lockNut('${date}')`}" title="${ro?"Unlock editing":"Lock editing"}">${ro?`${icon("pencil",18)}`:`${icon("unlock",18)}`}</button>`:""}
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
      <div style="font-size:11px;color:var(--hero-fg-dim);margin-bottom:4px">${consumed.toLocaleString()} eaten, ${finalTarget.toLocaleString()} target${shock?", shock day":""}</div>
      <div class="net-line ${netDef<=0?"net-green":"net-red"}" style="text-align:left;margin-bottom:0">${netDef<=0?"✓ Deficit":"⚠ Surplus"} ${Math.abs(netDef).toLocaleString()} kcal vs burn</div>
      ${phase?(()=>{
        // Active compliance: how much active is ACTUALLY still needed today,
        // not the planned target assuming you eat the full budget. The
        // planned target (phaseActiveTarget) is solved against phase.eatKcal
        // as a fixed assumption; if you eat less than that, less active is
        // needed to hit the same deficit, and if you eat more, more is
        // needed. plannedTgt + (consumed-eatKcal)/ACTIVE_MULT is the same
        // formula phaseActiveTargets solves internally, just re-solved
        // against what you actually ate instead of the budget assumption —
        // the workout/rest split stays intact since plannedTgt already
        // reflects which kind of day this is.
        const plannedTgt=phaseActiveTarget(phase,date);
        const aTgt=Math.max(0,Math.round(plannedTgt+(consumed-eatKcalFor(phase,date))/activeMult(date)));
        const aPct=aTgt?Math.round(active/aTgt*100):100;
        const lbl=aPct>=95?"Excellent":aPct>=80?"Good":"Needs improvement";
        const met=aPct>=95;
        const remain=Math.max(0,aTgt-active);
        return`<div style="font-size:11px;color:${met?"var(--hero-pos)":"var(--hero-fg-dim)"};margin-top:4px;text-align:left">${icon("bolt",18)} Active ${active.toLocaleString()} / ${aTgt.toLocaleString()}, ${aPct}%${remain>0?`, ${remain.toLocaleString()} kcal remaining`:""}, ${lbl}</div>`;
      })():""}
      ${macroPie(protein,carbs,fat,fibre)}
      ${(()=>{
        // Six identical bordered tiles replaced by a borderless typographic
        // grid. Four of these numbers have a target or a limit, which the tile
        // layout threw away, so each of those now carries a 2px track: it fills
        // toward the target and turns amber past a limit. Carbs and fat have
        // neither, so they get no track rather than a decorative empty one.
        const bar=(v,lim,isLimit)=>{
          const pct=Math.min(100,Math.round((v/lim)*100));
          const over=isLimit?v>lim:false;
          const met=!isLimit&&v>=lim;
          const col=over?"var(--amber)":met?"var(--hero-pos)":"var(--hero-accent)";
          return`<div class="macro-tr"><span style="width:${pct}%;background:${col}"></span></div>`;
        };
        const cell=(k,valHtml,track)=>`<div class="macro"><div class="macro-k">${k}</div><div class="macro-v">${valHtml}</div>${track||""}</div>`;
        return`<div class="macros">
          ${cell("Protein",`${protein}<i>/${pTarget}g</i>`,bar(protein,pTarget,false))}
          ${cell("Carbs",`${carbs}<i>g</i>`,"")}
          ${cell("Fat",`${fat}<i>g</i>`,"")}
          ${cell("Fibre",`${fibre}<i>/${FIBRE_TARGET}g</i>`,bar(fibre,FIBRE_TARGET,false))}
          ${cell("Sugar",`${sugar}<i>g</i>`,bar(sugar,SUGAR_LIMIT,true))}
          ${cell("Sodium",`${sodium.toLocaleString()}<i>mg</i>`,bar(sodium,SODIUM_LIMIT,true))}
        </div>`;
      })()}
      ${ro?"":`<button class="shock-btn${shock?" active":""}" onclick="toggleShock('${date}')">${shock?`${icon("bolt",18)} Shock day active, tap to disable`:`${icon("bolt",18)} Shock day, 1,200 kcal`}</button>`}
    </div>

    <!-- Food log card -->
    <div class="nut-card">
      <div class="nut-card-title">Food Log${items.length?` <span style="font-size:11px;font-weight:400;color:var(--dim)">${items.length} item${items.length!==1?"s":""}, ${consumed.toLocaleString()} kcal</span>`:""}</div>
      ${foodListHtml?`<div class="food-list" style="margin-bottom:10px">${foodListHtml}</div>`:""}
      ${_pendingFood?(()=>{
        const arr=Array.isArray(_pendingFood)?_pendingFood:[_pendingFood];
        const tot=arr.reduce((s,p)=>s+p.kcal,0);
        const rows=arr.map(p=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--b1)"><div><div style="font-size:13px;font-weight:600">${esc(p.name)}</div><div style="font-size:11px;color:var(--dim)">${p.kcal} kcal, P ${p.protein}g, C ${p.carbs}g, F ${p.fat}g</div></div>${arr.length>1?`<button class="food-del" onclick="dropPending('${p.id}')">✕</button>`:""}</div>`).join("");
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
              <div style="font-size:11px;color:var(--dim);margin-top:2px">${f.kcal} kcal, P ${f.protein||0}g, C ${f.carbs||0}g, F ${f.fat||0}g${f.kcal>0?`, ${Math.round((f.protein||0)*400/f.kcal)}% protein`:""}${f.n>1?`, ${f.n}×`:""}</div>
            </div>
            <span style="font-size:20px;color:var(--accent-text);padding-left:12px">+</span>
          </div>`;
        }).join("");
        return`<div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <input id="foodSearchInp" type="search" placeholder="Search past foods…" value="${esc(_foodSearchQ)}"
              oninput="filterFoodSearch(this.value,'${date}')"
              style="flex:1;background:var(--s2);border:1px solid var(--b2);border-radius:10px;padding:10px 13px;font-size:14px;color:var(--white);font-family:var(--font-body);outline:none"
              autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            <button onclick="_foodSearchOpen=false;_foodSearchQ='';renderNutrition()" style="background:transparent;border:none;color:var(--dim);font-size:22px;cursor:pointer;padding:0 4px">✕</button>
          </div>
          <div id="foodSearchResults" style="max-height:340px;overflow-y:auto">${rows||`<div style="color:var(--dim);font-size:13px;padding:16px 0;text-align:center">No matches found</div>`}</div>
        </div>`;
      })():_foodChatOpen?(()=>{
        const recents=recentFoods(date);
        const chips=recents.length?`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${recents.map(f=>`<button onclick="quickAddRecent('${date}','${esc(f.name).replace(/'/g,"\\'")}',${f.kcal},${f.protein||0},${f.carbs||0},${f.fat||0},${f.fibre||0},${f.sugar||0},${f.sodium||0})" style="background:var(--s2);border:1px solid var(--b2);border-radius:99px;padding:6px 12px;font-family:var(--font-body);font-size:11px;color:var(--lt);cursor:pointer">+ ${esc(f.name)} <span style="color:var(--dim)">${f.kcal}</span></button>`).join("")}</div>`:"";
        return`<div><input class="food-ta" id="foodMealName" placeholder="Meal name (optional, e.g. Morning oats, Post-workout)" style="margin-bottom:7px;height:auto;min-height:0;padding:10px 13px;font-size:13px;resize:none" maxlength="60" value="${esc(_foodDraftMealName)}" oninput="_foodDraftMealName=this.value"><textarea class="food-ta" id="foodTa" placeholder="What did you eat? e.g. 2 eggs on toast, chicken wrap..." rows="3" oninput="_foodDraftText=this.value">${esc(_foodDraftText)}</textarea><div class="ai-out" id="foodOut"></div><div class="food-chat-btns"><button class="food-submit" onclick="askFood()">Estimate with AI</button><button class="food-cancel" onclick="closeFood()">Cancel</button></div>${chips}</div>`;
      })():`${!items.length?`<div style="font-size:12px;color:var(--dim);margin-bottom:10px;text-align:center">Nothing logged yet, ${(finalTarget-0).toLocaleString()} kcal remaining</div>`:""}${fitHtml}
<div style="display:flex;gap:8px;align-items:center"><button class="add-food-btn" style="flex:1" onclick="openFood()">Log a meal</button><button onclick="_foodSearchOpen=true;_foodSearchQ='';renderNutrition();setTimeout(()=>{const i=document.getElementById('foodSearchInp');if(i)i.focus();},50)" title="Search past logs" style="flex:0 0 auto;padding:11px 14px;background:transparent;border:1px solid var(--b1);border-radius:var(--r-md);font-size:14px;cursor:pointer;color:var(--dim);font-family:var(--font-body);font-weight:600;letter-spacing:1px;white-space:nowrap">${icon("search",18)}</button></div>`}
    </div>

    <!-- Body card: daily burn inputs + weight logging in one place -->
    <div class="nut-card">
      <div class="nut-card-title">Body</div>
      <div class="burn-row">
        <div class="burn-col"><input class="burn-inp" id="bvRest" type="number" inputmode="numeric" enterkeyhint="done" value="${resting}" ${ro?'disabled':''} onchange="saveBurn('${date}','resting',this.value)" onfocus="this.select()"><div class="burn-lbl">Resting${restOvr!=null?" (custom)":""}</div></div>
        
        <div class="burn-col"><input class="burn-inp" id="bvAct" type="number" inputmode="numeric" enterkeyhint="done" placeholder="0" value="${active||""}" ${ro?'disabled':''} onchange="saveBurn('${date}','active',this.value)" onfocus="this.select()"><div class="burn-lbl">Active</div></div>
        
        <div class="burn-col"><div class="burn-val">${totalBurn}</div><div class="burn-lbl">Total</div></div>
        
        <div class="burn-col${ro?"":" tappable"}" ${ro?"":`onclick="toggleWtOpen()"`} style="cursor:${ro?"default":"pointer"}">
          <div class="burn-val" style="${allWtKeys.length?"":"color:var(--dim)"}">${(()=>{if(!allWtKeys.length)return"·";const cur=wts[allWtKeys[allWtKeys.length-1]];const curFmt=Number(cur).toFixed(1);if(allWtKeys.length<2)return curFmt;const delta=cur-wts[allWtKeys[allWtKeys.length-2]];const arrow=delta<0?'<span style="font-size:11px;color:var(--green)"> ↓'+Math.abs(delta).toFixed(1)+"</span>":delta>0?'<span style="font-size:11px;color:var(--red)"> ↑'+delta.toFixed(1)+"</span>":"";return curFmt+arrow;})()}</div>
          <div class="burn-lbl">Weight${allWtKeys.length?" kg":""}</div>
        </div>
      </div>
      ${ro?"":_wtOpen
        ? `<div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--b1)"><input class="wt-inp" id="wtInp" type="number" step="0.1" placeholder="e.g. 138.5" inputmode="decimal" enterkeyhint="done" style="flex:1" onkeydown="if(event.key==='Enter'){event.preventDefault();saveWeight('${date}');}"><button class="wt-save" onclick="saveWeight('${date}')">Save</button><button class="food-cancel" onclick="toggleWtOpen()">✕</button></div>`
        : `<button onclick="toggleWtOpen()" style="width:100%;margin-top:10px;padding:9px;background:transparent;border:1px solid var(--b1);border-radius:var(--r-md);font-family:var(--font-body);font-size:13px;font-weight:600;color:var(--lt);cursor:pointer">${allWtKeys.length?"Update weight":"Log weight"}</button>`
      }
    </div>


    <div class="st-sec">Progress</div>

    ${phaseCardHtml()}

    ${weekDeficitHtml()}

    ${S.dietReview?.text?`<!-- Weekly AI diet review · generated server-side by the Sunday-midnight cron; button re-runs it on demand -->
    <details class="st-acc">
      <summary><div><div>${icon("bowl",20)} Weekly Diet Review</div><div class="st-acc-sub">Week of ${fmtDate(S.dietReview.weekStart)}, AI feedback on your goals</div></div></summary>
      <div class="st-acc-inner"><div style="font-size:13px;color:var(--lt);line-height:1.7;padding-top:12px">${mdLite(S.dietReview.text)}</div>
      <button id="dietRevBtn" onclick="generateDietReview()" ${_dietRevBusy?"disabled":""} style="margin-top:12px;background:transparent;border:1px solid var(--b1);border-radius:var(--r-md);padding:9px 14px;font-family:var(--font-body);font-size:12px;font-weight:600;color:var(--dim);cursor:pointer;width:100%">${_dietRevBusy?"Reviewing your week…":"↻ Regenerate review"}</button></div>
    </details>`:`
    <button id="dietRevBtn" onclick="generateDietReview()" ${_dietRevBusy?"disabled":""} style="margin:0 0 14px;background:transparent;border:1px solid var(--b1);border-radius:10px;padding:12px 14px;font-family:var(--font-body);font-size:13px;font-weight:600;color:var(--dim);cursor:pointer;width:100%">${_dietRevBusy?`${icon("bowl",20)} Reviewing your week…`:`${icon("bowl",20)} Generate Weekly Diet Review`}</button>`}

    <!-- Weight history & trend -->
    <details class="st-acc" ${_wtExpanded?"open":""} ontoggle="_wtExpanded=this.open">
      <summary><div><div>${icon("scale",20)} Weight History</div><div class="st-acc-sub">${allWtKeys.length?`${allWtKeys.length} entries, trend, arrival estimate`:"No entries yet"}</div></div></summary>
      <div class="st-acc-inner">
      ${sparkHtml}
      ${wtKeys.length?`<table style="width:100%;border-collapse:collapse;margin:10px 0 6px;font-size:12px">${wtKeys.slice().reverse().map((k,i)=>{const prev=wtKeys[wtKeys.length-2-i];const diff=prev!=null?wts[k]-wts[prev]:null;const col=diff==null?"":diff<0?"var(--green)":diff>0?"var(--red)":"var(--dim)";const diffTxt=diff==null?"":diff===0?"–":(diff>0?"+":"")+diff.toFixed(1)+"kg";return`<tr style="border-bottom:1px solid var(--b1)"><td style="padding:7px 0;color:var(--dim)">${fmtDate(k)}</td><td style="padding:7px 0;font-weight:700;color:var(--white);text-align:right">${Number(wts[k]).toFixed(1)} kg</td><td style="padding:7px 0;text-align:right;color:${col};width:56px">${diffTxt}</td>${ro?"":`<td style="padding:7px 0;text-align:right;width:32px"><button onclick="delWeight('${k}')" style="background:transparent;border:none;color:var(--dim);font-size:13px;cursor:pointer;padding:2px 4px">✕</button></td>`}</tr>`;}).join("")}</table>${wtTotalPages>1?`<div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--dim)">${_wtPage>0?`<button onclick="wtPage(${_wtPage-1})" style="background:var(--b1);border:none;color:var(--white);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer">← Newer</button>`:`<span></span>`}<span>Page ${_wtPage+1} of ${wtTotalPages}</span>${_wtPage<wtTotalPages-1?`<button onclick="wtPage(${_wtPage+1})" style="background:var(--b1);border:none;color:var(--white);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer">Older →</button>`:`<span></span>`}</div>`:""}<div class="wt-arrival" style="margin-top:8px">${arrHtml}</div><div class="wt-bmr">BMR (current): ${liveBMR} kcal</div>`:""}
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
  queueDayMeta(date, [field==="resting"?"restingOverride":"active"]);
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
// PRs are an append-only log, so deleting the set that produced one never
// removed it. This drops the single BEST entry, which is the one a mistyped
// weight creates, and lets the next-best legitimately resurface. Removing just
// the top entry rather than clearing the exercise keeps real history intact.
function dropPR(cid){
  const S=ctx.getS();
  const list=S.prs?.[cid]||[];
  if(!list.length)return;
  let bi=0;
  list.forEach((e,i)=>{if(e.est>list[bi].est)bi=i;});
  const gone=list[bi];
  if(!confirm(`Remove this PR?\n\n${gone.weight}kg × ${gone.reps} (est. 1RM ${gone.est}kg)\n\nThe next best result becomes your PR.`))return;
  list.splice(bi,1);
  if(!list.length)delete S.prs[cid];
  queueMutation("pr_delete",{exerciseId:cid,date:gone.date,est:gone.est});
  // Recompute from the logged sets rather than just falling back to the previous
  // stored PR: while the bad entry stood, every real lift under it was skipped.
  const next=ctx.recoverPRFromLog?.(cid)||(S.prs[cid]||[]).reduce((b,e)=>!b||e.est>b.est?e:b,null);
  save();
  showToast(next?`PR removed, now ${next.est}kg`:"PR removed");
  renderNutrition();
  if(typeof openDrawer==="function")setTimeout(()=>openDrawer(),0);
}
window.dropPR=dropPR;
function toggleShock(date){
  if(nutLocked(date))return;const day=getDayData(date);day.shockProtocol=!day.shockProtocol;save();queueDayMeta(date,["shock"]);renderNutrition();}
function openFood(){_foodChatOpen=true;_pendingFood=null;renderNutrition();setTimeout(()=>{const ta=document.getElementById("foodTa");if(ta)ta.focus();},50);}
function closeFood(){_foodChatOpen=false;_foodDraftText="";_foodDraftMealName="";renderNutrition();}
let _dietRevBusy=false;
async function generateDietReview(){
  if(_dietRevBusy)return;
  _dietRevBusy=true;renderNutrition();
  try{
    const r=await fetchT(API_CFG.baseUrl+"/api/cron-diet-review",{method:"POST",headers:{"Authorization":"Bearer "+API_CFG.token}},30000);
    const d=await r.json().catch(()=>({}));
    if(r.status===401){showToast("❌ Auth failed, app token doesn't match FORGE_API_TOKEN");return;}
    if(d.skipped){showToast("No food logged this week yet. Nothing to review.");return;}
    if(!r.ok||!d.ok)throw new Error(d.error||"error");
    await loadServerState(false);
    showToast("✅ Diet review ready");
  }catch(e){
    showToast("❌ Diet review failed. Try again.");
  }finally{
    _dietRevBusy=false;renderNutrition();
  }
}

// ── PHASE CARD: compliance, health, pause, verdict, AI review ───────────────
// "calories" (ate under target) and "active" (burned the target) were two
// PROXIES for the thing that actually determines the outcome. Both compared
// logged data against hardcoded phase constants, so when those constants drifted
// from reality the score was wrong in a way no amount of effort could fix.
// They collapse into one metric measuring the real deficit you produced against
// what the phase still needs. Their combined weight (0.55) carries over intact.
// Streak added at 0.05, taken from deficit (0.55 -> 0.50) so the set still sums
// to 1. It rewards not breaking the chain, which "workouts" alone does not:
// you can train 4 of 6 days every week and never build a streak.
// Medication tracking was removed (Oct 2026, user's request); its 5% moved to
// the deficit, the one metric that decides the goal.
// Oct 26 2026 (user reset): five habits the user controls, nothing derived
// from resting/active/intake maths. Food logging is the strongest predictor of
// loss in self-monitoring trials, so it carries most; the scale is the outcome
// and can't carry the score alone.
const COMPLIANCE_WEIGHTS={food:0.30,workouts:0.25,weight:0.25,weighins:0.10,active:0.10};
function mondayOfIso(dateIso){const dow=noonUTC(dateIso).getUTCDay();return addDaysIso(dateIso,dow===0?-6:1-dow);}
// Weighted compliance for [weekStartIso .. endIso]. Today is never charged
// until it ends (Toronto day, isoToday). A part with nothing to score yet is
// left out and the rest reweighted; with nothing at all, overall is null.
function weekCompliance(p,weekStartIso,endIso){
  const t=isoToday();
  const days=[];
  for(let i=0;i<7;i++){const d=addDaysIso(weekStartIso,i);if(d>endIso)break;days.push(d);}
  const week=[0,1,2,3,4,5,6].map(i=>addDaysIso(weekStartIso,i));
  const finished=days.filter(d=>d<t);
  const nd=d=>S.nutrition?.days?.[d]||{};
  const kcalOf=d=>(nd(d).items||[]).reduce((s,it)=>s+(Number(it.kcal)||0),0);
  const ws=S.nutrition?.weights||{};
  const pct=(n,of)=>of?Math.round(n/of*100):null;
  // Food: logged AND at or under the eat target. A 3,000 kcal day is logged
  // but not on target.
  const foodDays=finished.filter(d=>{const k=kcalOf(d);return k>0&&k<=eatKcalFor(phaseFor(d)||p,d);}).length;
  const weighDays=finished.filter(d=>ws[d]!=null).length;
  // Watch active target, clamped for scoring: eating LESS never lowers the
  // bar, and a day with nothing logged fails instead of being skipped.
  const activeDays=finished.filter(d=>{
    const ph=phaseFor(d)||p;
    const tgt=Math.max(0,Math.round(phaseActiveTarget(ph,d)+Math.max(0,kcalOf(d)-eatKcalFor(ph,d))/activeMult(d)));
    const a=Number(nd(d).active)||0;
    return a>0&&a>=tgt;
  }).length;
  // Workouts vs what was possible so far: planned days that have ended (plus
  // today once trained). An extra session on a rest day is never penalised.
  const trained=days.filter(d=>trainedOn(d)).length;
  const need=Math.max(1,Math.min(5,week.filter(d=>!isRestDay(d)).length));
  const expected=Math.min(need,finished.filter(d=>!isRestDay(d)).length+(days.includes(t)&&trainedOn(t)?1:0));
  // Weight vs the line. A weigh-in this week is judged against the line on
  // its own date; with none, the last known one is carried forward against
  // today's line, so skipping the scale decays instead of freezing a pass.
  // 0.5 kg deadband for water swings, capped at 100 when ahead.
  const r1=x=>Math.round(Number(x)*10)/10;
  const inWeek=Object.keys(ws).filter(k=>k>=weekStartIso&&k<=endIso&&ws[k]!=null).sort().pop();
  const prior=inWeek?null:Object.keys(ws).filter(k=>k<weekStartIso&&ws[k]!=null).sort().pop();
  const wDate=inWeek||prior||null;
  const lineDate=inWeek||(endIso<t?endIso:t);
  const behindKg=wDate?r1(Number(ws[wDate])-phaseCurveKg(phaseFor(lineDate)||p,lineDate)):null;
  const m={
    food:pct(foodDays,finished.length),
    workouts:expected>0?Math.min(100,Math.round(Math.min(trained,need)/expected*100)):null,
    weight:behindKg==null?null:behindKg<=0.5?100:Math.max(0,Math.round(100-(behindKg-0.5)*25)),
    weighins:pct(weighDays,finished.length),
    active:pct(activeDays,finished.length),
    foodDays,weighDays,activeDays,finishedDays:finished.length,
    // Logged at all (the goal card counts these; targets hit live in the drawer).
    foodLogged:finished.filter(d=>kcalOf(d)>0).length,activeLogged:finished.filter(d=>Number(nd(d).active)>0).length,
    trained,need,expected,behindKg,weighDate:wDate,carried:!inWeek&&!!wDate,v:2,
  };
  const parts=Object.entries(COMPLIANCE_WEIGHTS).filter(([k])=>m[k]!=null);
  const wSum=parts.reduce((s,[,w])=>s+w,0);
  m.overall=wSum>0?Math.round(parts.reduce((s,[k,w])=>s+m[k]*w,0)/wSum):null;
  return m;
}
// Live health colour — same distance bands as the phase-end verdict, applied
// to today's curve point instead of the phase target.
// Uses the exact latest weigh-in vs the curve value for its date (no range,
// no 7-day average). Colour still scales with how far behind; the label always
// states the exact gap.
function phaseHealth(p,todayIso){
  const w=weightVsCurve(p,todayIso);
  if(!w)return null;
  const d=-w.diff,abs=Math.abs(d).toFixed(1);
  if(d<=0)return{colour:"green",label:d<0?`Ahead by ${abs} kg`:"Exactly on plan"};
  const label=`Behind by ${abs} kg`;
  if(d<=1)return{colour:"yellow",label};
  if(d<=2)return{colour:"orange",label};
  return{colour:"red",label:label+": reassess"};
}
// End-of-phase colour bands with the user's prescribed actions, verbatim rule
function phaseVerdict(p,finalAvg){
  const d=finalAvg-p.targetKg;
  if(d<=1)return{band:"green",title:"On Target",action:"No changes. Continue to the next phase exactly as planned."};
  if(d<=2)return{band:"yellow",title:"Slightly Behind",action:"Keep calories the same. Increase average active calories by 100/day. Recalculate the next phase."};
  if(d<=4)return{band:"orange",title:"Moderately Behind",action:"Decision point. Option A: extend the timeline if the date is flexible. Option B: tighten the next phase in a calculated way (more activity, modest calorie reduction). The original numbers no longer apply as-is."};
  return{band:"red",title:"Reassess",action:"Stop and reassess before pushing harder: review calorie adherence, food-logging accuracy, Apple Watch data, training consistency, sleep and recovery, and any injury or illness. Only then adjust calories, activity, or the timeline."};
}
// Exactly one rule-based actionable recommendation (deterministic, no AI)
function coachRecommendation(p,todayIso,comp){
  const h=phaseHealth(p,todayIso);
  if(!h||!comp||comp.overall==null)return"Log food and weight consistently this week to unlock recommendations.";
  if(h.colour==="green"&&comp.overall>=90)return"Excellent adherence. Avoid the temptation to cut calories further.";
  if(h.colour==="green")return"Stay the course.";
  if(comp.food!=null&&comp.food<80)return"Log every meal and stay at 1,500 kcal on more days.";
  if(comp.active!=null&&comp.active<80)return"Hit the Watch active target on more days.";
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
  if(comp.overall==null)return;
  const r=ensurePhaseRun(p.id);
  r.weeks=r.weeks||[];
  r.weeks.push({week:lastMon,v:2,overall:comp.overall,perMetric:comp});
  save();queueSettings();
}
let _phasePauseOpen=false;
function pausePhase(id,reason,extend){
  const run=ensurePhaseRun(id);
  run.pauses.push({start:isoToday(),reason,extend:!!extend,resumed:null});
  _phasePauseOpen=false;
  save();queueSettings();renderNutrition();
  showToast("⏸ Phase paused, "+reason+(extend?", phase will extend":""));
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
  const finalAvg=weightVsCurve(p,t)?.kg??latestWeightLog()??p.startKg;
  const v=phaseVerdict(p,finalAvg);
  run.completedAt=t;run.outcome=v.band;run.locked=true;
  const weeks=run.weeks||[];
  const scored=weeks.filter(w=>Number.isFinite(w.overall));
  const avgCompliance=scored.length?Math.round(scored.reduce((s,w)=>s+w.overall,0)/scored.length):null;
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
    activeTargets:phaseActiveTargets(p,t),
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
    const wvc=weightVsCurve(p,t);
    const run=getPhaseRun(p.id);
    const at=phaseActiveTargets(p,t);
    const restingNow=restingForPhase(p,t);
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
    // Progress so far and how to get back on track (user, Oct 26). History
    // weeks scored before the reset (no v:2) carry only their overall %, so
    // the prompt never reads "undefined of undefined".
    const hist=(run.weeks||[]).slice(-4).map(w=>w.v===2&&w.perMetric
      ?{week:w.week,overall:w.overall,foodOnTargetDays:w.perMetric.foodDays,weighInDays:w.perMetric.weighDays,activeTargetDays:w.perMetric.activeDays,finishedDays:w.perMetric.finishedDays,workouts:`${w.perMetric.trained} of ${w.perMetric.need}`}
      :{week:w.week,overall:w.overall,note:"scored under the old method"});
    const daysLeft=Math.max(1,daysBetween(t,end));
    const latestKg=wvc?wvc.kg:latestWeightLog();
    const needPerWeek=latestKg!=null?Math.round((latestKg-p.targetKg)/daysLeft*7*10)/10:null;
    const facts={
      currentPhase:`${p.name||p.id}: ${p.startKg} kg on ${p.start} to ${p.targetKg} kg by ${p.plannedEnd} (5 kg phases)`,
      hardGoals:GOAL_CHECKPOINTS.filter(c=>c.by>=t).map(c=>({kg:c.kg,by:c.by,kgPerWeekNeededNow:latestKg!=null?Math.round((latestKg-c.kg)/Math.max(1,daysBetween(t,c.by))*7*10)/10:null})),
      eatKcalPerDay:p.eatKcalRest!=null?`${p.eatKcal} Mon-Sat, ${p.eatKcalRest} on the rest day`:p.eatKcal,watchActiveTargets:at,
      planLineToday:phaseCurveKg(p,t),
      latestWeighIn:wvc?{date:wvc.date,kg:wvc.kg,planThatDay:wvc.expected,aheadKg:wvc.diff}:null,
      lostSoFarKg:latestKg!=null?Math.round((p.startKg-latestKg)*10)/10:null,
      plannedLossSoFarKg:Math.round((p.startKg-phaseCurveKg(p,t))*10)/10,
      kgPerWeekNeededNow:needPerWeek,daysLeft,
      thisWeek:comp.overall==null?null:{overall:comp.overall,foodOnTargetDays:`${comp.foodDays} of ${comp.finishedDays}`,workouts:`${comp.trained} of ${comp.need} done`,weightVsLineKg:comp.behindKg,weighInDays:`${comp.weighDays} of ${comp.finishedDays}`,activeTargetDays:`${comp.activeDays} of ${comp.finishedDays}`},
      lastWeeks:hist,last14Days:days,
    };
    const prompt=`Goal progress review. The user scores their week on five habits: food logged and at or under the day's target of ${p.eatKcal} kcal${p.eatKcalRest!=null?` (${p.eatKcalRest} on the rest day)`:""} (30%), 5 workouts a week (25%), weight at or under the plan line (25%), a daily weigh-in (10%), the Watch active target (10%).\nFacts: ${JSON.stringify(facts)}\n\nThe hard goals (hardGoals) must still be hit; the phases are steps toward them.\nAs their coach, write: first, two sentences on how the goal is going so far (ahead or behind the line, by how much, and whether the habits explain it). Then up to three concrete actions with numbers that get them back on track for the next checkpoint (for example "eat at 1,500 on 6 of 7 days", "add a 20 min walk on rest days", "weigh in every morning"). If they are on track, say what to keep doing instead. Plain text, short lines, no headings, no em dashes.`;
    const r=await fetchT(API_CFG.baseUrl+"/api/coach",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},body:JSON.stringify({prompt})},60000);
    const d=await r.json();
    if(!r.ok||!d.text)throw new Error(d.error||"failed");
    S.phaseReview={phase:p.id,text:d.text,at:Date.now()};
    save();queueSettings();
  }catch(e){
    showToast("AI unavailable, try again");
  }finally{
    _phaseRevBusy=false;renderNutrition();
  }
}
// The 🎯 phase card (Nutrition tab). Returns "" when no phase is relevant.
// Found while verifying the phase-3 changes: a plain `.find()` here takes
// array order, so a phase that has PASSED ITS DATE but was never explicitly
// completed via completePhase() (locked stays false until that button is
// clicked) reads as "completed" and, sitting earlier in the array, won a tie
// against the phase that's genuinely active today. In a session where
// phase_1 was never explicitly locked, this card would show a done phase
// from September instead of the real one. Two passes instead: an active/
// paused phase always wins over a merely date-elapsed, unlocked one.
// ── WEEKLY DEFICIT TRACKER ─────────────────────────────────────────────────
// Brought back (Oct 27, user: "we used to have a weekly tracker that tells us
// whether we are on track"). Unlike the old Settings card, a day only counts
// when food, the workout (training days), Watch active and resting are ALL
// logged (dayDeficitCheck). An incomplete day says what is missing and stays
// out of the totals; today is still in progress and is counted tomorrow.
// "On track" compares the counted days' deficit with what the plan needed
// from those same days, so a week with gaps is judged fairly.
function weekDeficitSummary(monIso){
  const t=isoToday();
  const days=[];let total=0,need=0,counted=0,weekNeed=0;
  for(let i=0;i<7;i++){
    const d=addDaysIso(monIso,i);
    const c=dayDeficitCheck(d,trainedOn(d));
    weekNeed+=c.expected||0;
    const state=d>t?"future":d===t?"today":c.complete?"counted":"missing";
    if(state==="counted"){counted++;total+=c.deficit;need+=c.expected||0;}
    days.push({d,state,...c});
  }
  const finished=days.filter(x=>x.state==="counted"||x.state==="missing").length;
  // Days people skip logging tend to be the worse ones, so a week with gaps
  // gets no verdict: more than 2 finished days uncounted (this week), or
  // fewer than 5 of 7 counted (a finished week).
  const thin=monIso<mondayOfIso(t)?counted<5:finished-counted>2;
  return{days,total,need,counted,finished,thin,weekNeed:Math.round(weekNeed),gap:total-need};
}
function weekDeficitHtml(){
  const t=isoToday();
  const thisMon=mondayOfIso(t);
  const w=weekDeficitSummary(thisMon);
  if(!phaseFor(t))return"";
  const n=x=>Math.round(Math.abs(x)).toLocaleString();
  const kg=x=>(Math.abs(x)/7700).toFixed(1);
  const dayLbl=d=>new Date(d+"T12:00:00Z").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",timeZone:"UTC"});
  const verdict=s=>!s.counted?null:s.thin?{txt:"Not enough data",col:"var(--mid)"}:s.gap>=0.05*s.need?{txt:`${n(s.gap)} kcal ahead`,col:"var(--green)"}:s.gap>=-0.05*s.need?{txt:"On track",col:"var(--green)"}:{txt:`${n(s.gap)} kcal behind (about ${kg(s.gap)} kg)`,col:"var(--red)"};
  const v=verdict(w);
  const line=(lbl,val,col)=>`<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:9px 0;border-top:1px solid var(--b1);font-size:15px"><span style="color:var(--lt);white-space:nowrap">${lbl}</span><span style="text-align:right;font-variant-numeric:tabular-nums;color:${col||"var(--white)"}">${val}</span></div>`;
  const rows=w.days.map(x=>{
    if(x.state==="future")return"";
    if(x.state==="today")return line(dayLbl(x.d),"Today, counted tomorrow","var(--mid)");
    if(x.state==="missing")return line(dayLbl(x.d),"Not counted: no "+x.missing.join(", no "),"var(--amber)");
    return line(dayLbl(x.d),`${n(x.deficit)} of ${n(x.expected)}`,x.deficit>=x.expected?"var(--green)":"var(--red)");
  }).join("");
  const past=[1,2,3,4].map(k=>{const m=addDaysIso(thisMon,-7*k);if(!phaseFor(addDaysIso(m,6))&&!phaseFor(m))return"";const s=weekDeficitSummary(m),pv=verdict(s);
    return line("Week of "+fmtDate(m),s.counted?`${pv.txt}, ${s.counted} of 7 days counted`:"No complete days",s.counted?pv.col:"var(--mid)");}).join("");
  // The scale is the real answer: this week's weight change vs the plan line.
  const ws=S.nutrition?.weights||{};
  const wk=Object.keys(ws).filter(k=>k<=t&&ws[k]!=null).sort();
  const w0k=wk.filter(k=>k<thisMon).pop()||wk.find(k=>k>=thisMon),w1k=wk.filter(k=>k>=thisMon).pop();
  const pph=phaseFor(t);
  let weightLine="";
  if(w0k&&w1k&&w0k!==w1k&&pph){
    const act=Math.round((Number(ws[w1k])-Number(ws[w0k]))*10)/10;
    const plan=Math.round((phaseCurveKg(phaseFor(w1k)||pph,w1k)-phaseCurveKg(phaseFor(w0k)||pph,w0k))*10)/10;
    weightLine=line("Weight this week",`${act>0?"+":""}${act.toFixed(1)} kg, plan ${plan.toFixed(1)} kg`,act<=plan+0.2?"var(--green)":"var(--red)");
  }
  const cal=activeCalibration(t);
  const calLine=cal.ready
    ?`Watch check: your weight trend says ${Math.round(cal.mult*100)}% of the Watch's active calories are real (${cal.lostKg} kg lost vs ${cal.predictedKg} kg predicted), so targets use ${Math.round(cal.mult*100)}%.`
    :`Watch check: counting 75% of the Watch's active calories until there are 3 weeks of logs and weigh-ins${cal.readyOn?` (from ${fmtDate(cal.readyOn)})`:""}. Then the weight trend sets it.`;
  const head=!w.counted?(w.finished?"No complete day yet":"Week starting"):w.thin?`Not enough data, ${w.finished-w.counted} days missing`:`${v.txt}`;
  return`<details class="st-acc" open>
    <summary><div><div>${icon("chart",20)} Weekly deficit</div><div class="st-acc-sub">${head}${w.counted?`, ${w.counted} of ${w.finished} days counted`:""}</div></div></summary>
    <div class="st-acc-inner" style="padding-top:10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
        <span style="font-size:15px;color:var(--mid)">This week so far</span>
        <span style="font-family:var(--font-num);font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;color:${v?v.col:"var(--mid)"}">${w.counted?n(w.total):"0"} <span style="font-size:15px;font-weight:400;color:var(--mid)">of ${n(w.need)} kcal</span></span>
      </div>
      <div style="font-size:13px;color:var(--mid);margin:4px 0 6px">${v?`${v.txt}. `:""}The week needs ${n(w.weekNeed)} kcal. A day counts once food, the workout and active calories are logged. Resting is the number you enter, or 2,700 until you do.</div>
      ${weightLine}
      ${rows}
      <div style="font-size:13px;color:var(--mid);margin-top:10px">${calLine}</div>
      ${past?`<div style="font-size:13px;font-weight:600;color:var(--mid);margin-top:14px">Last 4 weeks</div>${past}`:""}
    </div>
  </details>`;
}
function phaseCardHtml(){
  const t=isoToday();
  const active=PHASES.find(x=>{const st=phaseState(x,t);return st==="active"||st==="paused";});
  const p=active||PHASES.find(x=>phaseState(x,t)==="completed"&&!getPhaseRun(x.id).locked);
  if(!p)return"";
  const st=phaseState(p,t);
  const run=getPhaseRun(p.id);
  const end=effectiveEnd(p,t);
  const totalDays=Math.max(1,daysBetween(p.start,end));
  // Days are inclusive: a phase from Oct 26 to Nov 15 has 21 of them.
  const spanDays=totalDays+1;
  const dayIn=Math.min(Math.max(daysBetween(p.start,t)+1,1),spanDays);
  const pctDone=Math.round(Math.min(100,Math.max(0,daysBetween(p.start,t)/totalDays*100)));
  const avg=sevenDayAvg(t);
  const cor=phaseCorridor(p,t);
  const health=phaseHealth(p,t);
  const banked=bankedDays(p,t);
  const comp=weekCompliance(p,mondayOfIso(t),t);
  const proj=projectedFinish(t);
  const fmtD=fmtDate;
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
  if(FEATURES.goalVerdict&&st==="completed"&&!run.locked){
    const finalAvg=avg??latestWeightLog()??p.startKg;
    const v=phaseVerdict(p,finalAvg);
    verdictHtml=`<div style="border:1px solid var(--b1);border-radius:12px;padding:12px 14px;margin-top:10px;background:var(--s2)">
      <div style="font-weight:700;font-size:14px;margin-bottom:4px"><span class="band-dot band-${v.band}"></span>${v.title}, final weigh-in ${finalAvg} kg vs target ${p.targetKg} kg</div>
      <div style="font-size:12px;color:var(--lt);line-height:1.6">${v.action}</div>
      <button onclick="completePhase('${p.id}',false)" style="margin-top:10px;width:100%;background:var(--accent);color:var(--accent-ink);border:none;border-radius:8px;padding:10px;font-family:var(--font-body);font-weight:700;font-size:13px;cursor:pointer">Record verdict & lock phase</button>
    </div>`;
  }
  const inLastWeek=daysBetween(t,end)<=7&&st!=="completed";

  // Sunday coach summary (visible Sunday → Saturday for the week just ended)
  let sundayHtml="";
  {
    const thisMon=mondayOfIso(t);
    const lastMon=addDaysIso(thisMon,-7);
    const showWeekMon=isRestDay(t)?thisMon:lastMon; // on Sunday summarise the week ending today
    if(FEATURES.goalWeekSummary&&showWeekMon>=p.start){
      const wEnd=addDaysIso(showWeekMon,6);
      const wc=weekCompliance(p,showWeekMon,wEnd>t?t:wEnd);
      const wN=Math.floor(daysBetween(p.start,showWeekMon)/7)+1;
      const ws=S.nutrition.weights||{};
      let wDelta=null;
      const w0=ws[showWeekMon]??ws[addDaysIso(showWeekMon,-1)],w1=ws[wEnd]??ws[addDaysIso(wEnd,-1)]??ws[t];
      if(w0!=null&&w1!=null)wDelta=Math.round((Number(w1)-Number(w0))*10)/10;
      if(wc.overall!=null){
        sundayHtml=`<div style="border:1px solid var(--b1);border-radius:12px;padding:12px 14px;margin-top:10px;background:var(--s2)">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Week ${wN} summary</div>
          ${wDelta!=null?row("Weight",`${wDelta>0?"+":""}${wDelta} kg`):""}
          ${banked?row(banked.kg>=0?"Ahead of schedule":"Behind schedule",`${Math.abs(banked.kg)} kg`):""}
          ${row("Food on target",wc.food==null?"·":wc.food+"%")}
          ${row("Workouts",wc.workouts==null?"·":wc.workouts+"%")}
          ${row("This week's score",wc.overall+"%")}
          <div style="font-size:12px;color:var(--accent-text);font-weight:600;margin-top:6px">→ ${coachRecommendation(p,t,wc)}</div>
        </div>`;
      }
    }
  }

  // Fix A+B+C+D: weight block, range row, short chip
  const latestKg=latestWeightLog();
  const latest=latestKg??p.startKg;
  const remaining=Math.max(0,Math.round((latest-p.targetKg)*10)/10);
  const weightBlockHtml=
    '<div style="background:var(--s2);border-radius:8px;padding:10px 12px;margin:4px 0 8px">'+
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">'+
        '<span style="font-size:15px;color:var(--mid)">Latest weight</span>'+
        '<span style="font-family:var(--font-display);font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1">'+Number(latest).toFixed(1)+' <span style="font-size:13px;font-weight:600;color:var(--mid)">kg</span></span>'+
      '</div>'+
      '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--dim)">'+
        '<span>Target '+p.targetKg+' kg, '+remaining+' to go</span>'+
        '<span>Start: '+p.startKg+' kg</span>'+
      '</div>'+
    '</div>';

  // Exact: the weigh-in the user entered vs what the curve says it should
  // have been on that same date. No ±1 kg band, no 7-day average.
  // The hard goals every phase serves, with the pace each needs from today.
  const checkpointsHtml=GOAL_CHECKPOINTS.filter(c=>c.by>=t).map(c=>{
    const left=Math.max(1,daysBetween(t,c.by));
    const need=Math.max(0,Math.round((latest-c.kg)/left*7*10)/10);
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px"><span style="color:var(--mid)">'+c.kg+' kg by '+fmtDate(c.by)+'</span><span style="font-weight:600;font-variant-numeric:tabular-nums">'+need+' kg a week needed</span></div>';
  }).join("");
  const wvc=weightVsCurve(p,t);
  let rangeRowHtml='<div style="font-size:12px;color:var(--dim);padding:4px 0">Log a weigh-in to compare against the plan</div>';
  if(wvc){
    const ok=wvc.diff>=0;
    const chipBg=ok?'var(--green-lo)':'var(--red-lo)';
    const chipCol=ok?'var(--green)':'var(--red)';
    const chipTxt=wvc.diff===0?'✓ Exactly on plan':(ok?'Ahead ':'Behind ')+Math.abs(wvc.diff).toFixed(1)+' kg';
    rangeRowHtml=
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;gap:8px">'+
        '<div style="display:flex;flex-direction:column;gap:1px">'+
          '<span style="font-size:13px;color:var(--mid)">Plan for '+(wvc.date===t?'today':fmtDate(wvc.date))+'</span>'+
          '<span style="font-size:10px;color:var(--dim)">Your weigh-in: '+Number(wvc.kg).toFixed(1)+' kg</span>'+
        '</div>'+
        '<div style="display:flex;align-items:center;gap:6px;white-space:nowrap">'+
          '<span style="font-weight:600;font-variant-numeric:tabular-nums">'+Number(wvc.expected).toFixed(1)+' kg</span>'+
          '<span style="background:'+chipBg+';color:'+chipCol+';border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700">'+chipTxt+'</span>'+
        '</div>'+
      '</div>';
  }

  let debtHtml='';
  if(FEATURES.goalBanked&&banked){const ahead=banked.days>=0;debtHtml='<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:13px"><span style="color:var(--mid)">'+(ahead?'Banked':'Behind schedule')+'</span><span style="background:'+(ahead?'var(--green-lo)':'var(--red-lo)')+';color:'+(ahead?'var(--green)':'var(--red)')+';border-radius:6px;padding:3px 9px;font-size:12px;font-weight:700">'+(ahead?'▲':'▼')+' '+Math.abs(banked.kg)+' kg, '+Math.abs(banked.days)+'d '+(ahead?'ahead':'behind')+'</span></div>';}

  // This week: five habit rows (user, Oct 26). Progress copy, not failure
  // copy: "3 of 5 done" on a Wednesday is on schedule, not 60%.
  const scoreCol=v=>v==null?'var(--mid)':v>=80?'var(--green)':v>=50?'var(--amber)':'var(--red)';
  const habit=(lbl,val,score)=>'<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:7px 0;border-top:1px solid var(--b1);font-size:14px"><span style="color:var(--lt)">'+lbl+'</span><span style="font-weight:600;font-variant-numeric:tabular-nums;color:'+scoreCol(score)+'">'+val+'</span></div>';
  const ofDays=n=>comp.finishedDays?n+' of '+comp.finishedDays+' days':'Starts tomorrow';
  const wLine=comp.behindKg==null?'No weigh-in yet'
    :(comp.behindKg<=0?Math.abs(comp.behindKg).toFixed(1)+' kg ahead':comp.behindKg.toFixed(1)+' kg behind')+(comp.carried?' (last weigh-in)':'');
  // Oct 28 (user): the card counts days LOGGED, not days a target was met;
  // targets hit and the score live in the Insights drawer (weekTargetsHtml).
  const compHtml=
    habit('Food logged',ofDays(comp.foodLogged),null)+
    habit('Workouts',comp.trained+' of '+comp.need+' done'+(comp.trained<comp.need?', '+(comp.need-comp.trained)+' to go':''),null)+
    habit('Weight vs line',wLine,null)+
    habit('Weigh-ins',ofDays(comp.weighDays),null)+
    habit('Watch active logged',ofDays(comp.activeLogged),null);

  // Live status chip in the collapsed summary
  // Explicit states: never "Behind -0.8 kg", "null kg" or "null%".
  const chipW=!wvc?"No weigh-in yet":wvc.diff===0?"On the line":wvc.diff>0?`${Math.abs(wvc.diff).toFixed(1)} kg ahead`:`${Math.abs(wvc.diff).toFixed(1)} kg behind`;
  const chipText=`${chipW}, ${comp.overall!=null?comp.overall+"% this week":"week starting"}`;
  return`<details class="st-acc"${st==="completed"?" open":""}>
    <summary><div><div>${icon("target",20)} ${esc(p.name||p.id.replace("_"," ").replace(/^p/,"P"))}</div><div class="st-acc-sub">${chipText}</div></div></summary>
    <div class="st-acc-inner" style="padding-top:10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
        <span style="${nMuted}">Day ${dayIn} of ${spanDays}, ${p.startKg} to ${p.targetKg} kg by ${fmtD(end)}</span>
        <span style="font-weight:700;font-size:14px">${pctDone}%</span>
      </div>
      <div class="prog-bar-wrap" style="margin-bottom:14px"><div class="prog-bar-fill" style="width:${pctDone}%">${pctDone>2&&pctDone<99?'<div class="prog-thumb"></div>':""}</div></div>
      ${weightBlockHtml}
      ${rangeRowHtml}
      ${checkpointsHtml}
      ${debtHtml}
      <div style="margin-top:12px">
        <div style="font-size:13px;font-weight:600;color:var(--mid);margin-bottom:2px">This week</div>
        ${compHtml}
      </div>
      ${FEATURES.goalDrift&&health&&(health.colour==="yellow"||health.colour==="orange"||health.colour==="red")&&pctDone>=50&&st!=="completed"?`<div style="font-size:12px;color:var(--amber);margin-top:8px">⚠ Mid-phase drift: add ~100 kcal/day active or revisit the plan.</div>`:""}
      ${sundayHtml}
      ${verdictHtml}
      ${S.phaseReview?.phase===p.id&&S.phaseReview.text?`<div style="border:1px solid var(--b1);border-radius:12px;padding:12px 14px;margin-top:10px;background:var(--s2)"><div style="font-size:10px;font-weight:700;letter-spacing:1px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">${icon("spark",15)} Coach review, ${fmtDate(new Date(S.phaseReview.at).toISOString().slice(0,10))}</div><div style="font-size:12px;color:var(--lt);line-height:1.6">${mdLite(S.phaseReview.text)}</div></div>`:""}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button onclick="aiPhaseReview('${p.id}')" ${_phaseRevBusy?"disabled":""} style="flex:1;background:transparent;border:1px solid var(--b1);border-radius:var(--r-md);padding:9px;font-family:var(--font-body);font-size:12px;font-weight:600;color:var(--dim);cursor:pointer">${_phaseRevBusy?"Reviewing…":`${icon("spark",15)} Review my progress`}</button>
        ${!FEATURES.goalPause?"":openPause?`<button onclick="resumePhase('${p.id}')" style="flex:1;background:var(--accent);color:var(--accent-ink);border:none;border-radius:8px;padding:9px;font-family:var(--font-body);font-size:12px;font-weight:700;cursor:pointer">▶ Resume</button>`
          :st!=="completed"?`<button onclick="_phasePauseOpen=!_phasePauseOpen;renderNutrition()" style="flex:1;background:transparent;border:1px solid var(--b1);border-radius:var(--r-md);padding:9px;font-family:var(--font-body);font-size:12px;font-weight:600;color:var(--dim);cursor:pointer">${icon("moon",16)} Pause phase</button>`:""}
        ${FEATURES.goalVerdict&&inLastWeek?`<button onclick="completePhase('${p.id}',true)" style="flex:1;background:transparent;border:1px solid var(--b1);border-radius:var(--r-md);padding:9px;font-family:var(--font-body);font-size:12px;font-weight:600;color:var(--dim);cursor:pointer">✓ Accept current result</button>`:""}
      </div>
      ${FEATURES.goalPause&&openPause?`<div style="${nMuted};margin-top:8px">Paused, ${esc(openPause.reason)}, ${Math.max(0,daysBetween(openPause.start,t))} day${daysBetween(openPause.start,t)===1?"":"s"}${openPause.extend?", extends phase":", deadline unchanged"}</div>`:""}
      ${FEATURES.goalPause&&_phasePauseOpen&&!openPause?`<div style="border:1px solid var(--b1);border-radius:12px;padding:12px;margin-top:10px;background:var(--s2)">
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">Pause reason</div>
        <div style="display:flex;gap:6px;margin-bottom:10px">${["Medical","Vacation","Other"].map(r=>`<button onclick="_phasePauseReason='${r}';renderNutrition()" style="flex:1;background:${_phasePauseReason===r?"var(--accent)":"var(--s1)"};color:${_phasePauseReason===r?"var(--accent-ink)":"var(--lt)"};border:1px solid var(--b2);border-radius:8px;padding:8px;font-family:var(--font-body);font-size:12px;font-weight:600;cursor:pointer">${r}</button>`).join("")}</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--lt);margin-bottom:10px"><input type="checkbox" id="pauseExtend" ${_phasePauseExtend?"checked":""} onchange="_phasePauseExtend=this.checked"> Extend the phase by the paused days</label>
        <button onclick="pausePhase('${p.id}',_phasePauseReason,document.getElementById('pauseExtend').checked)" style="width:100%;background:var(--accent);color:var(--accent-ink);border:none;border-radius:8px;padding:10px;font-family:var(--font-body);font-weight:700;font-size:13px;cursor:pointer">Confirm pause</button>
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
    if(out){out.className="ai-out show";out.textContent="Could not estimate, try again or be more specific.";}
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
// Foods you have eaten before that fit what is left today (Oct 28: "need
// about 40 g protein, suggest a David protein bar, I know those items").
// Only familiar foods (logged twice, or in the last 14 days), only ones that
// fit inside the calories left, ranked by how much of the protein gap they
// close, then protein density, then how often you eat them. A pair of two
// foods is offered when no single one closes most of the gap. Pure: the Food
// tab and the "How was today?" coach both read it.
export function foodSuggestions(date,kcalRoom,proteinLeft,limit=3){
  kcalRoom=Math.round(Number(kcalRoom)||0);proteinLeft=Math.max(0,Math.round(Number(proteinLeft)||0));
  if(kcalRoom<60)return[];
  const ds=x=>Math.round((new Date(date+"T12:00:00")-new Date(x+"T12:00:00"))/86400000);
  const pool=buildFoodHistory(date).filter(f=>f.kcal>=60&&f.kcal<=kcalRoom&&(f.n>=2||ds(f.last)<=14));
  const wantP=proteinLeft>=10;
  const score=(kcal,prot,n)=>{
    const cover=wantP?Math.min(prot,proteinLeft)/proteinLeft:0;
    const dens=kcal>0?Math.min(1,(prot*4/kcal)/0.5):0;
    const fam=Math.min(n,10)/10;
    return wantP?cover*0.6+dens*0.25+fam*0.15:fam*0.7+dens*0.3;
  };
  const one=pool.filter(f=>!wantP||f.protein>=5).map(f=>({items:[f],kcal:f.kcal,protein:Math.round(f.protein),s:score(f.kcal,f.protein,f.n)}))
    .sort((a,b)=>b.s-a.s);
  let out=one.slice(0,limit);
  const bestCover=wantP&&one[0]?Math.min(one[0].protein,proteinLeft)/proteinLeft:1;
  if(wantP&&bestCover<0.75){
    const top=one.slice(0,12);let pair=null;
    for(let i=0;i<top.length;i++)for(let j=i+1;j<top.length;j++){
      const a=top[i].items[0],b=top[j].items[0],k=a.kcal+b.kcal,pr=Math.round(a.protein+b.protein);
      if(k>kcalRoom)continue;
      const s=score(k,pr,Math.min(a.n,b.n));
      if(Math.min(pr,proteinLeft)/proteinLeft>=bestCover+0.2&&(!pair||s>pair.s))pair={items:[a,b],kcal:k,protein:pr,s};
    }
    if(pair)out=[pair,...one.slice(0,limit-1)];
  }
  return out.map(o=>({name:o.items.map(f=>f.name).join(" + "),kcal:Math.round(o.kcal),protein:o.protein,items:o.items}));
}
let _fitSugg=[];
function addFoodSuggestion(date,i){
  const sug=_fitSugg[i];
  if(!sug||nutLocked(date))return;
  const day=getDayData(date);
  sug.items.forEach((f,k)=>{
    const item={id:"n_"+(Date.now()+k),name:f.name,kcal:f.kcal,protein:f.protein||0,carbs:f.carbs||0,fat:f.fat||0,fibre:f.fibre||0,sugar:f.sugar||0,sodium:f.sodium||0,time:Date.now()};
    day.items.push(item);queueMutation("nutrition_item_add",{date,item});
  });
  save();checkMilestones();showToast("Added "+sug.name+" ✓");renderNutrition();
}
window.addFoodSuggestion=addFoodSuggestion;
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
        <div style="font-size:11px;color:var(--dim);margin-top:2px">${f.kcal} kcal, P ${f.protein||0}g, C ${f.carbs||0}g, F ${f.fat||0}g${f.kcal>0?`, ${Math.round((f.protein||0)*400/f.kcal)}% protein`:""}${f.n>1?`, ${f.n}×`:""}</div>
      </div>
      <span style="font-size:20px;color:var(--accent-text);padding-left:12px">+</span>
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
  const raw=parseFloat(inp.value);if(isNaN(raw)||raw<30||raw>300){showToast("Enter a valid weight");return;}
  const val=kg1(raw);
  _wtPage=0;S.nutrition.weights[date]=val;_wtOpen=false;save();queueMutation("weight",{date,kg:val},"weight:"+date);checkMilestones();showToast("Weight logged ✓");renderNutrition();
}
function delWeight(date){
  _wtPage=0;delete S.nutrition.weights[date];save();queueMutation("weight_delete",{date});showToast("Entry removed");renderNutrition();
}
export function buildSparkline(keys,wts,summary){
  if(keys.length<2)return"";
  // Rounded once at source. The footer prints vals[0] and vals[n] directly, so
  // rounding only the labels would leave the same noise in the delta and the
  // per-month figure. Harmless for the PR sparklines, whose est 1RMs are whole.
  const vals=keys.map(k=>kg1(wts[k]));
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
      footer=`<div class="wt-recent">Avg: <span style="color:${col};font-weight:700">${perMonth<=0?"":"+"}${perMonth.toFixed(1)} kg/month</span>, ${vals[0]}kg → ${vals[vals.length-1]}kg over ${Math.round(days)} days</div>`;
    }else{
      footer=`<div class="wt-recent">${vals[0]}kg → ${vals[vals.length-1]}kg, monthly avg unlocks in ${30-Math.round(days)} days</div>`;
    }
  }else{
    // Reads wts directly rather than vals, so it needs its own rounding.
    footer=`<div class="wt-recent">${keys.slice(-3).map(k=>`${k}: <span>${kg1(wts[k])}kg</span>`).join(", ")}</div>`;
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
  if(slope>=-0.01)return`Estimated arrival: <b>trend flat or rising, check deficit</b>`;
  const smoothed=my+slope*(xs[n-1]-mx); // trend-line weight at latest date
  const daysNeeded=Math.ceil((smoothed-USER.targetKg)/Math.abs(slope));
  if(daysNeeded>730)return`Estimated arrival: <b>over 2 years at this pace, check deficit</b>`;
  const arrival=new Date(recent[n-1]+"T12:00:00");arrival.setDate(arrival.getDate()+daysNeeded);
  const diff=Math.round((USER.goalDate-arrival)/86400000);
  const ahead=diff>0?` (${diff}d ahead)`:diff<0?` (${Math.abs(diff)}d behind)`:" (on track)";
  const rate=Math.abs(slope*7).toFixed(1);
  return`Estimated arrival: <b>${fmtDate(arrival.toISOString().slice(0,10))}</b>${ahead}, losing ~${rate} kg/week`;
}
function handleHKSync(){
  const p=new URLSearchParams(location.search);if(!p.get("hksync"))return;
  const active=parseInt(p.get("active")||"0"),date=p.get("date")||isoToday();
  if(!isNaN(active)&&active>=0){getDayData(date).active=active;save();queueDayMeta(date,["active"]);showToast(`⚡ Active calories synced (${active} kcal)`);}
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
// This week's weekly-deficit standing, for the "How was today?" review.
ctx.weekDeficitNow=()=>weekDeficitSummary(mondayOfIso(isoToday()));
ctx.foodSuggestions=foodSuggestions;
