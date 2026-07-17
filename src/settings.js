import { ctx } from "./runtime.js";
import { ACTIVE_MULT, USER, PHASES, calcBMR, isoDate, isoToday, addDaysIso, latestWeightLog, phaseDayDeficit, phaseFor, requiredDeficit, restingFor, phaseState, bankedDays, projectedFinish, sevenDayAvg, effectiveEnd } from "./phase.js";
import { esc, mdLite, showToast, toggleTheme } from "./ui.js";
import { save, listDailyBackups } from "./state.js";
import { API_CFG, flushOutbox, loadServerState, queueMutation, queueSettings, getOutbox, listSnapshots, restoreSnapshot } from "./sync.js";
import { PROG, DAYS } from "./constants.js";

// Settings
export function renderST(){
  document.getElementById("tc").innerHTML=`<div class="st-wrap">
    <div class="st-pg-title">Set<span>tings</span></div>
    <div class="st-pg-sub">FORGE · personal · private</div>

    <!-- Group 1: This Week -->
    <details class="st-acc" open>
      <summary><div><div>📅 This Week</div><div class="st-acc-sub">Plan · volume tracker</div></div></summary>
      <div class="st-acc-inner">
        <div class="st-sec">Weekly Plan</div>
        <div class="export-card" style="border-left-color:var(--green)">
          <div class="export-title">Generate Next Week</div>
          <div class="export-sub">Progressive overload applied automatically from this week's sessions.${(()=>{const wps=S.weekPlans||{};let m='';if(wps[wk()])m+='<br><span style="color:var(--green);font-weight:600">✓ Custom plan active this week</span>';if(wps[nextWk()])m+='<br><span style="color:var(--amber);font-weight:600">📅 Plan queued for '+esc(weekLabel(nextWk()))+'</span>';return m;})()}</div>
          <button class="btn-o gen-plan-btn" onclick="genWeeklyPlan()" style="width:100%;margin-bottom:8px">Generate Next Week</button>
          ${Object.keys(S.weekPlans||{}).length?`<button class="btn-g" onclick="resetPlan()" style="width:100%">Reset to Default Program</button>`:''}
        </div>
        <details class="st-acc">
          <summary><div><div>💪 Volume This Week</div><div class="st-acc-sub">Sets done vs planned by muscle</div></div></summary>
          <div class="st-acc-inner">
        ${(()=>{
          const vdata=buildVolumeData();
          if(!vdata.length)return`<div style="font-size:12px;color:var(--dim);padding:0 2px">No exercises planned this week.</div>`;
          return`<div style="background:var(--s2);border:1px solid var(--b1);border-radius:12px;padding:14px 16px;">`+
            `<div style="font-size:10px;color:var(--dim);margin-bottom:8px;letter-spacing:0.5px">SETS DONE / PLANNED</div>`+
            vdata.map(({muscle,planned,done})=>{
              const pct=planned?Math.min(100,Math.round(done/planned*100)):0;
              const full=planned&&done>=planned;
              return`<div class="vol-row"><div class="vol-muscle">${esc(muscle)}</div><div class="vol-bar-wrap"><div class="vol-bar" style="width:${pct}%${full?";background:var(--green)":""}"></div></div><div class="vol-count">${done}/${planned}</div></div>`;
            }).join("")+`</div>`;
        })()}
          </div>
        </details>
      </div>
    </details>

    <!-- Group 2: Progress -->
    <details class="st-acc" open>
      <summary><div><div>📊 Progress</div><div class="st-acc-sub">Weekly deficit · review</div></div></summary>
      <div class="st-acc-inner">
        <div class="st-sec">Weekly Calorie Deficit</div>
    ${(()=>{
      const todayIso=isoToday();
      const now=new Date();
      const dow=now.getDay();
      const mondayOffset=dow===0?-6:1-dow;
      const monday=new Date(now);
      monday.setDate(now.getDate()+mondayOffset);
      const DAY_NAMES=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
      // Weekly target: background deficit verification. In a phase, each day's
      // expected deficit comes from phaseDayDeficit() (workout vs Sunday) and
      // the weekly target is their sum; outside a phase, the date-driven
      // fallback with the 6.5-share heuristic applies.
      const lw=latestWeightLog()||USER.weightKg;
      const daysLeft=Math.max(1,Math.ceil((USER.goalDate-Date.now())/86400000));
      const dailyReq=requiredDeficit(lw,daysLeft);
      const mondayIso=isoDate(monday);
      const weekPhase=phaseFor(mondayIso)||phaseFor(todayIso);
      const dayShare=i=>{const iso=addDaysIso(mondayIso,i);return weekPhase?phaseDayDeficit(weekPhase,iso):(i===6?dailyReq*0.5:dailyReq);};
      const WEEKLY_TARGET=Math.round([0,1,2,3,4,5,6].reduce((s,i)=>s+dayShare(i),0));
      let runningTotal=0;
      let rows="";
      let loggedDays=0;
      let daysElapsed=0;
      let elapsedShare=0; // expected-deficit share of elapsed days
      for(let i=0;i<7;i++){
        const d=new Date(monday);
        d.setDate(monday.getDate()+i);
        const iso=isoDate(d);
        if(iso>todayIso)break;
        daysElapsed++;
        elapsedShare+=dayShare(i);
        const nutDay=S.nutrition?.days?.[iso]||{};
        const items=nutDay.items||[];
        const consumed=items.reduce((s,it)=>s+(it.kcal||0),0);
        if(!consumed){
          const isSun=i===6;
          rows+=`<div class="wdef-row"><span class="wdef-day">${DAY_NAMES[i]}${isSun?' <span style="font-size:9px;color:var(--dim)">(rest day)</span>':''} <span style="font-size:10px;color:var(--dim)">${d.getDate()} ${d.toLocaleString("default",{month:"short"})}</span></span><span style="color:var(--dim);font-size:12px">not logged</span></div>`;
          continue;
        }
        const resting=restingFor(iso,nutDay);
        const active=nutDay.active||0;
        const burn=resting+Math.round(active*ACTIVE_MULT);
        const deficit=burn-consumed;
        runningTotal+=deficit;
        loggedDays++;
        const isSun=i===6;
        const sign=deficit>=0?"":"+";
        const col=deficit>=0?"var(--green)":"var(--red)";
        rows+=`<div class="wdef-row"><span class="wdef-day">${DAY_NAMES[i]} <span style="font-size:10px;color:var(--dim)">${d.getDate()} ${d.toLocaleString("default",{month:"short"})}</span></span><span style="color:${col};font-weight:600">${sign}${deficit>=0?"-":""}${Math.abs(deficit).toLocaleString()} kcal</span></div>`;
      }
      if(!loggedDays)return`<div class="export-card"><div class="export-sub" style="color:var(--dim)">No nutrition data logged this week yet.</div></div>`;
      const adjusted=runningTotal;
      // Pace-based status: pro-rate by each elapsed day's expected-deficit
      // share (phase-aware; Sunday naturally carries a smaller share).
      const paceTarget=Math.round(elapsedShare);
      const pace=paceTarget?adjusted/paceTarget:0;
      const totalCol=pace>=1?"var(--green)":pace>=0.95?"var(--amber)":"var(--red)";
      const statusTxt=pace>=1.05?"Ahead of pace ✓":pace>=0.95?"On pace":"Behind pace";
      const pctBar=Math.min(100,Math.round((adjusted/WEEKLY_TARGET)*100));
      const barCol=totalCol;
      return`<div class="export-card">
        ${rows}
        <div style="border-top:1px solid var(--b1);margin-top:10px;padding-top:10px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <span style="font-size:11px;font-weight:700;letter-spacing:1px;color:var(--dim);text-transform:uppercase">Week total <span style="font-weight:400">(active ×${ACTIVE_MULT})</span></span>
            <span style="font-size:22px;font-weight:700;color:${totalCol}">${runningTotal.toLocaleString()} kcal</span>
          </div>
          <div class="prog-bar-wrap" style="margin-bottom:6px"><div class="prog-bar-fill" style="width:${pctBar}%;background:${barCol}"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:11px">
            <span style="color:${totalCol};font-weight:600">${statusTxt} <span style="font-weight:400;color:var(--dim)">· day ${daysElapsed} pace ${paceTarget.toLocaleString()}</span></span>
            <span style="color:var(--dim)">week ${WEEKLY_TARGET.toLocaleString()} kcal</span>
          </div>
        </div>
        ${loggedDays<daysElapsed?`<div style="font-size:11px;color:var(--amber);margin-top:8px;text-align:right">⚠ ${loggedDays} of ${daysElapsed} days logged · total may be optimistic</div>`:`<div style="font-size:11px;color:var(--dim);margin-top:8px;text-align:right">All ${daysElapsed} day${daysElapsed!==1?"s":""} logged ✓</div>`}
      </div>`;
    })()}

        <div class="st-sec">Weekly Review</div>
        ${buildWeeklyReviewCard()}
      </div>
    </details>

    <!-- Group 3: App (appearance + data) -->
    <details class="st-acc" open>
      <summary><div><div>⚙️ App</div><div class="st-acc-sub">Theme · sync · backup</div></div></summary>
      <div class="st-acc-inner">
        <div class="st-sec">Appearance</div>
        <div class="st-group">
          <div class="st-row" onclick="toggleTheme()"><div class="st-icon">${S.theme==="light"?"☀️":S.theme==="dark"?"🌙":"🌗"}</div><div class="st-info"><div class="st-ttl">Theme</div><div class="st-sub">${S.theme==="light"?"Light · tap for dark":S.theme==="dark"?"Dark · tap for auto":"Auto · follows your device · tap for light"}</div></div></div>
          <div class="st-row" onclick="scanDemos()"><div class="st-icon">🎬</div><div class="st-info"><div class="st-ttl">Demo Clips</div><div class="st-sub" id="demoScanSub">${(()=>{const n=Object.keys(S.demoCache||{}).length;return n?n+" clips found · tap to rescan":"Finds exercise demo videos · takes ~1 min"})()}</div></div></div>
        </div>
        ${(()=>{const snaps=listSnapshots();if(!snaps.length)return"";return `<details class="st-subacc">
          <summary><div><div>⏪ Undo Sync</div><div class="st-subacc-note">${snaps.length} recent sync${snaps.length!==1?"s":""} · tap to view</div></div></summary>
          <div class="st-subacc-inner"><div class="st-group">${snaps.map(s=>`<div class="st-row" onclick="restoreSnapshot(${s.ts})"><div class="st-icon">⏪</div><div class="st-info"><div class="st-ttl">${new Date(s.ts).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div><div class="st-sub">Restore this device's data from before that sync · ~${s.weight} entries</div></div></div>`).join("")}</div></div>
        </details>`;})()}

        <details class="st-subacc">
          <summary><div><div>🗄 Data</div><div class="st-subacc-note">Sync · backup · export · danger zone</div></div></summary>
          <div class="st-subacc-inner">

        <div class="st-sec">Sync &amp; Recovery</div>
        <div class="st-group">
          <div class="st-row" onclick="checkSyncNow()"><div class="st-icon">☁️</div><div class="st-info"><div class="st-ttl">Database Sync</div><div class="st-sub">${(()=>{const pending=getOutbox().length;if(ctx.syncAvailable===true)return pending?`${pending} change${pending!==1?"s":""} queued · tap to sync now`:`Synced${ctx.lastSyncAt?" · last "+new Date(ctx.lastSyncAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):""} · tap to check`;if(ctx.syncAvailable===false)return"Off · add DATABASE_URL to the Vercel project, then redeploy";return"Tap to check sync status";})()}</div></div></div>
          ${(()=>{const days=listDailyBackups();if(!days.length)return"";return `<div class="st-row" onclick="const l=document.getElementById('dailyBackupList');l.style.display=l.style.display==='none'?'block':'none'"><div class="st-icon">🗓</div><div class="st-info"><div class="st-ttl">Local Backups</div><div class="st-sub">${days.length} daily snapshot${days.length!==1?"s":""} on this device · tap to view</div></div></div><div id="dailyBackupList" class="st-group" style="display:none">${days.map(d=>`<div class="st-row" onclick="restoreDailyBackup('${d}')"><div class="st-icon">📅</div><div class="st-info"><div class="st-ttl">${d}</div><div class="st-sub">Tap to restore this day's local snapshot</div></div></div>`).join("")}</div>`;})()}
        </div>

        <div class="st-sec">Backup &amp; Export</div>
        <div class="st-group">
          ${(!S._lastBackup||Date.now()-S._lastBackup>14*86400000)?`<div class="st-row" style="cursor:default"><div class="st-icon">⚠️</div><div class="st-info"><div class="st-ttl" style="color:var(--amber)">No recent manual backup</div><div class="st-sub">Local snapshots protect against sync bugs, but not device loss · download a copy below</div></div></div>`:""}
          <div class="st-row" onclick="exportBackup()"><div class="st-icon">💾</div><div class="st-info"><div class="st-ttl">Export Backup</div><div class="st-sub">Download sessions, nutrition, weights as JSON${S._lastBackup?` · last ${new Date(S._lastBackup).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`:""}</div></div></div>
          <div class="st-row" onclick="showExportSheet()"><div class="st-icon">📧</div><div class="st-info"><div class="st-ttl"><button id="emailExportBtn" style="background:none;border:none;padding:0;font:inherit;color:inherit;cursor:pointer">Email My Data</button></div><div class="st-sub">CSV to inbox · or open beautiful PDF report</div></div></div>
          <div class="st-row" onclick="document.getElementById('importFile').click()"><div class="st-icon">📥</div><div class="st-info"><div class="st-ttl">Import Backup</div><div class="st-sub">Restore from a previously exported file</div></div></div>
          <input type="file" id="importFile" accept=".json,application/json" style="display:none" onchange="importBackup(this)">
          <div class="st-row" onclick="copyExp()"><div class="st-icon">📋</div><div class="st-info"><div class="st-ttl">Copy Last 3 Months</div><div class="st-sub">Session history to clipboard · paste into Claude</div></div></div>
        </div>

        ${!window.FORGE_API_CFG?`<div class="st-sec">Session</div>
        <div class="st-group">
          <div class="st-row" onclick="lockApp()"><div class="st-icon">🔒</div><div class="st-info"><div class="st-ttl">Lock App</div><div class="st-sub">Sign out and require access token</div></div></div>
        </div>`:""}

        <div class="danger-zone">
          <div class="st-sec">Danger Zone</div>
          <div class="st-group">
            <div class="st-row" onclick="clearD()"><div class="st-icon">🗑</div><div class="st-info"><div class="st-ttl" style="color:var(--red)">Clear All Data</div><div class="st-sub">Permanently wipe everything · device and database</div></div></div>
          </div>
        </div>

          </div>
        </details>
      </div>
    </details>

    <div style="height:20px"></div>
  </div>`;
}
ctx.renderST=renderST;

// ── WEEKLY REVIEW ──
function weekStats(){
  // Count sessions via trainedOn() — avoids fragile key-lookup mismatch
  const now=new Date(),dow=now.getDay(),monday=new Date(now);monday.setDate(now.getDate()+(dow===0?-6:1-dow));
  let sessions=0,setsDone=0;
  for(let i=0;i<7;i++){
    const d=new Date(monday);d.setDate(monday.getDate()+i);
    const iso=isoDate(d);if(iso>isoToday())break;
    if(trainedOn(iso))sessions++;
  }
  // Sets done: scan all session keys that fall within this week
  const cur=wk();
  for(const day of DAYS){
    const sess=S.sessions[day+"_"+cur];if(!sess)continue;
    setsDone+=Object.values(sess).filter(e=>e&&typeof e==="object").reduce((a,e)=>a+((e.sets||[]).filter(s=>s.done).length),0);
  }
  const ws=S.nutrition.weights||{};const keys=Object.keys(ws).sort();
  let wtChange=null;
  if(keys.length>=2){
    const last=keys[keys.length-1];
    const ref=keys.filter(k=>k<=new Date(new Date(last).getTime()-5*86400000).toISOString().slice(0,10)).pop()||keys[0];
    if(ref!==last)wtChange={from:ws[ref],to:ws[last],delta:+(ws[last]-ws[ref]).toFixed(1)};
  }
  let defTotal=0,defDays=0;
  for(let i=0;i<7;i++){
    const d=new Date(monday);d.setDate(monday.getDate()+i);
    const iso=isoDate(d);if(iso>isoToday())break;
    const nd=S.nutrition.days?.[iso];if(!nd)continue;
    const consumed=(nd.items||[]).reduce((s,it)=>s+(it.kcal||0),0);if(!consumed)continue;
    const bmr=calcBMR(latestWeightLog()||USER.weightKg);
    defTotal+=(nd.restingOverride!=null?nd.restingOverride:bmr)+Math.round((nd.active||0)*ACTIVE_MULT)-consumed;defDays++;
  }
  return{sessions,setsDone,wtChange,avgDeficit:defDays?Math.round(defTotal/defDays):null,defDays};
}
function buildWeeklyReviewCard(){
  const st=weekStats();
  const isSunday=new Date().getDay()===0;
  const verdict=S.nutrition.weeklyVerdict&&S.nutrition.weeklyVerdict.week===wk()?S.nutrition.weeklyVerdict.text:null;
  const wtHtml=st.wtChange?`${st.wtChange.delta<=0?"":"+"}${st.wtChange.delta} kg <span style="font-size:10px;color:var(--dim)">(${st.wtChange.from}→${st.wtChange.to})</span>`:"-";
  const wtCol=st.wtChange?(st.wtChange.delta<0?"var(--green)":"var(--red)"):"var(--dim)";
  return`<div class="export-card"${isSunday?' style="border-left-color:var(--green)"':""}>
    ${isSunday?`<div style="font-size:11px;font-weight:700;color:var(--green);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">🗓 Sunday review time</div>`:""}
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
      <div style="text-align:center"><div style="font-size:20px;font-weight:700">${st.sessions}</div><div style="font-size:9px;color:var(--dim);letter-spacing:1px;text-transform:uppercase">Sessions</div></div>
      <div style="text-align:center"><div style="font-size:20px;font-weight:700;color:${wtCol}">${wtHtml}</div><div style="font-size:9px;color:var(--dim);letter-spacing:1px;text-transform:uppercase">Weight</div></div>
      <div style="text-align:center"><div style="font-size:20px;font-weight:700">${st.avgDeficit!=null?st.avgDeficit.toLocaleString():"-"}</div><div style="font-size:9px;color:var(--dim);letter-spacing:1px;text-transform:uppercase">Avg deficit</div></div>
    </div>
    <div style="font-size:12px;color:var(--mid);margin-bottom:10px">${arrivalEst()}</div>
    ${verdict?`<div class="weekly-note" style="margin-bottom:10px"><div class="weekly-note-title">Coach's Verdict</div>${mdLite(verdict)}</div>`:""}
    <button class="btn-o" id="wkRevBtn" onclick="aiWeeklyReview()">${verdict?"Regenerate Verdict":"Get AI Verdict · Am I on track?"}</button>
  </div>`;
}
async function aiWeeklyReview(){
  const btn=document.getElementById("wkRevBtn");
  if(btn){btn.disabled=true;btn.innerHTML='<span class="spin"></span>Analysing...';}
  // Build rich prompt (same data as checkMondayAudit)
  const days=Object.entries(S.nutrition.days||{}).sort(([a],[b])=>a.localeCompare(b)).slice(-7);
  let totalKcal=0,totalProtein=0,totalFibre=0,totalActive=0,totalBurn=0,totalDeficit=0,loggedDays=0;
  const DAY_LABELS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const foodLines=[];
  for(const [iso,d] of days){
    const consumed=(d.items||[]).reduce((s,it)=>s+(it.kcal||0),0);if(!consumed)continue;
    const bmr=calcBMR(latestWeightLog()||USER.weightKg);
    const resting=d.restingOverride!=null?d.restingOverride:bmr;
    const burn=resting+Math.round((d.active||0)*ACTIVE_MULT);
    totalKcal+=consumed;totalProtein+=(d.items||[]).reduce((s,it)=>s+(it.protein||0),0);
    totalFibre+=(d.items||[]).reduce((s,it)=>s+(it.fibre||0),0);
    totalActive+=(d.active||0);totalBurn+=burn;totalDeficit+=burn-consumed;loggedDays++;
    const label=DAY_LABELS[new Date(iso+"T12:00:00").getDay()]+" "+iso.slice(5);
    for(const it of (d.items||[])){foodLines.push(`${label}: ${it.name} (${it.kcal} kcal, ${it.protein||0}g P)`);}
  }
  const avgKcal=loggedDays?Math.round(totalKcal/loggedDays):0;
  const avgProtein=loggedDays?Math.round(totalProtein/loggedDays):0;
  const avgFibre=loggedDays?Math.round(totalFibre/loggedDays):0;
  const avgActive=loggedDays?Math.round(totalActive/loggedDays):0;
  const avgBurn=loggedDays?Math.round(totalBurn/loggedDays):0;
  const avgDeficit=loggedDays?Math.round(totalDeficit/loggedDays):0;
  const today=isoToday();let sessCount=0;
  for(let i=0;i<7;i++){const d=new Date(today+"T12:00:00");d.setDate(d.getDate()-i);if(trainedOn(isoDate(d)))sessCount++;}
  const wtEntries=days.length?Object.entries(S.nutrition.weights||{}).filter(([k])=>k>=days[0][0]).sort(([a],[b])=>a.localeCompare(b)):[];
  let wtLine="No weight logged this week";
  if(wtEntries.length>=2){const[d0,w0]=wtEntries[0],[d1,w1]=wtEntries[wtEntries.length-1];const delta=(+w1-+w0).toFixed(1);wtLine=`${w0}kg (${d0}) → ${w1}kg (${d1}), change: ${delta>0?"+":""}${delta}kg`;}
  else if(wtEntries.length===1){wtLine=`${wtEntries[0][1]}kg (${wtEntries[0][0]}), only one weigh-in`;}
  const lw=latestWeightLog()||USER.weightKg;
  const daysLeft=Math.max(1,Math.ceil((USER.goalDate-Date.now())/86400000));
  const _wp=phaseFor(isoToday());
  const req=_wp?phaseDayDeficit(_wp,isoToday()):requiredDeficit(lw,daysLeft);
  const prompt=`Weekly summary (last 7 days):\nWorkouts: ${sessCount} sessions\nAvg intake: ${avgKcal} kcal/day | Avg protein: ${avgProtein}g | Avg fibre: ${avgFibre}g\nAvg active burn: ${avgActive} kcal | Avg total burn: ${avgBurn} kcal | Avg deficit: ${avgDeficit} kcal/day\nRequired deficit to hit goal: ${req} kcal/day\nWeight: ${wtLine}\nCurrent: ${lw}kg → Target: ${USER.targetKg}kg | ${daysLeft} days left\n\nFood log (last 7 days):\n${foodLines.slice(0,60).join("\n")}\n\nAssess in 4-5 sentences: (1) is the actual deficit on track vs the required ${req} kcal/day? (2) given the deficit numbers, explain whether the weight change is water retention (assume this first — glycogen, sodium, hormonal shifts are common causes, especially with training) or genuine fat gain; do NOT question logging accuracy. (3) workout consistency. (4) one food habit observation from the log. (5) one specific action for next week. Cite actual numbers. Plain text only.`;
  try{
    const r=await fetch(API_CFG.baseUrl+"/api/coach",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},body:JSON.stringify({prompt})});
    const d=await r.json();
    if(!r.ok||!d.text)throw new Error(d.error||"failed");
    S.nutrition.weeklyVerdict={week:wk(),text:d.text};
    save();queueSettings();renderST();
  }catch(e){
    showToast("AI unavailable · try again");
    if(btn){btn.disabled=false;btn.textContent="Regenerate Verdict";}
  }
}

// ── CSV / EMAIL EXPORT ──
function buildFullCSV(){
  const exMap={};
  [...Object.values(PROG_V1),...Object.values(PROG_V2)].forEach(p=>(p.exercises||[]).forEach(e=>{exMap[e.id]=e.name;}));
  Object.values(S.custom||{}).forEach(arr=>{if(Array.isArray(arr))arr.forEach(e=>{if(e.id&&e.name)exMap[e.id]=e.name;});});
  const exName=id=>exMap[id]||_prNameMap[id]||id;
  function weekKeyToDate(dayName,weekKey){
    const m=weekKey.match(/(\d{4})W(\d+)/);
    if(!m)return "";
    const [,yr,wk]=m;
    const jan4=new Date(Date.UTC(Number(yr),0,4));
    const mon=new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate()-((jan4.getUTCDay()+6)%7)+(Number(wk)-1)*7);
    const idx=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].indexOf(dayName);
    if(idx<0)return "";
    mon.setUTCDate(mon.getUTCDate()+idx);
    return mon.toISOString().slice(0,10);
  }
  const rows=[];
  rows.push("WORKOUTS","Date,Exercise,Set,Weight(kg),Reps");
  for(const [dayKey,sessMap] of Object.entries(S.sessions||{})){
    const [dayName,...rest]=dayKey.split("_");
    const date=weekKeyToDate(dayName,rest.join("_"));
    for(const [exId,ed] of Object.entries(sessMap)){
      if(!ed||!ed.sets)continue;
      const name=exName(exId);
      ed.sets.forEach((s,i)=>{if(s.weight||s.reps)rows.push(`${date},${name},${i+1},${s.weight||""},${s.reps||""}`);});
    }
  }
  rows.push("");
  rows.push("NUTRITION","Date,Item,kcal,Protein(g),Carbs(g),Fat(g),Fibre(g),Sugar(g),Sodium(mg)");
  for(const [date,day] of Object.entries(S.nutrition?.days||{})){
    for(const item of (day.items||[])){
      rows.push(`${date},${String(item.name||"").replace(/,/g," ")},${item.kcal||0},${item.protein||0},${item.carbs||0},${item.fat||0},${item.fibre||0},${item.sugar||0},${item.sodium||0}`);
    }
  }
  rows.push("");
  rows.push("WEIGHT","Date,Weight(kg)");
  for(const [date,kg] of Object.entries(S.nutrition?.weights||{}).sort())rows.push(`${date},${kg}`);
  rows.push("");
  rows.push("SESSION NOTES & CALF TWINGES","Date,Day,Twinges,Notes");
  for(const [dayKey,sessMap] of Object.entries(S.sessions||{})){
    const twinges=(sessMap._calfTwinges||[]).filter(ts=>Number.isFinite(ts)).length;
    const notes=sessMap._notes||"";
    if(!twinges&&!notes)continue;
    const [dayName,...rest]=dayKey.split("_");
    const date=weekKeyToDate(dayName,rest.join("_"));
    rows.push(`${date},${dayName},${twinges},"${notes.replace(/"/g,'""')}"`);
  }
  rows.push("");
  rows.push("PERSONAL RECORDS","Exercise,Weight(kg),Reps,Est1RM(kg),Date");
  for(const [exId,entries] of Object.entries(S.prs||{})){
    for(const e of entries)rows.push(`${exName(exId)},${e.weight},${e.reps},${e.est},${e.date}`);
  }
  return rows.join("\n");
}
function showExportSheet(){
  const el=document.getElementById("exportSheet");
  if(el){el.classList.add("open");return;}
  const sheet=document.createElement("div");
  sheet.id="exportSheet";
  sheet.className="export-sheet";
  sheet.innerHTML=`
    <div class="export-sheet-inner">
      <div class="export-sheet-title">Export My Data</div>
      <button class="export-opt" onclick="emailCSV()">📄 Email CSV<span class="export-opt-sub">All data as spreadsheet · opens in Google Sheets</span></button>
      <button class="export-opt" onclick="openPDFReport()">📊 View PDF Report<span class="export-opt-sub">Beautiful report with charts · print or save as PDF</span></button>
      <button class="export-cancel" onclick="document.getElementById('exportSheet').classList.remove('open')">Cancel</button>
    </div>`;
  document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add("open"));
  sheet.addEventListener("click",e=>{if(e.target===sheet)sheet.classList.remove("open");});
}
async function emailCSV(){
  document.getElementById("exportSheet")?.classList.remove("open");
  const btn=document.getElementById("emailExportBtn");
  if(btn){btn.disabled=true;btn.textContent="Sending…";}
  try{
    const csv=buildFullCSV();
    const res=await fetch(API_CFG.baseUrl+"/api/email",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},
      body:JSON.stringify({filename:`forge-export-${isoToday()}.csv`,content:btoa(unescape(encodeURIComponent(csv)))})
    });
    if(res.ok)showToast("CSV emailed to you 📧");
    else showToast("Email failed — use backup download");
  }catch(e){showToast("Email failed — use backup download");}
  finally{if(btn){btn.disabled=false;btn.textContent="Email My Data";}}
}
function buildSVGBarChart(title,data,getVal,getCol,legend,pTarget){
  const vals=data.map(getVal);
  const nonNull=vals.filter(v=>v!=null&&v!==0).map(v=>Math.abs(v));
  if(!nonNull.length)nonNull.push(1);
  const hi=Math.max(...nonNull);
  const significant=nonNull.filter(v=>v>hi*0.4);
  const lo=significant.length?Math.min(...significant):0;
  const spread=hi-lo;
  const floor=Math.max(0,lo-spread*1.2);
  const range=hi-floor||1;
  const W=280,H=90,barW=28,gap=12,padL=10;
  const bars=data.map((d,i)=>{
    const v=vals[i];
    const barH=v==null?0:Math.max(3,Math.round((Math.abs(v)-floor)/range*(H-30)));
    const x=padL+i*(barW+gap);
    const y=H-14-barH;
    const col=getCol(d,v);
    const colMap={"var(--green)":"#178A43","var(--orange)":"#55700B","var(--red)":"#D6453A","var(--b2)":"#D5D5DB"};
    const fill=colMap[col]||col;
    const lbl=d.lbl;
    const valLbl=v==null?"":Math.round(Math.abs(v));
    return`<g><rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${fill}" opacity="${d.isToday?1:0.75}"/>
      <text x="${x+barW/2}" y="${y-3}" text-anchor="middle" font-size="8" fill="#9ca3af">${valLbl}</text>
      <text x="${x+barW/2}" y="${H-2}" text-anchor="middle" font-size="9" fill="${d.isToday?"#55700B":"#6b7280"}" font-weight="${d.isToday?"700":"400"}">${lbl}</text></g>`;
  }).join("");
  const legendHtml=legend?`<text x="${W/2}" y="${H+10}" text-anchor="middle" font-size="8" fill="#6b7280">${legend.replace(/<[^>]+>/g,"")}</text>`:"";
  return`<div class="pdf-chart"><div class="pdf-chart-title">${title}</div><svg viewBox="0 0 ${W} ${H+14}" width="100%" style="max-height:100px">${bars}${legendHtml}</svg></div>`;
}
function buildSVGMacrosChart(t){
  // Table: rows = macros, cols = days
  const days=t.map(d=>({lbl:d.lbl,iso:d.iso.slice(5),p:Math.round(d.protein||0),c:Math.round(d.carbs||0),f:Math.round(d.fat||0),today:d.isToday}));
  const cols=days.map(d=>`<th style="text-align:center;padding:5px 6px;font-size:10px;background:#f3f4f6;color:${d.today?"#55700B":"#6b7280"};font-weight:${d.today?"700":"500"}">${d.lbl}<br><span style="font-weight:400;font-size:9px">${d.iso}</span></th>`).join("");
  const pRow=days.map(d=>`<td style="text-align:center;padding:5px 6px;color:#2E6FD8;font-weight:600">${d.p||"—"}</td>`).join("");
  const cRow=days.map(d=>`<td style="text-align:center;padding:5px 6px;color:#B8720E;font-weight:600">${d.c||"—"}</td>`).join("");
  const fRow=days.map(d=>`<td style="text-align:center;padding:5px 6px;color:#178A43;font-weight:600">${d.f||"—"}</td>`).join("");
  return`<div class="pdf-chart pdf-chart-full" style="grid-column:1/-1"><div class="pdf-chart-title">Daily Macros (grams)</div>
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr><th style="text-align:left;padding:5px 6px;background:#f3f4f6;font-size:10px;color:#6b7280"></th>${cols}</tr></thead>
      <tbody>
        <tr><td style="padding:5px 6px;font-size:10px;color:#2E6FD8;font-weight:700">● Protein</td>${pRow}</tr>
        <tr style="background:#fafafa"><td style="padding:5px 6px;font-size:10px;color:#B8720E;font-weight:700">● Carbs</td>${cRow}</tr>
        <tr><td style="padding:5px 6px;font-size:10px;color:#178A43;font-weight:700">● Fat</td>${fRow}</tr>
      </tbody>
    </table>
  </div>`;
}
function buildSVGSparkline(keys,wts){
  if(keys.length<2)return`<div class="pdf-chart"><div class="pdf-chart-title">Weight · 30 days</div><p style="color:#6b7280;font-size:12px">Need at least 2 weigh-ins.</p></div>`;
  const vals=keys.map(k=>wts[k]);
  const mn=Math.min(...vals),mx=Math.max(...vals),range=mx-mn||1;
  const W=320,H=70,pad=8;
  const pts=vals.map((v,i)=>{const x=pad+(i/(vals.length-1))*(W-pad*2);const y=H-pad-((v-mn)/range)*(H-pad*2);return[x.toFixed(1),y.toFixed(1)];});
  let tLine="";
  if(USER.targetKg>=mn&&USER.targetKg<=mx){const ty=(H-pad-((USER.targetKg-mn)/range)*(H-pad*2)).toFixed(1);tLine=`<line x1="${pad}" y1="${ty}" x2="${W-pad}" y2="${ty}" stroke="#22c55e" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/><text x="${W-pad-2}" y="${Number(ty)-3}" text-anchor="end" font-size="8" fill="#22c55e">goal ${USER.targetKg}kg</text>`;}
  const polyPts=pts.map(p=>p.join(",")).join(" ");
  const circles=pts.map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="${i===pts.length-1?4:2.5}" fill="#55700B"/>`).join("");
  // start/end labels
  const startLbl=`<text x="${pad}" y="${H+10}" font-size="8" fill="#9ca3af">${keys[0].slice(5)} ${vals[0]}kg</text>`;
  const endLbl=`<text x="${W-pad}" y="${H+10}" text-anchor="end" font-size="8" fill="#55700B" font-weight="700">${keys[keys.length-1].slice(5)} ${vals[vals.length-1]}kg</text>`;
  const days=(new Date(keys[keys.length-1]+"T12:00:00")-new Date(keys[0]+"T12:00:00"))/86400000;
  const delta=vals[vals.length-1]-vals[0];
  const trend=days>=14?`${delta<=0?"▼":"▲"} ${Math.abs(delta).toFixed(1)}kg over ${Math.round(days)} days`:`${Math.round(days)} days logged`;
  return`<div class="pdf-chart"><div class="pdf-chart-title">Weight · 30 days <span style="color:${delta<=0?"#178A43":"#D6453A"};font-size:11px;font-weight:600">${trend}</span></div><svg viewBox="0 0 ${W} ${H+14}" width="100%" style="max-height:90px">${tLine}<polyline points="${polyPts}" fill="none" stroke="#55700B" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${circles}${startLbl}${endLbl}</svg></div>`;
}
function buildPDFReport(){
  const t=buildTrendData().map(d=>{
    const items=(S.nutrition?.days?.[d.iso]||{}).items||[];
    return {...d,carbs:items.reduce((s,it)=>s+(it.carbs||0),0),fat:items.reduce((s,it)=>s+(it.fat||0),0)};
  });
  const pTarget=Math.round(USER.targetKg*2);
  const lw=latestWeightLog()||USER.weightKg;
  const streak=(()=>{let n=0;for(let i=0;i<365;i++){const d=new Date(isoToday()+"T12:00:00");d.setDate(d.getDate()-i);if(trainedOn(isoDate(d)))n++;else break;}return n;})();
  const wts=S.nutrition?.weights||{};
  const wtKeys=Object.keys(wts).sort().slice(-30);
  // Weekly sessions count
  const now=new Date(),mon=new Date(now);mon.setDate(now.getDate()-((now.getDay()+6)%7));
  let weeklySessions=0;for(let i=0;i<7;i++){const d=new Date(mon);d.setDate(mon.getDate()+i);if(isoDate(d)<=isoToday()&&trainedOn(isoDate(d)))weeklySessions++;}
  // PRs
  const exMap={};
  [...Object.values(PROG_V1),...Object.values(PROG_V2)].forEach(p=>(p.exercises||[]).forEach(e=>{exMap[e.id]=e.name;}));
  Object.values(S.custom||{}).forEach(arr=>{if(Array.isArray(arr))arr.forEach(e=>{if(e.id&&e.name)exMap[e.id]=e.name;});});
  const exName=id=>exMap[id]||_prNameMap[id]||id;
  const prRows=Object.entries(S.prs||{}).map(([id,entries])=>{
    const best=entries.reduce((b,e)=>e.est>b.est?e:b,entries[0]);
    return`<tr><td>${esc(exName(id))}</td><td>${best.est}kg est. 1RM</td><td>${best.weight}kg × ${best.reps}</td><td>${best.date}</td></tr>`;
  }).join("");
  // Recent workouts + notes + calf twinges (last 14 sessions)
  const recentSessions=Object.entries(S.sessions||{}).sort(([a],[b])=>b.localeCompare(a)).slice(0,14);
  function sessDate(dayKey){
    const [dayName,...rest]=dayKey.split("_");
    const wkMatch=rest.join("_").match(/(\d{4})W(\d+)/);
    if(!wkMatch)return"";
    const[,yr,wk]=wkMatch;const jan4=new Date(Date.UTC(Number(yr),0,4));const mon=new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate()-((jan4.getUTCDay()+6)%7)+(Number(wk)-1)*7);
    const idx=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].indexOf(dayName);
    if(idx<0)return"";mon.setUTCDate(mon.getUTCDate()+idx);return mon.toISOString().slice(0,10);
  }
  const workoutRows=recentSessions.flatMap(([dayKey,sessMap])=>{
    const date=sessDate(dayKey);
    return Object.entries(sessMap).filter(([k,ed])=>k[0]!=="_"&&ed?.sets?.some(s=>s.done)).map(([exId,ed])=>{
      const doneSets=ed.sets.filter(s=>s.done);
      const maxW=Math.max(...doneSets.map(s=>s.weight||0));
      return`<tr><td>${date}</td><td>${esc(exName(exId))}</td><td>${doneSets.length} sets</td><td>${maxW>0?maxW+"kg":"—"}</td></tr>`;
    });
  }).join("");
  // Session notes and calf twinges
  const sessionLogRows=recentSessions.filter(([,sessMap])=>sessMap._notes||(sessMap._calfTwinges||[]).length>0).map(([dayKey,sessMap])=>{
    const date=sessDate(dayKey);
    const twinges=(sessMap._calfTwinges||[]).filter(ts=>Number.isFinite(ts)).length;
    const notes=sessMap._notes||"";
    const twingeBadge=twinges>0?`<span style="display:inline-block;background:#fff7ed;color:#ea580c;border:1px solid #fed7aa;border-radius:4px;padding:1px 7px;font-size:11px;font-weight:600;margin-right:6px">⚡ ${twinges} calf twinge${twinges!==1?"s":""}</span>`:"";
    return`<tr><td style="white-space:nowrap">${date}</td><td>${twingeBadge}${notes?`<span style="color:#374151">${esc(notes)}</span>`:""}</td></tr>`;
  }).join("");

  const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>FORGE Report · ${isoToday()}</title><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fff;color:#111;padding:32px;max-width:800px;margin:0 auto;}
    .header{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #55700B;padding-bottom:16px;margin-bottom:24px;}
    .header-title{font-size:28px;font-weight:900;letter-spacing:-1px;color:#55700B;}
    .header-sub{font-size:13px;color:#6b7280;}
    .stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;}
    .stat-box{background:#f9fafb;border-radius:10px;padding:14px;text-align:center;}
    .stat-val{font-size:24px;font-weight:800;color:#111;}
    .stat-lbl{font-size:10px;color:#6b7280;margin-top:2px;text-transform:uppercase;letter-spacing:.5px;}
    .section{margin-bottom:28px;}
    .section-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#6b7280;border-bottom:1px solid #e5e7eb;padding-bottom:6px;margin-bottom:14px;}
    .charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .pdf-chart{background:#f9fafb;border-radius:10px;padding:14px;}
    .pdf-chart-title{font-size:11px;font-weight:600;color:#374151;margin-bottom:8px;}
    .pdf-chart-full{grid-column:1/-1;}
    table{width:100%;border-collapse:collapse;font-size:12px;}
    th{text-align:left;padding:7px 10px;background:#f3f4f6;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;}
    td{padding:7px 10px;border-bottom:1px solid #f3f4f6;color:#374151;}
    tr:last-child td{border-bottom:none;}
    .badge{display:inline-block;background:#EDF4D3;color:#55700B;border:1px solid #C9DC8A;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600;}
    @media print{body{padding:16px;}@page{margin:16mm;}}
  </style></head><body>
    <div class="header">
      <div><div class="header-title">⚡ FORGE</div><div class="header-sub">Weekly Report · ${new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</div></div>
      <div style="text-align:right"><div style="font-size:13px;font-weight:600">${esc(USER.targetKg?`Goal: ${USER.targetKg}kg`:"")}</div><div style="font-size:12px;color:#6b7280">Current: ${lw}kg</div></div>
    </div>
    <div class="stats-row">
      <div class="stat-box"><div class="stat-val" style="color:#55700B">🔥 ${streak}</div><div class="stat-lbl">Day Streak</div></div>
      <div class="stat-box"><div class="stat-val">${weeklySessions}</div><div class="stat-lbl">Sessions This Week</div></div>
      <div class="stat-box"><div class="stat-val">${lw}kg</div><div class="stat-lbl">Current Weight</div></div>
      <div class="stat-box"><div class="stat-val">${Object.keys(S.prs||{}).length}</div><div class="stat-lbl">Exercises PR'd</div></div>
    </div>
    <div class="section">
      <div class="section-title">7-Day Trends</div>
      <div class="charts-grid">
        ${buildSVGBarChart("Protein g/day",t,d=>d.protein,(d,v)=>v>=pTarget?"var(--green)":"var(--b2)",`target ${pTarget}g`)}
        ${buildSVGBarChart("Calorie Burn",t,d=>d.burn,d=>d.trained?"var(--orange)":"var(--b2)","orange = trained day")}
        ${buildSVGBarChart("Daily Deficit (kcal)",t,d=>d.deficit,(d,v)=>v==null?"var(--b2)":v>=0?"var(--green)":"var(--red)","green = deficit")}
        ${buildSVGMacrosChart(t)}
        <div class="pdf-chart">${buildSVGSparkline(wtKeys,wts).replace('<div class="pdf-chart">','').replace('</div>','')}</div>
      </div>
    </div>
    ${prRows?`<div class="section"><div class="section-title">Personal Records</div><table><thead><tr><th>Exercise</th><th>Est. 1RM</th><th>Best Set</th><th>Date</th></tr></thead><tbody>${prRows}</tbody></table></div>`:""}
    ${workoutRows?`<div class="section"><div class="section-title">Recent Workouts</div><table><thead><tr><th>Date</th><th>Exercise</th><th>Sets Done</th><th>Top Weight</th></tr></thead><tbody>${workoutRows}</tbody></table></div>`:""}
    ${sessionLogRows?`<div class="section"><div class="section-title">Session Notes &amp; Calf Twinges</div><table><thead><tr><th>Date</th><th>Notes</th></tr></thead><tbody>${sessionLogRows}</tbody></table></div>`:""}
    <div style="margin-top:32px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af;text-align:center">Generated by FORGE · ${new Date().toISOString()} · Print this page to save as PDF</div>
  </body></html>`;
  return html;
}
function openPDFReport(){
  document.getElementById("exportSheet")?.classList.remove("open");
  const html=buildPDFReport();
  const win=window.open("","_blank");
  if(win){win.document.write(html);win.document.close();setTimeout(()=>win.print(),800);}
  else showToast("Allow popups to open the report");
}

// ── BACKUP / RESTORE ──
function exportBackup(){
  S._lastBackup=Date.now();save();
  const payload={app:"FORGE",version:1,exportedAt:new Date().toISOString(),state:S};
  const blob=new Blob([JSON.stringify(payload,null,1)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;a.download="forge-backup-"+isoToday()+".json";
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
  showToast("Backup downloaded 💾");renderST();
}
function importBackup(input){
  const file=input.files&&input.files[0];
  input.value="";
  if(!file)return;
  const reader=new FileReader();
  reader.onload=()=>{
    let payload;
    try{payload=JSON.parse(reader.result);}catch{showToast("Not a valid backup file");return;}
    const state=payload&&payload.app==="FORGE"&&payload.state?payload.state:null;
    if(!state||typeof state!=="object"||!state.sessions){showToast("Not a FORGE backup file");return;}
    const sessCount=Object.keys(state.sessions||{}).length;
    const exported=payload.exportedAt?new Date(payload.exportedAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}):"unknown date";
    if(!confirm(`Restore backup from ${exported} (${sessCount} sessions)?\n\nThis REPLACES all current data on this device.`))return;
    S=state;save();queueMutation("restore_all",{state:S});
    showToast("Backup restored ✓");
    location.reload();
  };
  reader.onerror=()=>showToast("Could not read file");
  reader.readAsText(file);
}

function genExp(){
  const cutoff=new Date();cutoff.setDate(cutoff.getDate()-91);
  const lines=["=== FORGE EXPORT · Last 3 Months ===","Generated: "+new Date().toLocaleString(),"","SESSIONS:"];
  const sorted=Object.keys(S.sessions).sort();
  for(const key of sorted){
    const m=key.match(/_(\d{4})W(\d+)$/);
    if(m){const yr=+m[1],wn=+m[2],jan1=new Date(yr,0,1),dow=jan1.getDay()||7,mon=new Date(yr,0,1+(wn-1)*7-(dow-1));if(mon<cutoff)continue;}
    const data=S.sessions[key];
    const hasData=Object.values(data).some(e=>(e.sets||[]).some(s=>s.done)||e.done);
    if(!hasData)continue;
    lines.push("\n"+key+":");
    Object.entries(data).forEach(([id,ed])=>{
      const name=findN(id)||id;
      const sets=(ed.sets||[]).filter(s=>s.done).map(s=>`${s.weight||"-"}kg×${s.reps||"-"}`).join(", ");
      const skip=ed.skipped?"(skipped)":"";
      const card=ed.done&&!sets&&!skip?"(completed)":"";
      if(sets||skip||card)lines.push(`  ${name}: ${sets||skip||card}`);
    });
  }
  return lines.join("\n");
}

function copyExp(){
  const text=genExp();
  navigator.clipboard?.writeText(text)
    .then(()=>showToast("Copied · paste into Claude ✓"))
    .catch(()=>showToast("Copy failed · try again"));
}

function findN(id){
  for(const day of Object.values(PROG)){const ex=day.exercises?.find(e=>e.id===id);if(ex)return ex.name;}
  return id;
}

const CLEAR_DATA_CONFIRM_NAME="Chiranjay Verma";
function clearD(){
  if(!confirm("⚠️ This permanently deletes ALL your data — every workout, nutrition entry, weight log, personal record, and custom exercise — on this device AND in the database.\n\nThis cannot be undone.\n\nContinue?"))return;
  if(!confirm("⚠️ Are you absolutely sure? There is no way to recover this once deleted — not from backups, not from the cloud, nothing.\n\nYou'll need to type your name on the next screen to confirm."))return;
  const typed=prompt(`Type your full name exactly ("${CLEAR_DATA_CONFIRM_NAME}") to permanently delete everything:`);
  if(typed===null)return;
  if(typed!==CLEAR_DATA_CONFIRM_NAME){showToast("Name didn't match · nothing was deleted");return;}
  wipeAllData();
}
async function wipeAllData(){
  showToast("Deleting everything…");
  let dbOk=true;
  try{
    if(API_CFG.token){
      const r=await fetch(API_CFG.baseUrl+"/api/mutate",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},body:JSON.stringify({entity:"wipe_all",payload:{confirm:"WIPE_ALL"}})});
      dbOk=r.ok;
    }
  }catch(e){dbOk=false;}
  for(let i=localStorage.length-1;i>=0;i--){
    const k=localStorage.key(i);
    if(k&&(k==="f5"||k==="f5_outbox"||k==="f5_snapshots"||k.startsWith("f5_daily_")))localStorage.removeItem(k);
  }
  if(!dbOk)alert("Local data was cleared, but the database wipe failed (network or server error). Your cloud data may still exist — reopen the app and try Clear All Data again once you're back online.");
  location.reload();
}

function resetPlan(){
  if(!confirm("Reset to the default program? Your session history is kept."))return;
  delete S.weekPlans;
  delete S.plan; // migration cleanup
  save();
  queueMutation("week_plan_reset",{}); // no weekKey = clear all weeks server-side
  location.reload();
}

function buildSessionHistory(maxWeeks=4){
  const history=[];
  for(let w=0;w<maxWeeks;w++){
    const weekKey=nthPrevWk(w);
    const weekData={weekKey,weekLabel:weekLabel(weekKey),sessions:{},sessionDurationMin:{}};
    let hasData=false;
    for(const[day,dayData]of Object.entries(PROG)){
      const key=day+"_"+weekKey;
      const sessData=S.sessions[key];
      if(!sessData)continue;
      const exs=[];
      for(const ex of(dayData.exercises||[])){
        const ed=sessData[ex.id];
        if(!ed)continue;
        const setsDone=(ed.sets||[]).filter(s=>s.done).map(s=>({weight:s.weight,reps:s.reps}));
        if(setsDone.length||ed.done||ed.skipped){
          exs.push({id:ex.id,name:ex.name,target_sets:ex.sets,target_reps:ex.reps,current_hint:ex.hint,sets_logged:setsDone,completed:!!ed.done,skipped:!!ed.skipped});
          hasData=true;
        }
      }
      if(exs.length){
        weekData.sessions[day]=exs;
        if(sessData._duration)weekData.sessionDurationMin[day]=Math.round(sessData._duration/60);
        if(w===0&&sessData._notes)weekData.sessions[day+"_notes"]=sessData._notes;
      }
    }
    if(hasData)history.push(weekData);
  }
  return history;
}

function buildApprovedExercises(){
  const seen=new Set();
  const list=[];
  for(const[,dayData]of Object.entries(PROG)){
    for(const ex of(dayData.exercises||[])){
      if(ex.cat==="cardio"||ex.cat==="physio")continue;
      const key=ex.name.toLowerCase().trim();
      if(seen.has(key))continue;
      seen.add(key);
      list.push({name:ex.name,muscles:ex.muscles||[],hint:ex.hint||""});
    }
  }
  return list;
}

function buildPlanSnapshot(){
  const snap={};
  for(const[day,dayData]of Object.entries(PROG)){
    if(!dayData.exercises?.length)continue;
    snap[day]={label:dayData.label,exercises:dayData.exercises.map(ex=>({id:ex.id,name:ex.name,cat:ex.cat,sets:ex.sets,reps:ex.reps,hint:ex.hint,muscles:ex.muscles||[]}))};
  }
  return snap;
}

let _pendingPlan=null;

// Spine safety net: the AI is instructed not to suggest these, but never trust it.
// Any "add" matching a banned pattern is stripped before preview and flagged.
const BANNED_EX=[
  /overhead/i,/military/i,/shoulder\s*press/i,/arnold/i,/push\s*press/i,
  /\bsquat\b/i,/deadlift/i,/good\s*morning/i,/\blunge/i,/split\s*squat/i,
  /step[\s-]?up/i,/stair/i,/box\s*jump/i,/\bjump/i,/burpee/i,
  /\bstanding\b/i,/upright\s*row/i,/barbell\s*row/i,/bent[\s-]?over/i,
  /\bclean\b/i,/snatch/i,/thruster/i,/farmer/i,/\bcarr(y|ies)\b/i,/\brunning?\b/i
];
export function isBannedExercise(name){
  const n=String(name||"");
  if(/lat\s*pulldown/i.test(n)&&!/neutral|close/i.test(n))return true; // standard lat pulldown banned
  return BANNED_EX.some(rx=>rx.test(n));
}
function sanitizePlan(parsed){
  if(!parsed||!parsed.week_plan)return parsed;
  const stripped=[];
  for(const[day,exs]of Object.entries(parsed.week_plan)){
    if(!Array.isArray(exs))continue;
    parsed.week_plan[day]=exs.filter(e=>{
      if(e&&e.action==="add"&&isBannedExercise(e.name)){stripped.push(e.name);return false;}
      return true;
    });
  }
  if(stripped.length){
    parsed.flags=parsed.flags||[];
    parsed.flags.unshift("⛔ Blocked unsafe AI suggestions (spine rules): "+stripped.join(", "));
  }
  return parsed;
}

async function genWeeklyPlan(){
  // Busy state applied to every generate button (plan nudge + settings copy)
  const btns=[...document.querySelectorAll(".gen-plan-btn")];
  if(!btns.length)return;
  btns.forEach(b=>{b.dataset.lbl=b.textContent;b.disabled=true;b.innerHTML='<span class="spin"></span>Generating...';});
  // Guard against a hung request (e.g. slow model) leaving the spinner stuck forever
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),60000);
  try{
    const r=await fetch(API_CFG.baseUrl+"/api/weekly-plan",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},
      body:JSON.stringify({
        sessionHistory:buildSessionHistory(4),
        profile:{equipment:GYM,currentPlan:buildPlanSnapshot(),approvedExercises:buildApprovedExercises(),weightLog:(()=>{const ws=S.nutrition.weights||{};return Object.keys(ws).sort().slice(-8).map(d=>({date:d,kg:ws[d]}));})(),goal:{targetKg:USER.targetKg,byDate:isoDate(USER.goalDate)}}
      }),
      signal:ctrl.signal
    });
    if(!r.ok)throw new Error("Request failed");
    const data=await r.json();
    let parsed;
    try{parsed=JSON.parse(data.text);}
    catch{const m=data.text?.match(/\{[\s\S]*\}/);if(m)parsed=JSON.parse(m[0]);else throw new Error("Invalid response");}
    parsed=sanitizePlan(parsed);
    _pendingPlan=parsed;
    showPlanModal(parsed);
  }catch(e){
    showToast(e&&e.name==="AbortError"?"Plan timed out · try again":"Failed to generate plan · try again");
  }finally{
    clearTimeout(timer);
    btns.forEach(b=>{b.disabled=false;b.textContent=b.dataset.lbl||"Generate Next Week";});
  }
}

function showPlanModal(parsed){
  const modal=document.getElementById("planModal");
  const weekPlan=parsed.week_plan||{};
  const notes=parsed.coaching_notes||"";
  const flags=Array.isArray(parsed.flags)?parsed.flags:[];

  let changesHtml="";
  let changeCount=0;
  for(const[day,exercises]of Object.entries(weekPlan)){
    if(!Array.isArray(exercises)||!exercises.length||!PROG[day])continue;
    for(const upd of exercises){
      if(upd.action==="remove"){
        const cur=PROG[day].exercises.find(e=>e.id===upd.id);
        if(!cur)continue;
        changeCount++;
        changesHtml+=`<div class="pm-change"><div class="pm-change-day">${esc(day)}</div><div class="pm-change-ex" style="color:var(--red)">🗑 ${esc(cur.name)}</div><div class="pm-change-val" style="color:var(--red)">Removing</div>${upd.reason?`<div class="pm-change-reason">${esc(upd.reason)}</div>`:""}</div>`;
      } else if(upd.action==="add"){
        changeCount++;
        changesHtml+=`<div class="pm-change"><div class="pm-change-day">${esc(day)}</div><div class="pm-change-ex" style="color:var(--green)">➕ ${esc(upd.name||upd.id)}</div><div class="pm-change-val" style="color:var(--green)">${upd.sets||""}×${upd.reps||""} · ${esc(upd.hint||"")}</div>${upd.reason?`<div class="pm-change-reason">${esc(upd.reason)}</div>`:""}</div>`;
      } else {
        const cur=PROG[day].exercises.find(e=>e.id===upd.id);
        if(!cur)continue;
        const hintChanged=upd.hint!==undefined&&upd.hint!==cur.hint;
        const setsChanged=upd.sets!==undefined&&upd.sets!==cur.sets;
        const repsChanged=upd.reps!==undefined&&String(upd.reps)!==String(cur.reps);
        if(!hintChanged&&!setsChanged&&!repsChanged)continue;
        changeCount++;
        const from=[cur.hint,`${cur.sets}×${cur.reps}`].filter(Boolean).join(" · ");
        const to=[upd.hint||(hintChanged?"":cur.hint),(setsChanged||repsChanged)?`${upd.sets||cur.sets}×${upd.reps||cur.reps}`:null].filter(Boolean).join(" · ");
        changesHtml+=`<div class="pm-change"><div class="pm-change-day">${esc(day)}</div><div class="pm-change-ex">${esc(cur.name)}</div><div class="pm-change-val">${esc(from)} → ${esc(to)}</div>${upd.reason?`<div class="pm-change-reason">${esc(upd.reason)}</div>`:""}</div>`;
      }
    }
  }

  modal.innerHTML=`
    <div class="pm-title">Next Week's Plan</div>
    <div class="pm-sub">Effective from week of ${esc(weekLabel(nextWk()))}. Review then apply.</div>
    ${notes?`<div class="pm-section">Coaching Notes</div><div class="pm-notes">${mdLite(notes)}</div>`:""}
    ${flags.length?`<div class="pm-section">Flags</div>${flags.map(f=>`<div class="pm-flag">${esc(f)}</div>`).join("")}`:""}
    <div class="pm-section">Changes${changeCount?` (${changeCount})`:""}</div>
    ${changesHtml||`<div class="pm-notes">No changes needed · program looks good for next week.</div>`}
    <div class="pm-btns">
      <button class="pm-cancel" onclick="closePlanModal()">Cancel</button>
      <button class="pm-apply" onclick="applyPendingPlan()">Apply Plan</button>
    </div>`;
  modal.classList.add("show");
}

function closePlanModal(){
  document.getElementById("planModal").classList.remove("show");
  _pendingPlan=null;
}

function applyPendingPlan(){
  if(!_pendingPlan?.week_plan){closePlanModal();return;}
  const nwk=nextWk();
  S.weekPlans=S.weekPlans||{};
  S.weekPlans[nwk]=S.weekPlans[nwk]||{};
  for(const[day,exercises]of Object.entries(_pendingPlan.week_plan)){
    if(!Array.isArray(exercises)||!PROG[day])continue;
    if(!S.weekPlans[nwk][day])S.weekPlans[nwk][day]=[];
    for(const upd of exercises){
      if(upd.action==="add"){
        // New exercise · store full definition
        const stored=S.weekPlans[nwk][day].find(e=>e.id===upd.id);
        if(stored)Object.assign(stored,upd);
        else S.weekPlans[nwk][day].push({...upd});
      } else if(upd.action==="remove"){
        // Store remove marker
        if(!S.weekPlans[nwk][day].find(e=>e.id===upd.id))
          S.weekPlans[nwk][day].push({action:"remove",id:upd.id});
      } else {
        // Standard update · only for exercises that exist in PROG
        const ex=PROG[day].exercises.find(e=>e.id===upd.id);
        if(!ex)continue;
        // Store only · do NOT mutate PROG now; applyPlanOverrides() applies it next week
        const stored=S.weekPlans[nwk][day].find(e=>e.id===upd.id);
        if(stored)Object.assign(stored,upd);
        else S.weekPlans[nwk][day].push({...upd});
      }
    }
  }
  save();
  // Persist the week's final plan state: clear the week's rows server-side,
  // then re-append every stored update. Ordered delivery through the outbox
  // makes this reconstruct S.weekPlans[nwk] exactly, even after local merges
  // (Object.assign above) that an append-only log couldn't express.
  queueMutation("week_plan_reset",{weekKey:nwk});
  for(const[day,updates]of Object.entries(S.weekPlans[nwk]))
    for(const upd of(updates||[]))
      queueMutation("week_plan_update",{weekKey:nwk,dayName:day,update:upd});
  closePlanModal();
  renderST();
  showToast("Plan saved for week of "+weekLabel(nwk)+" ✓");
}



window.genWeeklyPlan=genWeeklyPlan;
window.resetPlan=resetPlan;
window.closePlanModal=closePlanModal;
window.exportBackup=exportBackup;
window.importBackup=importBackup;
window.openPDFReport=openPDFReport;
window.showExportSheet=showExportSheet;
window.clearD=clearD;
window.findN=findN;
window.genExp=genExp;
window.copyExp=copyExp;
window.scanDemos=scanDemos;
window.unlockDay=unlockDay;
window.lockDay=lockDay;
window.shiftWeek=shiftWeek;
window.goCurrentWeek=goCurrentWeek;
window.restoreDailyBackup=restoreDailyBackup;
ctx.renderST=renderST;
