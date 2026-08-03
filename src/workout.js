import { ctx } from "./runtime.js";
import { isoToday, isoDate } from "./phase.js";
import { esc, fmtDate, showToast, showToastBig, showMilestone, mdLite, icon } from "./ui.js";
import { save } from "./state.js";
import { API_CFG, queueSession, queueSessionMeta, queueMutation, queueMilestones } from "./sync.js";
import { EX_DB, PROG, programFor, PROG_V1, PROG_V2, PROG_V3, PROG_V4, DAYS, GYM } from "./constants.js";

function fetchT(url, opts, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

// ── UNITS · per-exercise label (no conversion, you enter what you see) ──
function getExUnit(key,exId){const S=ctx.getS();return S.sessions[key]?.[exId]?.unit||"kg";}
function toggleExUnit(key,exId){
  const S=ctx.getS();
  if(ctx.isReadOnly(key))return;
  if(!S.sessions[key])S.sessions[key]={};
  if(!S.sessions[key][exId])S.sessions[key][exId]={done:false,sets:[],skipped:false};
  S.sessions[key][exId].unit=getExUnit(key,exId)==="kg"?"lbs":"kg";
  save();queueSession(key,exId);reCard(key,exId);
}
function hintDisp(hint,unit){
  if(!hint)return"";
  return hint.replace(/\b(kg|lbs)\b/gi,"").trim()+" "+(unit||"kg");
}

// ── REST TIMER (background-safe) ──
// Duration comes from the exercise's `rest` field so the plan's own intervals
// are honoured (90s on heavy compounds, 45s on finishers). Exercises without
// a rest value fall back to the old fixed 30s.
const REST_DURATION=30;
let _restEnd=null,_restInterval=null;
function startRest(sec){
  _restEnd=Date.now()+(Number(sec)>0?Number(sec):REST_DURATION)*1000;
  const o=document.getElementById("restOverlay");if(o)o.classList.add("show");
  updateRestDisplay();
  clearInterval(_restInterval);
  _restInterval=setInterval(tickRest,250);
  if(navigator.vibrate)navigator.vibrate([30]);
}
function tickRest(){
  const left=Math.ceil((_restEnd-Date.now())/1000);
  if(left<=0){
    clearInterval(_restInterval);
    document.getElementById("restOverlay").classList.remove("show");
    _restEnd=null;
    if(navigator.vibrate)navigator.vibrate([60,40,60]);
    showToast("Rest done · go! 💪");
    return;
  }
  updateRestDisplay();
}
function updateRestDisplay(){
  const left=Math.max(0,Math.ceil((_restEnd-Date.now())/1000));
  const el=document.getElementById("restNum");
  if(el)el.textContent=left;
}
function skipRest(){
  clearInterval(_restInterval);
  const o=document.getElementById("restOverlay");if(o)o.classList.remove("show");
  _restEnd=null;
}
document.addEventListener("visibilitychange",()=>{
  if(!document.hidden&&_restEnd){
    const left=Math.ceil((_restEnd-Date.now())/1000);
    if(left<=0){skipRest();showToast("Rest done · go! 💪");}
    else updateRestDisplay();
  }
});

// ── LAST SESSION HELPER ──
function lastSessionEx(exId){
  const S=ctx.getS();
  const curKey=ctx.sk(ctx.cDay);
  const sessions=S.sessions||{};
  let best=null;
  for(const[key,data] of Object.entries(sessions)){
    if(key===curKey)continue;
    const ed=data[exId];
    if(!ed||!ed.sets)continue;
    const doneSets=ed.sets.filter(s=>s.done&&s.weight&&s.reps);
    if(!doneSets.length)continue;
    const m=key.match(/_(\d{4})W(\d+)$/);
    if(!m)continue;
    const ord=+m[1]*100+(+m[2]);
    if(!best||ord>best.ord){best={ord,sets:doneSets};}
  }
  if(!best)return null;
  const weights=best.sets.map(s=>parseFloat(s.weight)||0).filter(v=>v>0);
  const reps=best.sets.map(s=>s.reps).find(r=>r)||"?";
  if(!weights.length)return null;
  const avgW=weights.reduce((a,b)=>a+b,0)/weights.length;
  return{weight:avgW,reps,sets:best.sets};
}

// ── OVERLOAD DIRECTION ──
function overloadDir(exId,sess){
  const last=lastSessionEx(exId);
  if(!last)return null;
  const ed=sess[exId];
  if(!ed||!ed.sets)return null;
  const curDone=ed.sets.filter(s=>s.done&&s.weight);
  if(!curDone.length)return null;
  const curW=curDone.map(s=>parseFloat(s.weight)||0).filter(v=>v>0);
  if(!curW.length)return null;
  const curAvg=curW.reduce((a,b)=>a+b,0)/curW.length;
  const lastAvg=last.weight;
  if(curAvg-lastAvg>0.5)return"up";
  if(lastAvg-curAvg>0.5)return"down";
  return"eq";
}

// ── CALF LOGGER ──
function logCalfTwinge(){
  const S=ctx.getS();
  const key=ctx.sk(ctx.cDay);
  if(!S.sessions[key])S.sessions[key]={};
  if(!Array.isArray(S.sessions[key]._calfTwinges))S.sessions[key]._calfTwinges=[];
  S.sessions[key]._calfTwinges.push(Date.now());
  save();queueSessionMeta(key);
  const cnt=S.sessions[key]._calfTwinges.filter(ts=>Number.isFinite(ts)).length;
  const btn=document.getElementById("calfBtn");
  if(btn){
    const badge=btn.querySelector(".calf-badge");
    if(badge)badge.textContent=cnt;
    if(cnt>=3){btn.classList.add("calf-warn");}
  }
  if(cnt===3){
    showToast("⚠️ 3 twinges · consider stopping the session");
    if(navigator.vibrate)navigator.vibrate([100,50,100,50,100]);
  } else {
    showToast("Calf twinge logged");
  }
}
function undoCalfTwinge(){
  const S=ctx.getS();
  const key=ctx.sk(ctx.cDay);
  const arr=S.sessions[key]?._calfTwinges;
  if(!arr||!arr.length){showToast("Nothing to undo");return;}
  arr.pop();
  save();queueSessionMeta(key);
  showToast("Twinge removed");
  renderW();
}

// ── VOLUME DATA ──
// Planned sets come from PROG, which applyPlanOverrides() has already
// mutated with this week's AI-generated plan - so planned volume tracks
// the live weekly plan, not the static base program.
function wkForDate(d){
  // Compute the same week key that wk() would return for a given Date object.
  const j=new Date(d.getFullYear(),0,1);
  return d.getFullYear()+"W"+Math.ceil(((d-j)/86400000+j.getDay()+1)/7);
}
function buildVolumeData(){
  const S=ctx.getS();
  // Sunday = week reset: show empty so the counter reads 0 for the new week.
  if(new Date().getDay()===0)return[];
  const today=isoToday();
  const now=new Date(today+"T12:00:00");
  const dow=now.getDay();
  const monOffset=dow===0?-6:1-dow;
  const DAY_ORDER=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  const planned={},done={};
  for(const[day,dayData] of Object.entries(PROG)){
    const idx=DAY_ORDER.indexOf(day);
    if(idx<0)continue;
    const dayDate=new Date(today+"T12:00:00");
    dayDate.setDate(dayDate.getDate()+monOffset+idx);
    if(dayDate>now)continue; // skip future days
    const weekKey=wkForDate(dayDate);
    const sessData=S.sessions[day+"_"+weekKey];
    for(const ex of(dayData.exercises||[])){
      if(ex.cat==="cardio")continue;
      const n=typeof ex.sets==="number"?ex.sets:0;
      for(const m of(ex.muscles||[]))planned[m]=(planned[m]||0)+n;
      const ed=sessData&&sessData[ex.id];
      if(!ed||!ed.sets)continue;
      const doneCount=ed.sets.filter(s=>s.done).length;
      if(!doneCount)continue;
      for(const m of(ex.muscles||[]))done[m]=(done[m]||0)+doneCount;
    }
  }
  return Object.keys(planned)
    .map(muscle=>({muscle,planned:planned[muscle],done:done[muscle]||0}))
    .filter(v=>v.planned>0||v.done>0)
    .sort((a,b)=>b.planned-a.planned||b.done-a.done);
}

// ── SESSION NOTES DEBOUNCE ──
let _notesTimer=null;
function saveNotes(val){
  const S=ctx.getS();
  clearTimeout(_notesTimer);
  _notesTimer=setTimeout(()=>{
    const key=ctx.sk(ctx.cDay);
    if(!S.sessions[key])S.sessions[key]={};
    S.sessions[key]._notes=val;
    save();queueSessionMeta(key);
  },500);
}

// The program for the day being VIEWED, not for today. PROG is a snapshot
// resolved at load time, so using it made next week render this week's plan:
// browsing to Aug 3 still showed the V3 return block instead of Southpaw.
function curProg(day){return programFor(ctx.viewDate())[day||ctx.cDay];}

// Next day from the viewed one that actually schedules gym work. Used to give a
// rest day somewhere to point instead of a dead end.
function nextSession(){
  const from=ctx.viewDate();
  for(let i=1;i<=7;i++){
    const d=new Date(from);d.setDate(from.getDate()+i);
    const day=DAYS[d.getDay()===0?6:d.getDay()-1];
    const p=programFor(d)[day];
    if((p?.exercises||[]).some(e=>e.cat==="gym"))
      return{when:i===1?"Tomorrow":day,label:p.label};
  }
  return null;
}

export function renderW(){
  const S=ctx.getS();
  const cDay=ctx.cDay;
  const prog=curProg(cDay),el=document.getElementById("tc");
  const past=ctx.isPast();
  const future=ctx.isFuture();
  const _key0=ctx.sk(cDay);
  if(!past&&!future&&!S.sessions[_key0])S.sessions[_key0]={};
  const stopped=!ctx.workoutOn&&!!(S.sessions[_key0]||{})._stopped;
  const lockedPast=ctx.isPastDay()&&!ctx.unlocked[_key0];
  const readOnly=future||lockedPast||(stopped&&!ctx.isPastDay());
  const _vm=ctx.viewMon||_todayMonday();
  const _curMonLbl=fmtDate(_todayMonday().toISOString().slice(0,10));
  const wkLbl=past?`Week of ${fmtDate(_vm.toISOString().slice(0,10))}`:future?'Next Week':'This Week';
  const canGoForward=_vm<(()=>{const nm=new Date(_todayMonday());nm.setDate(nm.getDate()+7);return nm;})();
  const wkNav=`<div class="wk-nav">
    <button class="wk-nav-btn" onclick="shiftWeek(-1)">← Prev</button>
    <div class="wk-nav-lbl">${esc(wkLbl)}${(past||future)
      ?`<span class="wk-nav-back" onclick="goCurrentWeek()">↩ Back to this week</span>`
      :`<span class="wk-nav-cur">${esc(_curMonLbl)}</span>`}
    </div>
    <button class="wk-nav-btn" ${canGoForward?'':'disabled'} onclick="shiftWeek(1)">Next →</button>
  </div>`;

  const key=_key0;
  const sess=S.sessions[key]||{};
  const dispExs=future?getPreviewExercises(cDay):prog.exercises;
  const total=dispExs.length;
  const manualDone=!!sess._complete;
  const done=manualDone?total:dispExs.filter(e=>sess[e.id]?.done).length;
  const pct=total?Math.round((done/total)*100):0;
  const gymExs=dispExs.filter(e=>e.cat!=="physio");
  const physioExs=dispExs.filter(e=>e.cat==="physio");

  let h=wkNav;
  if(ctx.isPastDay()){
    h+=lockedPast
      ?`<div class="past-banner lock-banner">${icon("lock",18)} Past day · read-only<button class="edit-pill" onclick="unlockDay()" title="Unlock editing">${icon("pencil",18)}</button></div>`
      :`<div class="past-banner lock-banner" style="color:var(--amber);border-color:var(--amber)">${icon("pencil",18)} Editing past day<button class="edit-pill" onclick="lockDay()" title="Lock editing">${icon("unlock",18)}</button></div>`;
  }
  if(future){
    // Plans are stored under nextWk(); read the same key (vwk() can differ near the Sunday boundary)
    const hasPlan=!!((S.weekPlans||{})[ctx.nextWk()]);
    h+=`<div class="past-banner" style="color:var(--amber);border-color:var(--amber)">${icon("calendar",20)} Next week · Preview${hasPlan?' · Plan queued ✓':' · Default program'}</div>`;
  }
  h+=`<div class="hero ${heroCls(prog.label)}"${heroStyleAttr(heroCls(prog.label))}>
    <div class="hero-kicker">${esc(cDay)} · ${esc(prog.sub)}</div>
    <div class="hero-title">${esc(prog.label)}${prog.tag?`<span class="hero-tag">${esc(prog.tag)}</span>`:""}</div>
    ${!total?(()=>{const nx=nextSession();return nx?`<div class="hero-next">
      <span class="hero-next-lbl">Next</span>
      <span class="hero-next-day">${esc(nx.when)}</span>
      <span class="hero-next-ex">${esc(nx.label)}</span>
    </div>`:"";})():""}
    ${future||!total?"":`<div class="hero-prog"><div class="hero-prog-fill" style="width:${pct}%"></div></div>
    <div class="hero-count">${done} of ${total} complete</div>
    ${(()=>{const {days:streak}=currentStreak();const longest=S.milestones.longestStreak||0;return streak>=1?`<div class="hero-streak">${icon("flame",18)} ${streak} day streak${longest>streak?` · best ${longest}`:""}</div>`:"";})()} `}
  </div>`;
  // A day the program schedules nothing for. "Start Workout" and a 0 of 0
  // progress bar both read as broken here, so show the rest-day state instead.
  // Set when the day is live and unfinished, so the mark-complete button can
  // render further down the page (above the notes) instead of directly under
  // the session bar, where it competed with Start Workout.
  let showMarkDone=false;
  if(!prog.exercises.length){
    // Rest day: the hero already carries the state and what comes next, so
    // there is deliberately nothing else here. No CTA, no notice bar.
  } else if(!future&&!ctx.isPastDay()){
    showMarkDone=true;
    const nonPhysio=prog.exercises.filter(e=>e.cat!=="physio");
    const allDone=manualDone||(nonPhysio.length>0&&nonPhysio.every(e=>sess[e.id]?.done));
    if(allDone||stopped)showMarkDone=false;
    if(allDone&&!stopped){
      h+=`<div class="session-bar"><div class="sess-complete">✓ Session Complete${manualDone?`<button class="sess-undo" onclick="toggleDayComplete()">Undo</button>`:""}</div></div>`;
    } else if(stopped){
      h+=`<div class="session-bar"><button class="btn-start" onclick="resumeSess()">▶ Resume Workout</button></div>`;
    } else {
      // Build calf twinge button if workout is active
      const twinges=(sess._calfTwinges||[]).filter(ts=>Number.isFinite(ts)).length;
      const calfWarnCls=twinges>=3?" calf-warn":"";
      const calfBtnHtml=ctx.workoutOn?`<button class="calf-btn${calfWarnCls}" id="calfBtn" onclick="logCalfTwinge()">${icon("bolt",18)} Calf twinge<span class="calf-badge">${twinges}</span></button>${twinges>0?`<button class="btn-g" style="padding:8px 12px;font-size:11px" onclick="undoCalfTwinge()">Undo</button>`:""}`:"";
      h+=`<div class="session-bar">
        <button class="btn-start${ctx.workoutOn?" hide":""}" id="bStart" onclick="startSess()">${icon("bolt",18)} Start Workout</button>
        <button class="btn-stop${ctx.workoutOn?" show":""}" id="bStop" onclick="stopSess()">■ Stop Workout</button>
        ${calfBtnHtml}
      </div>`;
    }
  }

  if(cDay==="Sunday"){
    h+=`<div class="physio-banner">Rest day · physio only. Recovery is where adaptation happens.</div>`;
  }

  // Late-week planning nudge: Sat/Sun, current week, no plan queued yet
  const _dowNow=new Date().getDay();
  if(!ctx.isPastDay()&&!ctx.isFuture()&&_dowNow===0&&!(S.weekPlans||{})[ctx.nextWk()]){
    h+=`<div class="plan-nudge">
      <div><div class="plan-nudge-ttl">${icon("calendar",20)} Plan next week</div><div class="plan-nudge-sub">Apply progressive overload from this week's sessions</div></div>
      <button class="btn-o gen-plan-btn" onclick="genWeeklyPlan()" style="flex:0 0 auto;width:auto;padding:10px 16px">Generate</button>
    </div>`;
  }

  if(gymExs.length){h+=`<details class="st-acc" open><summary class="sec" style="padding:12px 16px">${prog.sub.includes("Gym")?`${icon("gym",20)} Gym`:"Exercises"}</summary>`;gymExs.forEach(ex=>{h+=card(ex,sess,key,readOnly);});h+=`</details>`;}
  if(physioExs.length){h+=`<details class="st-acc" open><summary class="sec" style="padding:12px 16px">${icon("physio",20)} Physio · Yoga Mat</summary>`;physioExs.forEach(ex=>{h+=card(ex,sess,key,readOnly);});h+=`</details>`;}

  // Show exercises stored under a previous program version (e.g. V2 data visible when V3 is active)
  if(!future){
    const _allExMap={};
    [PROG_V1,PROG_V2,PROG_V3,PROG_V4].forEach(pv=>Object.values(pv).forEach(day=>(day.exercises||[]).forEach(e=>{_allExMap[e.id]=e;})));
    const curIds=new Set(dispExs.map(e=>e.id));
    const orphanEntries=Object.entries(sess).filter(([id,ed])=>!id.startsWith('_')&&!curIds.has(id)&&_allExMap[id]&&ed&&(ed.done||(ed.sets||[]).some(s=>s&&s.done)));
    if(orphanEntries.length){
      h+=`<details class="st-acc" open><summary class="sec" style="padding:12px 16px;color:var(--dim)">${icon("folder",20)} Logged on previous program</summary>`;
      orphanEntries.forEach(([id,ed])=>{
        const ex=_allExMap[id];
        const doneSets=(ed.sets||[]).filter(s=>s&&s.done);
        const unit=ed.unit||"kg";
                const iconCls=ex.cat==="physio"?"physio":ex.cat==="cardio"?"cardio":"gym";
        const setRows=doneSets.length
          ?doneSets.map((s,i)=>`<div style="display:flex;gap:8px;font-size:13px;color:var(--mid);padding:2px 0"><span style="color:var(--dim);min-width:40px">Set ${i+1}</span><span>${esc(String(s.weight||"·"))} ${unit} × ${esc(String(s.reps||"·"))}</span></div>`).join("")
          :`<div style="font-size:13px;color:var(--dim)">No sets recorded</div>`;
        h+=`<div class="ex-card ex-card--prev" style="opacity:0.75">
          <div class="ex-top" style="cursor:default">
            <div class="ex-icon ${iconCls}">${icon(iconCls)}</div>
            <div class="ex-info"><div class="ex-name">${esc(ex.name)}</div><div class="ex-meta">Previous program · read-only</div></div>
          </div>
          <div style="padding:0 15px 14px">${setRows}</div>
        </div>`;
      });
      h+=`</details>`;
    }
  }

  // Mark complete sits here, immediately above the notes: the end of the
  // session content, where you actually are when the day is finished. Same
  // treatment as Start Workout so it reads as the other end of the same action.
  if(showMarkDone){
    h+=`<div class="session-bar markdone-bar"><button class="btn-start" onclick="toggleDayComplete()">Mark Complete</button></div>`;
  }

  // Session notes
  if(!readOnly){
    const savedNotes=sess._notes||"";
    h+=`<div class="notes-wrap">
      <span class="notes-label">Session Notes</span>
      <textarea class="notes-area" id="sessNotes" placeholder="Session notes..." oninput="saveNotes(this.value)">${esc(savedNotes)}</textarea>
    </div>`;
  }

  if(!readOnly)h+=`<div class="custom-wrap">
    <button class="custom-trigger" onclick="toggleCF()">+ Add Custom Exercise</button>
    <div class="custom-form" id="cf">
      <label class="cf-label">Search exercise library</label>
      <div class="search-wrap">
        <input class="cf-inp" id="cfSearch" placeholder="Type exercise name to search..." oninput="searchEx(this.value,'${cDay}')" autocomplete="off">
        <div class="search-dd" id="cfDD"></div>
      </div>
      <div style="font-size:11px;color:var(--dim);margin-top:8px;letter-spacing:0.2px">Tap + on any result to add directly to today's session</div>
    </div>
  </div>`;
  h+=`<div style="height:12px"></div>`;
  el.innerHTML=h;
}
ctx.renderW=renderW;

function heroCls(label){
  const l=(label||"").toLowerCase();
  if(/recovery|rest|mobility/.test(l))return"hero-rest";
  if(/leg|lower|glute|calf/.test(l)&&!/push|chest/.test(l))return"hero-legs";
  if(/back|pull|arm|bicep/.test(l))return"hero-pull";
  if(/core|ab/.test(l))return"hero-core";
  return"hero-push";
}
// Per-day identity now lives in the .hero-* CSS gradient classes (--grad-*).
// Photos removed: they fought the volt identity and added a network dependency.
function heroStyleAttr(){return"";}

// Exercise demo clips · candidates probed FROM THE BROWSER (MuscleWiki's CDN
// blocks datacenter IPs; the phone loads it fine). Hits cached permanently in
// S.demoCache (synced). Misses cached for this session only · retried next launch.
const _demoMiss={}; // session-only misses
const DEMO_CDN="https://media.musclewiki.com/media/uploads/videos/branded/";
// MuscleWiki uses its own exercise names · curated alias slugs per FORGE exercise
const DEMO_ALIASES={
  "Seated Cable Row":["machine|seated-cable-row"],
  "Chest Press Machine":["machine|chest-press","machine|seated-chest-press"],
  "Incline Chest Press Machine":["machine|incline-chest-press"],
  "Pec Fly Machine":["machine|pec-fly","machine|seated-pec-fly","machine|butterfly","machine|chest-fly"],
  "Rear Delt Fly Machine":["machine|reverse-fly","machine|rear-delt-fly","machine|seated-reverse-fly"],
  "Chest Supported Row":["machine|chest-supported-row","machine|seal-row","dumbbells|chest-supported-row"],
  "Tricep Extension Machine":["machine|tricep-extension","machine|seated-dip","machine|tricep-dip"],
  "Preacher Curl Machine":["machine|preacher-curl","barbell|preacher-curl","dumbbells|preacher-curl"],
  "Leg Press Machine":["machine|sled-45-leg-press","machine|leg-press","machine|horizontal-leg-press","machine|sled-leg-press"],
  "Seated Leg Curl":["machine|seated-leg-curl","machine|hamstring-curl","machine|lying-leg-curl","machine|leg-curl"],
  "Leg Extension Machine":["machine|leg-extension","machine|seated-leg-extension"],
  "Seated Calf Raise":["machine|seated-calf-raise","machine|calf-raise","barbell|seated-calf-raise"],
  "Hip Abduction Machine":["machine|hip-abduction","machine|seated-hip-abduction"],
  "Hip Adduction Machine":["machine|hip-adduction","machine|seated-hip-adduction"],
  "Glute Kickback Machine":["machine|glute-kickback","cables|glute-kickback","machine|kickback"],
  "Neutral Grip Lat Pulldown":["cables|lat-pulldown","machine|lat-pulldown","cables|close-grip-lat-pulldown","cables|neutral-grip-lat-pulldown"],
  "Straight Arm Pulldown":["cables|straight-arm-pulldown","cables|straight-arm-pushdown"],
  "Low Cable Row":["cables|seated-row","cables|low-row","machine|seated-cable-row"],
  "Cable Tricep Pushdown":["cables|tricep-pushdown","cables|push-down","cables|pushdown","cables|tricep-extension"],
  "Cable Tricep Pushdown (Rope)":["cables|rope-pushdown","cables|tricep-rope-pushdown","cables|tricep-pushdown"],
  "Cable Bicep Curl":["cables|bicep-curl","cables|curl","cables|cable-curl"],
  "Dumbbell Row":["dumbbells|bent-over-row","dumbbells|row","dumbbells|single-arm-row","dumbbells|row-unilateral"],
  "Seated Dumbbell Curl":["dumbbells|seated-bicep-curl","dumbbells|bicep-curl","dumbbells|seated-curl","dumbbells|curl"],
  "Hammer Curl":["dumbbells|hammer-curl","dumbbells|seated-hammer-curl"],
  "Concentration Curl":["dumbbells|concentration-curl"],
  "Reverse Curl":["dumbbells|reverse-curl","barbell|reverse-curl"],
  "Incline Dumbbell Fly":["dumbbells|incline-fly","dumbbells|incline-chest-fly","dumbbells|fly"],
  "Seated External Rotation":["dumbbells|external-rotation","dumbbells|seated-external-rotation","cables|external-rotation"],
  "Seated Wrist Curl":["dumbbells|wrist-curl","dumbbells|seated-wrist-curl","barbell|wrist-curl"],
  "Seated Lateral Raise":["dumbbells|lateral-raise","dumbbells|seated-lateral-raise"]
};
function demoCandidates(name){
  const out=[];
  const push=(eq,sl)=>{out.push(DEMO_CDN+"male-"+eq+"-"+sl+"-front.mp4");out.push(DEMO_CDN+"male-"+eq+"-"+sl+"-side.mp4");};
  for(const a of(DEMO_ALIASES[name]||[])){const[eq,sl]=a.split("|");push(eq,sl);}
  // generic fallbacks from the name itself
  const n=name.toLowerCase().replace(/[()]/g,"").trim();
  const base=n.replace(/\b(machine|cable|dumbbell)\b/g,"").replace(/\s+/g," ").trim().replace(/ /g,"-");
  const eqs=n.includes("cable")?["cables"]:n.includes("dumbbell")?["dumbbells"]:["machine"];
  for(const eq of eqs){push(eq,base);if(base.startsWith("seated-"))push(eq,base.slice(7));}
  return[...new Set(out)];
}
function probeOne(url,ms){
  return new Promise(res=>{
    const v=document.createElement("video");
    let done=false;
    const fin=ok=>{if(done)return;done=true;v.onerror=null;v.onloadedmetadata=null;v.src="";res(ok);};
    v.muted=true;v.preload="metadata";
    v.onloadedmetadata=()=>fin(true);
    v.onerror=()=>fin(false);
    setTimeout(()=>fin(false),ms);
    v.src=url;
  });
}
async function probeBatches(cands){
  for(let i=0;i<cands.length;i+=3){
    const batch=cands.slice(i,i+3);
    const results=await Promise.all(batch.map(u=>probeOne(u,4000)));
    const hit=batch[results.indexOf(true)];
    if(hit)return hit;
  }
  return null;
}
let _localDemos=null; // demos/map.json · clips shipped with the app
let _localDemosReady=null; // Promise that resolves when map.json is loaded
_localDemosReady=fetch("demos/map.json").then(r=>r.ok?r.json():null).then(m=>{
  _localDemos=m;
  if(!m)return;
  // Populate ALL placeholder wraps in DOM now — open or closed — so images are
  // ready when the user taps to expand, with no further network request needed.
  document.querySelectorAll(".demo-wrap[data-demo-name]").forEach(wrap=>{
    const name=wrap.getAttribute("data-demo-name");
    const loc=m[name];
    if(!loc)return;
    wrap.removeAttribute("data-demo-name");
    if(Array.isArray(loc)){
      wrap.innerHTML=`<div class="demo-flip"><img src="${loc[0]}" loading="lazy" onerror="this.closest('.demo-wrap').style.display='none'"><img src="${loc[1]}" loading="lazy"></div>`;
    } else {
      wrap.innerHTML=`<video src="${loc}" muted loop playsinline preload="none" onerror="this.parentNode.style.display='none'"></video>`;
    }
    wrap.style.display="";
  });
}).catch(()=>{});
let _demoIndex=null;   // demos/index.json · 870-exercise name index for fuzzy-matching custom exercises
fetch("demos/index.json").then(r=>r.ok?r.json():null).then(m=>{_demoIndex=m;}).catch(()=>{});
const DEMO_GH="https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";
function fuzzyDemo(name){
  if(!_demoIndex)return null;
  const toks=s=>s.toLowerCase().replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter(t=>t&&!["the","a","machine","with"].includes(t));
  const q=toks(name);if(!q.length)return null;
  let best=null,bestScore=0;
  for(const[n,dir]of _demoIndex){
    const c=toks(n);
    const overlap=q.filter(t=>c.includes(t)).length;
    const score=overlap/Math.max(q.length,c.length)+(overlap===q.length?0.3:0);
    if(score>bestScore){bestScore=score;best=dir;}
  }
  if(bestScore<0.65)return null;
  return[DEMO_GH+encodeURIComponent(best)+"/0.jpg",DEMO_GH+encodeURIComponent(best)+"/1.jpg"];
}
function demoHtml(name){
  const S=ctx.getS();
  const loc=_localDemos&&_localDemos[name];
  if(Array.isArray(loc))return`<div class="demo-wrap"><div class="demo-flip"><img src="${loc[0]}" loading="lazy" onerror="this.closest('.demo-wrap').style.display='none'"><img src="${loc[1]}" loading="lazy"></div></div>`;
  if(loc)return`<div class="demo-wrap"><video src="${loc}" muted loop playsinline preload="none" onerror="this.parentNode.style.display='none'"></video></div>`;
  const cached=S.demoCache[name];
  if(Array.isArray(cached))return`<div class="demo-wrap"><div class="demo-flip"><img src="${cached[0]}" loading="lazy" onerror="this.closest('.demo-wrap').style.display='none'"><img src="${cached[1]}" loading="lazy"></div></div>`;
  if(cached)return`<div class="demo-wrap"><video src="${cached}" muted loop playsinline preload="none" onerror="this.parentNode.style.display='none'"></video></div>`;
  if(_demoMiss[name])return"";
  return`<div class="demo-wrap" data-demo-name="${esc(name)}" style="display:none"></div>`; // unresolved · probed on expand
}
async function resolveDemo(wrap){
  const S=ctx.getS();
  const name=wrap.getAttribute("data-demo-name");
  if(!name)return;
  wrap.removeAttribute("data-demo-name");
  // Wait for local map if still loading, then check exact match (no external request needed)
  if(!_localDemos&&_localDemosReady)await _localDemosReady;
  const local=_localDemos&&_localDemos[name];
  if(Array.isArray(local)){
    wrap.innerHTML=`<div class="demo-flip"><img src="${local[0]}" onerror="this.closest('.demo-wrap').style.display='none'"><img src="${local[1]}"></div>`;
    wrap.style.display="";
    return;
  }
  if(local){
    wrap.innerHTML=`<video src="${local}" muted loop playsinline autoplay onerror="this.parentNode.style.display='none'"></video>`;
    wrap.style.display="";
    return;
  }
  const pair=fuzzyDemo(name);
  if(pair){
    S.demoCache[name]=pair;save();
    wrap.innerHTML=`<div class="demo-flip"><img src="${pair[0]}" onerror="this.closest('.demo-wrap').style.display='none'"><img src="${pair[1]}"></div>`;
    wrap.style.display="";
    return;
  }
  const url=await probeBatches(demoCandidates(name));
  if(url){
    S.demoCache[name]=url;save();
    wrap.innerHTML=`<video src="${url}" muted loop playsinline autoplay onerror="this.parentNode.style.display='none'"></video>`;
    wrap.style.display="";
  }else{
    _demoMiss[name]=1; // retry next session, not never
  }
}

async function scanDemos(){
  const S=ctx.getS();
  const sub=document.getElementById("demoScanSub");
  const names=[...new Set(Object.values(PROG).flatMap(d=>(d.exercises||[]).filter(e=>(e.cat||"gym").toLowerCase()==="gym").map(e=>e.name)).concat(Object.keys(DEMO_ALIASES)))]
    .filter(n=>!S.demoCache[n]);
  if(!names.length){showToast("All exercises already scanned ✓");return;}
  showToast("Scanning "+names.length+" exercises…");
  let found=0,missed=[];
  for(let i=0;i<names.length;i++){
    if(sub)sub.textContent="Scanning "+(i+1)+"/"+names.length+": "+names[i];
    const url=await probeBatches(demoCandidates(names[i]));
    if(url){S.demoCache[names[i]]=url;found++;save();}
    else missed.push(names[i]);
  }
  if(sub)sub.textContent=found+" found · "+missed.length+" missing";
  showToast("Done · "+found+" clips found");
  if(missed.length){
    const txt="Missing demo clips:\n"+missed.join("\n");
    if(navigator.clipboard)navigator.clipboard.writeText(txt).then(()=>showToast("Missing list copied · paste it to Claude")).catch(()=>{});
    console.log(txt);
  }
  ctx.renderST();
}

function card(ex,sess,key,rdOnly=false){
  const S=ctx.getS();
  const ed=sess[ex.id]||{done:false,sets:[],skipped:false};
  const isDone=ed.done,isSkip=ed.skipped;
    const iconCls=ex.cat==="physio"?"physio":ex.cat==="cardio"?"cardio":"gym";
  const sLbl=ex.sets===1?`1 set · ${ex.reps}`:`${ex.sets} sets × ${ex.reps}`;
  const cls=isSkip?"skipped":isDone?"done":"";
  const isActive=document.getElementById("sb-"+ex.id)?.classList.contains("open");
  // Always use a search link · stored video URLs rot, search never 404s
  const name=esc(ex.name),hint=esc(ex.hint),cue=esc(ex.cue),reps=esc(ex.reps);
  const url="https://www.youtube.com/results?search_query="+encodeURIComponent(ex.name+" form");
  const demo=demoHtml(ex.name);

  // Last session ghost
  const lastSess=(ex.sets>1&&ex.cat!=="cardio")?lastSessionEx(ex.id):null;
  const exUnit=ed.unit||"kg";
  const ghostHtml=lastSess?`<div class="last-ghost">Last: ${parseFloat(lastSess.weight.toFixed(1))}${exUnit} × ${esc(String(lastSess.reps))}</div>`:"";

  // Overload badge
  let olBadge="";
  if(ex.sets>1){
    const dir=overloadDir(ex.id,sess);
    if(dir==="up")olBadge=`<span class="ol-up">↑</span>`;
    else if(dir==="down")olBadge=`<span class="ol-down">↓</span>`;
    else if(dir==="eq")olBadge=`<span class="ol-eq">=</span>`;
  }

  let body="";
  if(ex.cat==="cardio"){
    const cardioEvt=rdOnly?'':` onclick="toggleCardio('${key}','${ex.id}')"`;
    body=`${demo}<div class="cue-box">${cue}</div>
    <div class="action-row"><a class="watch-chip" href="${url}" target="_blank">▶ Watch</a>${!isDone&&!isSkip&&!rdOnly?`<button class="skip-btn" onclick="skipEx('${key}','${ex.id}')">Skip</button>`:""}</div>
    <div class="sets-wrap"><div class="cardio-row ${isDone?"done":""}${rdOnly?" style='cursor:default'":""}"${cardioEvt}><div class="cardio-dur">${reps}</div><div class="cardio-chk">${isDone?"✓":"○"}</div></div></div>`;
  } else {
    const cnt=setCount(ex,ed);
    const exUnit=getExUnit(key,ex.id);
    let rows=`<div class="set-hdr"><div>Set</div><div><button class="unit-chip ${rdOnly?"":"tappable"}" ${rdOnly?"disabled":""} onclick="toggleExUnit('${key}','${ex.id}')">${exUnit}</button></div><div></div><div>Reps</div><div></div><div></div></div>`;
    const lastSetsForCarry=lastSessionEx(ex.id);
    for(let i=0;i<cnt;i++){
      const sd=(ed.sets||[])[i]||{};
      const hasD=sd.weight&&sd.reps;
      const rCls=sd.done?"done":(!hasD&&sd.attempted?"needs-input":"");
      // Carry-forward: pre-populate weight from last session if not yet set
      let weightVal=sd.weight;
      if(!weightVal&&lastSetsForCarry&&!rdOnly){
        const lastSet=lastSetsForCarry.sets[i]||lastSetsForCarry.sets[0];
        if(lastSet&&lastSet.weight){weightVal=parseFloat(lastSet.weight)||"";}
      }
      rows+=`<div class="set-row ${rCls}" id="sr-${ex.id}-${i}">
        <div class="sn">${i+1}</div>
        <input id="wi-${ex.id}-${i}" class="si" type="number" inputmode="decimal" enterkeyhint="next" placeholder="${hintDisp(hint,exUnit)||exUnit}" value="${esc(String(weightVal||""))}" ${rdOnly?'disabled':''} onchange="saveF('${key}','${ex.id}',${i},'weight',this.value)" oninput="prHint('${ex.id}',${i})" onkeydown="onWtKey(event,'${ex.id}',${i})" onfocus="this.select()">
        <div class="sx">×</div>
        <input id="ri-${ex.id}-${i}" class="si" type="number" inputmode="numeric" enterkeyhint="done" placeholder="${typeof ex.reps==="number"?ex.reps:"-"}" value="${esc(String(sd.reps||""))}" ${rdOnly?'disabled':''} onchange="saveF('${key}','${ex.id}',${i},'reps',this.value)" oninput="prHint('${ex.id}',${i})" onkeydown="onRpKey(event)" onfocus="this.select()">
        <button class="sdone ${sd.done?"done":""} ${!hasD?"locked":""}" ${rdOnly?'disabled':''} onclick="toggleSet('${key}','${ex.id}',${i})" title="${!hasD?"Enter weight and reps first":"Done"}">${sd.done?"✓":"○"}</button>
        ${rdOnly?'<div></div>':`<button class="sdel" onclick="delSet('${key}','${ex.id}',${i})" aria-label="Delete set ${i+1}" title="Delete set ${i+1}">${icon("trash",15)}</button>`}
      </div><div id="pr-hint-${ex.id}-${i}" style="font-size:10px;min-height:14px;margin:-4px 0 4px;padding-right:4px;text-align:right;transition:color .2s"></div>`;
    }
    body=`${demo}<div class="cue-box">${cue}</div>
    <div class="action-row"><a class="watch-chip" href="${url}" target="_blank">▶ Watch</a>${!isDone&&!isSkip&&!rdOnly?`<button class="skip-btn" onclick="skipEx('${key}','${ex.id}')">Skip</button>`:""}</div>
    <div class="sets-wrap">${rows}${!rdOnly?`<button class="add-set-btn" onclick="addSet('${key}','${ex.id}')">+ Add Set</button>`:""}</div>`;
  }

  return `<div class="ex-card ${cls}${isActive?" active-card":""}" id="ex-${ex.id}">
    <div class="ex-top" onclick="expand('${ex.id}')">
      <div class="ex-icon ${iconCls}">${icon(iconCls)}</div>
      <div class="ex-info"><div class="ex-name">${isSkip?"⊘ ":isDone?"✓ ":""}${name}${olBadge}</div><div class="ex-meta">${esc(sLbl)} · ${hint}${ex.ss?' · <span class="ss-chip">'+icon("bolt",11)+"superset</span>":""}</div>${ghostHtml}${(()=>{const pr=bestPR(ex.id);return pr?`<div class="pr-badge">PR: ${pr.est}kg est. 1RM (${pr.weight}kg×${pr.reps})</div>`:"";})()}</div>
      <div class="ex-right">${ex.custom&&!rdOnly?`<button class="ex-del" onclick="event.stopPropagation();removeCustomEx('${key.split("_")[0]}','${ex.id}')" title="Remove this exercise" aria-label="Remove ${esc(ex.name)}">${icon("trash",15)}</button>`:""}<div class="ex-chev" id="chev-${ex.id}">▾</div></div>
    </div>
    <div class="sets-body" id="sb-${ex.id}">${body}</div>
  </div>`;
}

function expand(id){
  const body=document.getElementById("sb-"+id);
  const chev=document.getElementById("chev-"+id);
  const card=document.getElementById("ex-"+id);
  const open=body.classList.toggle("open");
  chev.classList.toggle("open",open);
  card.classList.toggle("active-card",open&&!card.classList.contains("done")&&!card.classList.contains("skipped"));
  const wrap=body.querySelector(".demo-wrap[data-demo-name]");
  if(wrap&&open)resolveDemo(wrap);
  const vid=body.querySelector(".demo-wrap video");
  if(vid){if(open)vid.play().catch(()=>{});else vid.pause();}
}

// How many set rows this exercise has in THIS session.
//
// Defaults to max(programmed, logged) so untouched exercises behave exactly as
// before. Once the user adds or deletes a set we store an explicit `nSets`
// override on the session entry, because Math.max alone can only ever grow:
// without the override, deleting a programmed set would splice the array but
// the row would immediately reappear from ex.sets. Sessions saved before this
// existed have no nSets and fall through to the old behaviour.
function setCount(ex,ed){
  if(ed&&ed.nSets!=null)return ed.nSets;
  return Math.max(ex.sets,(ed?.sets||[]).length);
}

function ensure(key,exId,i){
  const S=ctx.getS();
  if(!S.sessions[key])S.sessions[key]={};
  if(!S.sessions[key][exId])S.sessions[key][exId]={done:false,sets:[],skipped:false};
  while(S.sessions[key][exId].sets.length<=i)S.sessions[key][exId].sets.push({});
}

function onWtKey(e,exId,i){if(e.key==="Enter"){e.preventDefault();const r=document.getElementById("ri-"+exId+"-"+i);if(r)r.focus();}}
function onRpKey(e){if(e.key==="Enter"){e.preventDefault();document.activeElement.blur();}}

function saveF(key,exId,i,field,val){
  const S=ctx.getS();
  if(ctx.isReadOnly(key))return;
  ensure(key,exId,i);
  S.sessions[key][exId].sets[i][field]=val;
  S.sessions[key][exId].sets[i].attempted=true;
  updateExerciseDone(key,exId);
  save();queueSession(key,exId);
  // Surgical DOM update only — never replace the card while inputs are focused
  // (replacing destroys inputs and dismisses the iOS keyboard mid-entry).
  const sd=S.sessions[key][exId].sets[i];
  const row=document.getElementById("sr-"+exId+"-"+i);
  if(row){const btn=row.querySelector(".sdone");const hasD=sd.weight&&sd.reps;if(btn){btn.classList.toggle("locked",!hasD);btn.title=hasD?"Done":"Enter weight and reps first";}}
  // Update progress bar without touching the card
  const prog2=curProg();
  if(prog2){const total=prog2.exercises.length;const done=prog2.exercises.filter(e=>(S.sessions[key]||{})[e.id]?.done).length;const pct=total?Math.round((done/total)*100):0;const fill=document.querySelector(".prog-fill");if(fill)fill.style.width=pct+"%";const sub=document.querySelector(".pg-sub");if(sub)sub.textContent=`${prog2.sub} · ${done} of ${total} complete`;}
}

function updateExerciseDone(key,exId){
  const S=ctx.getS();
  const prog=curProg();
  const ex=prog?.exercises.find(e=>e.id===exId);
  const ed=S.sessions[key]?.[exId];
  // Skip cardio (completion is driven by toggleCardio), not "1 set". Warm-up
  // sets are single-set GYM work and must still be able to complete.
  if(!ex||!ed||ex.cat==="cardio")return;
  const n=setCount(ex,ed);
  ed.sets.forEach(s=>{if(!s.weight||!s.reps)s.done=false;});
  ed.done=ed.sets.length>=n&&ed.sets.slice(0,n).every(s=>s.weight&&s.reps&&s.done);
}

function toggleSet(key,exId,i){
  const S=ctx.getS();
  if(ctx.isReadOnly(key))return;
  ensure(key,exId,i);
  const sd=S.sessions[key][exId].sets[i];
  if(!sd.weight||!sd.reps){showToast("Enter weight and reps first");return;}
  sd.done=!sd.done;sd.attempted=true;
  const prog=curProg();
  const ex=prog.exercises.find(e=>e.id===exId)||{sets:1};
  const ed=S.sessions[key][exId];
  updateExerciseDone(key,exId);
  if(sd.done){showToast("Set logged ✓");checkAndStorePR(exId,Number(sd.weight),Number(sd.reps));}
  if(ed.done)showToast("Exercise complete 🔥");
  if(navigator.vibrate)navigator.vibrate(sd.done?[30]:[15]);
  if(sd.done)startRest(ex.rest);
  save();queueSession(key,exId);if(sd.done)checkMilestones();reCard(key,exId);
}

function toggleCardio(key,exId){
  const S=ctx.getS();
  if(ctx.isReadOnly(key))return;
  if(!S.sessions[key])S.sessions[key]={};
  if(!S.sessions[key][exId])S.sessions[key][exId]={done:false,sets:[],skipped:false};
  S.sessions[key][exId].done=!S.sessions[key][exId].done;
  if(S.sessions[key][exId].done)showToast("Done ✓");
  if(navigator.vibrate)navigator.vibrate([25]);
  save();queueSession(key,exId);renderW();
}

function skipEx(key,exId){
  const S=ctx.getS();
  if(ctx.isReadOnly(key))return;
  if(!S.sessions[key])S.sessions[key]={};
  if(!S.sessions[key][exId])S.sessions[key][exId]={done:false,sets:[],skipped:false};
  S.sessions[key][exId].skipped=true;
  save();queueSession(key,exId);showToast("Exercise skipped");renderW();
  setTimeout(()=>{const b=document.getElementById("sb-"+exId);if(b)b.classList.add("open");const c=document.getElementById("chev-"+exId);if(c)c.classList.add("open");},20);
}

// Keep the expanded card open across the re-render that add/delete triggers.
function reopenEx(exId){
  setTimeout(()=>{const b=document.getElementById("sb-"+exId);if(b)b.classList.add("open");const c=document.getElementById("chev-"+exId);if(c)c.classList.add("open");},20);
}

function exById(exId){
  return curProg()?.exercises.find(e=>e.id===exId);
}

// Marks the VIEWED day trained without needing every exercise ticked. Stored as
// session meta alongside _stopped and _notes, and read by trainedOn(), so it
// holds the streak too.
function toggleDayComplete(){
  const S=ctx.getS();
  const key=ctx.sk(ctx.cDay);
  if(ctx.isReadOnly(key)&&!ctx.unlocked[key])return;
  if(!S.sessions[key])S.sessions[key]={};
  const now=!S.sessions[key]._complete;
  if(now)S.sessions[key]._complete=true;else delete S.sessions[key]._complete;
  save();queueSessionMeta(key);renderW();
  showToast(now?"Day marked complete":"Completion removed");
}

function addSet(key,exId){
  if(ctx.isReadOnly(key))return;
  ensure(key,exId,0);
  const S=ctx.getS();
  const ed=S.sessions[key][exId];
  const ex=exById(exId);
  if(!ex)return;
  // Bump the override, don't push a blank entry. nSets is what drives the row
  // count now, and the sets array is filled lazily by ensure() on first input,
  // so pushing here would only create a phantom entry that makes sets.length
  // disagree with the visible row count.
  ed.nSets=setCount(ex,ed)+1;
  save();queueSession(key,exId);renderW();
  reopenEx(exId);
}

// Removes the PR entry a specific set produced, matched on the same weight and
// reps that generated it. Deliberately narrow: only an exact match is removed,
// so an identical lift logged on another day keeps its record.
// ISO date for a session key like "Monday_2026W31", so a PR recovered from the
// log carries the date it was actually lifted.
function sessionKeyToIso(key){
  const m=/^([A-Za-z]+)_(\d{4})W(\d+)$/.exec(key);
  if(!m)return null;
  const di=DAYS.indexOf(m[1]);
  if(di<0)return null;
  const yr=+m[2],wn=+m[3];
  const jan1=new Date(yr,0,1),dow=jan1.getDay()||7;
  const mon=new Date(yr,0,1+(wn-1)*7-(dow-1));
  mon.setDate(mon.getDate()+di);
  return isoDate(mon);
}

// The true best for an exercise, read back out of every logged session.
//
// Needed because checkAndStorePR only writes when you BEAT the current best.
// While a bogus PR stands, every real lift underneath it is silently discarded,
// so simply deleting the bad entry would drop you back to whatever preceded the
// mistake and ignore everything you have actually lifted since. Sessions are
// never pruned, so the log is the reliable source.
function bestFromSessions(cid){
  const S=ctx.getS();
  let best=null;
  for(const[key,sess]of Object.entries(S.sessions||{})){
    if(!sess||typeof sess!=="object")continue;
    for(const[exId,ed]of Object.entries(sess)){
      if(!ed||typeof ed!=="object"||exId.startsWith("_"))continue;
      if(canonicalId(exId)!==cid)continue;
      for(const st of(ed.sets||[])){
        if(!st||!st.done||!st.weight||!st.reps)continue;
        const w=Number(st.weight),r=Number(st.reps);
        if(!w||!r||r>30)continue;
        const est=epley1RM(w,r);
        if(!best||est>best.est)best={date:sessionKeyToIso(key)||isoToday(),weight:w,reps:r,est};
      }
    }
  }
  return best;
}

// After removing a bad entry, put back the best real lift the log can prove,
// if it beats what is left in the stored history.
function recoverPRFromLog(cid){
  const S=ctx.getS();
  const found=bestFromSessions(cid);
  if(!found)return null;
  const list=S.prs[cid]||[];
  const cur=list.reduce((b,e)=>!b||e.est>b.est?e:b,null);
  if(cur&&cur.est>=found.est)return cur;
  if(!S.prs[cid])S.prs[cid]=[];
  S.prs[cid].push(found);
  queueMutation("pr",{exerciseId:cid,date:found.date,weight:found.weight,reps:found.reps,est:found.est});
  return found;
}
ctx.recoverPRFromLog=recoverPRFromLog;

function dropPRForSet(exId,weight,reps){
  const S=ctx.getS();
  const cid=canonicalId(exId);
  const list=S.prs?.[cid];
  if(!list||!list.length)return;
  const w=Number(weight),r=Number(reps);
  const idx=list.findIndex(e=>Number(e.weight)===w&&Number(e.reps)===r);
  if(idx<0)return;
  const gone=list[idx];
  list.splice(idx,1);
  if(!list.length)delete S.prs[cid];
  queueMutation("pr_delete",{exerciseId:cid,date:gone.date,est:gone.est});
  const next=recoverPRFromLog(cid)||(S.prs[cid]||[]).reduce((b,e)=>!b||e.est>b.est?e:b,null);
  showToast(next?`PR removed · now ${next.est}kg`:"PR removed with the set");
}

function delSet(key,exId,i){
  if(ctx.isReadOnly(key))return;
  const S=ctx.getS();
  const ed=S.sessions[key]?.[exId];
  const ex=exById(exId);
  if(!ed||!ex)return;
  const n=setCount(ex,ed);
  // An exercise with no sets has no way back to a set UI, so keep the floor at
  // one. Use Skip if you're not doing the exercise at all.
  if(n<=1){showToast("Keep at least one set · use Skip instead");return;}
  const sd=ed.sets[i];
  // Silent on empty rows; confirm only when there's logged data to lose. The
  // app has no undo, so a destructive action on real data needs a beat.
  if(sd&&(sd.weight||sd.reps)&&!confirm(`Delete set ${i+1}? Logged data for this set will be lost.`))return;
  // A PR is written when a set is logged but S.prs is append-only, so deleting
  // the set used to leave the record behind. That is how a mistyped weight
  // became a permanent PR. Drop any entry this exact set produced.
  if(sd&&sd.weight&&sd.reps)dropPRForSet(exId,sd.weight,sd.reps);
  if(i<ed.sets.length)ed.sets.splice(i,1);
  ed.nSets=n-1;
  updateExerciseDone(key,exId);
  save();queueSession(key,exId);renderW();
  reopenEx(exId);
  showToast("Set removed");
}

function reCard(key,exId){
  const S=ctx.getS();
  const active=document.activeElement;
  if(active&&(active.tagName==="INPUT"||active.tagName==="TEXTAREA")&&document.getElementById("ex-"+exId)?.contains(active))return;
  const prog=curProg();
  const ex=prog.exercises.find(e=>e.id===exId);
  if(!ex){renderW();return;}
  const sess=S.sessions[key]||{};
  const wasOpen=document.getElementById("sb-"+exId)?.classList.contains("open");
  const tmp=document.createElement("div");
  tmp.innerHTML=card(ex,sess,key);
  const old=document.getElementById("ex-"+exId);
  if(old){old.replaceWith(tmp.firstElementChild);}
  if(wasOpen){
    const b=document.getElementById("sb-"+exId);if(b)b.classList.add("open");
    const c=document.getElementById("chev-"+exId);if(c)c.classList.add("open");
    const cd=document.getElementById("ex-"+exId);
    if(cd&&!cd.classList.contains("done")&&!cd.classList.contains("skipped"))cd.classList.add("active-card");
  }
  const prog2=curProg();
  const total=prog2.exercises.length;
  const done=prog2.exercises.filter(e=>(S.sessions[key]||{})[e.id]?.done).length;
  const pct=total?Math.round((done/total)*100):0;
  const fill=document.querySelector(".prog-fill");if(fill)fill.style.width=pct+"%";
  const sub=document.querySelector(".pg-sub");if(sub)sub.textContent=`${prog2.sub} · ${done} of ${total} complete`;
}

// Custom exercise
function toggleCF(){
  const f=document.getElementById("cf");
  f.classList.toggle("open");
  if(f.classList.contains("open"))document.getElementById("cfSearch").focus();
}

function scoreEx(e,ql){
  const nameLow=e.name.toLowerCase();
  const catLow=e.cat.toLowerCase();
  const allText=[nameLow,catLow,...(e.muscles||[]),...(e.tags||[])].join(" ");
  if(nameLow===ql)return 100;
  if(nameLow.startsWith(ql))return 85;
  if(nameLow.includes(ql))return 70;
  if(catLow===ql)return 65;
  const tokens=ql.split(/\s+/).filter(Boolean);
  if(tokens.length>1){
    if(tokens.every(t=>nameLow.includes(t)))return 60;
    if(tokens.every(t=>allText.includes(t)))return 45;
    const matched=tokens.filter(t=>allText.includes(t)).length;
    if(matched>0)return Math.round(25*matched/tokens.length);
  }else{
    if(allText.includes(ql))return 40;
  }
  return 0;
}

function searchEx(q,day){
  const dd=document.getElementById("cfDD");
  if(!q||q.length<1){dd.classList.remove("show");dd.innerHTML="";return;}
  const ql=q.toLowerCase().trim();
  const d=esc(day||ctx.cDay);
  const results=EX_DB
    .map((e,i)=>({e,i,score:scoreEx(e,ql)}))
    .filter(x=>x.score>0)
    .sort((a,b)=>b.score-a.score)
    .slice(0,8);
  if(!results.length){
    const banned=ctx.isBannedExercise(q);
    const warn=banned?`<div class="dd-warn">${icon("alert",18)} Not spine-safe. Tap for an AI-suggested safe swap</div>`:"";
    const btn=banned
      ?`<button class="dd-add-btn dd-alt-btn" data-action="suggestalt" data-kind="free" data-day="${d}">AI Alt</button>`
      :`<button class="dd-add-btn" data-action="freeform" data-day="${d}" data-q="${esc(q)}">Add</button>`;
    dd.innerHTML=`<div class="dd-item" id="dd-row-free"><div class="dd-item-left"><div class="dd-name" style="color:var(--dim)">No matches · tap below to add "${esc(q)}" anyway</div>${warn}</div>${btn}</div>`;
    dd.dataset.r=JSON.stringify([]);dd.classList.add("show");return;
  }
  dd.innerHTML=results.map(({e},idx)=>{
    const banned=ctx.isBannedExercise(e.name);
    const btn=banned
      ?`<button class="dd-add-btn dd-alt-btn" data-action="suggestalt" data-kind="db" data-idx="${idx}" data-day="${d}">AI Alt</button>`
      :`<button class="dd-add-btn" data-action="fromdb" data-idx="${idx}" data-day="${d}">+</button>`;
    return`<div class="dd-item" id="dd-row-${idx}">
    <div class="dd-item-left">
      <div class="dd-name">${esc(e.name)}</div>
      <div class="dd-cat">${esc(e.cat)}${e.muscles?.length?" · "+esc(e.muscles.slice(0,2).join(", ")):""}</div>
      ${banned?`<div class="dd-warn">${icon("alert",18)} Not spine-safe. Tap for an AI-suggested safe swap</div>`:""}
    </div>
    ${btn}
  </div>`;}).join("");
  dd.dataset.r=JSON.stringify(results.map(({e})=>e));dd.classList.add("show");
}

// AI-suggested safe swap when a search hit is blocked by spine-safety rules.
// Single-slot pending state is fine — only one suggestion flow is ever active
// in the dropdown at a time.
let _pendingAlt=null;
async function suggestSafeAlt(kind,day,idx){
  const rowId=kind==="db"?"dd-row-"+idx:"dd-row-free";
  const row=document.getElementById(rowId);
  let exerciseName,muscles=[],cat="gym";
  if(kind==="db"){
    const res=JSON.parse(document.getElementById("cfDD").dataset.r||"[]");
    const base=res[idx];
    if(!base)return;
    exerciseName=base.name;muscles=base.muscles||[];cat=base.cat?.toLowerCase()||"gym";
  }else{
    exerciseName=(document.getElementById("cfSearch")?.value||"").trim();
    if(!exerciseName)return;
  }
  if(row)row.innerHTML=`<div class="dd-item-left"><div class="dd-name" style="color:var(--dim)">Finding a safe alternative…</div></div>`;
  try{
    const r=await fetchT(API_CFG.baseUrl+"/api/suggest-alt",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},body:JSON.stringify({exerciseName,muscles,cat})},60000);
    const d=await r.json();
    if(!r.ok||!d.name){
      if(row)row.innerHTML=`<div class="dd-item-left"><div class="dd-name" style="color:var(--red)">Couldn't find a safe alternative · try a different search</div></div>`;
      return;
    }
    _pendingAlt={...d,day};
    if(row)row.innerHTML=`<div class="dd-item-left"><div class="dd-name">✓ ${esc(d.name)}</div><div class="dd-cat">${esc(d.cat)}${d.muscles?.length?" · "+esc(d.muscles.slice(0,2).join(", ")):""} · AI-suggested safe swap</div></div><button class="dd-add-btn" data-action="fromalt" data-day="${esc(day)}">+</button>`;
  }catch(e){
    if(row)row.innerHTML=`<div class="dd-item-left"><div class="dd-name" style="color:var(--red)">Network error · try again</div></div>`;
  }
}

function addFromDB(i,day){
  const S=ctx.getS();
  const res=JSON.parse(document.getElementById("cfDD").dataset.r||"[]");
  const base=res[i];
  if(!base||!PROG[day])return;
  if(ctx.isBannedExercise(base.name)){suggestSafeAlt("db",day,i);return;}
  const sessKey=day+"_"+ctx.wk();
  const ex={id:"c_"+Date.now(),name:base.name,cat:base.cat?.toLowerCase()||"gym",sets:base.sets||3,reps:base.reps||12,hint:base.hint||"",url:base.url||"",cue:base.cue||"Focus on controlled movement.",custom:true};
  PROG[day].exercises.push(ex);
  ctx.rememberCustom(day,ex);
  if(!S.sessions[sessKey])S.sessions[sessKey]={};
  afterCustomAdd(day,ex,base.name);
}

function addFreeform(day,name){
  const S=ctx.getS();
  if(!PROG[day])return;
  name=String(name||"").trim();
  if(!name)return;
  if(ctx.isBannedExercise(name)){suggestSafeAlt("free",day);return;}
  const sessKey=day+"_"+ctx.wk();
  const ex={id:"c_"+Date.now(),name,cat:"gym",sets:3,reps:12,hint:"kg",url:"",cue:"Focus on controlled movement. Core braced throughout.",custom:true};
  PROG[day].exercises.push(ex);
  ctx.rememberCustom(day,ex);
  if(!S.sessions[sessKey])S.sessions[sessKey]={};
  afterCustomAdd(day,ex,name);
}

function addFromAlt(day){
  const S=ctx.getS();
  const alt=_pendingAlt;
  if(!alt||!PROG[day])return;
  const sessKey=day+"_"+ctx.wk();
  const ex={id:"c_"+Date.now(),name:alt.name,cat:alt.cat||"gym",sets:alt.sets||3,reps:alt.reps||12,hint:alt.hint||"",url:"",cue:alt.cue||"Focus on controlled movement.",muscles:alt.muscles||[],custom:true};
  PROG[day].exercises.push(ex);
  ctx.rememberCustom(day,ex);
  if(!S.sessions[sessKey])S.sessions[sessKey]={};
  _pendingAlt=null;
  afterCustomAdd(day,ex,ex.name);
}

// Adding an exercise makes the session longer, which on six training days a
// week and a hard deficit is the wrong direction. Offer to drop one thing in
// exchange. Declining is one tap and costs nothing.
function offerSwapOut(day,addedId){
  const prog=PROG[day];
  if(!prog)return;
  const cands=prog.exercises.filter(e=>e.id!==addedId&&e.cat==="gym"&&!/^Warm-Up/.test(e.name));
  if(!cands.length)return;
  const m=document.getElementById("swapModal");
  if(!m)return;
  m.dataset.day=day;
  document.getElementById("swapList").innerHTML=cands.map(e=>
    `<button class="swap-item" data-action="swapdrop" data-drop="${esc(e.id)}">
      <span class="swap-name">${esc(e.name)}</span>
      <span class="swap-meta">${esc(String(e.sets))} x ${esc(String(e.reps))}${e.hint?" · "+esc(e.hint):""}</span>
    </button>`).join("");
  m.classList.add("show");
}
function closeSwap(){const m=document.getElementById("swapModal");if(m)m.classList.remove("show");}
function dropForSwap(id){
  const S=ctx.getS();
  const day=document.getElementById("swapModal")?.dataset.day;
  if(!day||!PROG[day])return;
  const ex=PROG[day].exercises.find(e=>e.id===id);
  if(!S.dropped)S.dropped={};
  if(!S.dropped[day])S.dropped[day]=[];
  if(!S.dropped[day].includes(id))S.dropped[day].push(id);
  queueMutation("dropped_exercise",{id,dayName:day});
  // A custom exercise the user drops is gone outright, not remembered and
  // re-hydrated on the next load. It also has to be deleted server-side, or
  // the next sync replaces state wholesale and brings it straight back.
  if(S.custom&&S.custom[day]&&S.custom[day].some(e=>e.id===id)){
    S.custom[day]=S.custom[day].filter(e=>e.id!==id);
    queueMutation("custom_exercise_delete",{id});
  }
  PROG[day].exercises=PROG[day].exercises.filter(e=>e.id!==id);
  save();closeSwap();
  showToast((ex?ex.name:"Exercise")+" removed from "+day);
  renderW();
}
// A custom exercise could previously only be removed by adding another one and
// using the swap sheet, so anything added by mistake was stranded on that day
// forever. This is the direct route.
function removeCustomEx(day,id){
  const S=ctx.getS();
  if(!PROG[day])return;
  const ex=PROG[day].exercises.find(e=>e.id===id);
  if(!ex)return;
  if(!confirm("Remove "+ex.name+" from "+day+"?"))return;
  if(S.custom&&S.custom[day])S.custom[day]=S.custom[day].filter(e=>e.id!==id);
  queueMutation("custom_exercise_delete",{id});
  if(S.dropped&&S.dropped[day])S.dropped[day]=S.dropped[day].filter(x=>x!==id);
  PROG[day].exercises=PROG[day].exercises.filter(e=>e.id!==id);
  save();showToast(ex.name+" removed");
  renderW();
}

function restoreDropped(day,id){
  const S=ctx.getS();
  if(!S.dropped||!S.dropped[day])return;
  S.dropped[day]=S.dropped[day].filter(x=>x!==id);
  queueMutation("dropped_exercise_restore",{id});
  save();
  showToast("Restored · reload to see it");
  renderW();
}

function afterCustomAdd(day,ex,label){
  save();showToast(label+" added ✓");
  const si=document.getElementById("cfSearch");if(si)si.value="";
  document.getElementById("cfDD")?.classList.remove("show");
  renderW();
  offerSwapOut(day,ex.id);
}

function addCustom(key){
  showToast("Use the search above to add exercises");
}

// Session
function startSess(){
  ctx.workoutOn=true;ctx.sessStart=Date.now();
  showToast("Workout started ⚡");
  if(navigator.vibrate)navigator.vibrate([40,20,40]);
  renderW();
}

function stopSess(){
  const S=ctx.getS();
  if(!confirm("Stop workout and save session?"))return;
  ctx.workoutOn=false;clearInterval(ctx.sessTimer);
  const el=Math.floor((Date.now()-ctx.sessStart)/1000);
  const m=Math.floor(el/60),s=el%60;
  const key=ctx.cDay+"_"+ctx.wk(); // always write to current week
  if(!S.sessions[key])S.sessions[key]={};
  S.sessions[key]._duration=(S.sessions[key]._duration||0)+el; // accumulate across resumes
  S.sessions[key]._stopped=true;
  save();queueSessionMeta(key);
  const prog=curProg();
  const setsDone=prog.exercises.reduce((a,ex)=>a+((S.sessions[key]||{})[ex.id]?.sets?.filter(s=>s.done)?.length||0),0);
  document.getElementById("sumDur").textContent=m+"m "+(s<10?"0":"")+s+"s";
  document.getElementById("sumSets").textContent=setsDone;
  document.getElementById("sum").classList.add("show");
  if(navigator.vibrate)navigator.vibrate([80,40,160]);
  ctx.sessStart=null;
}

function resumeSess(){
  const S=ctx.getS();
  const key=ctx.cDay+"_"+ctx.wk();
  if(S.sessions[key]?._stopped){delete S.sessions[key]._stopped;save();queueSessionMeta(key);}
  ctx.workoutOn=true;ctx.sessStart=Date.now();
  showToast("Workout resumed ▶");
  if(navigator.vibrate)navigator.vibrate([40,20,40]);
  renderW();
}

function closeSummary(){
  document.getElementById("sum").classList.remove("show");
  ctx.workoutOn=false;renderW();
}

// AI Coach
async function aiRun(type){
  const S=ctx.getS();
  let prompt="",outId="";
  if(type==="conv"){
    const v=document.getElementById("ci").value.trim();if(!v)return;
    prompt="Convert this workout note into compact structure (Exercise → Sets × Reps @ Weight, max 3 lines): "+v;
    outId="co";
  }else if(type==="overload"){
    const v=document.getElementById("oi").value.trim();if(!v)return;
    prompt="Last session: "+v+"\n\nGive today's exact progressive overload targets in 4 lines max.";
    outId="oo";
  }else if(type==="sub"){
    const v=document.getElementById("si").value.trim();if(!v)return;
    const todayExNames=(curProg()?.exercises||[]).map(e=>e.name||e).join(", ");
    prompt=`Machine busy. The user was about to do: ${v} (includes the weight they planned to use). Today's routine already includes: ${todayExNames||"none"}. Equipment available: ${GYM}. Suggest exactly ONE alternative not already in today's routine, AND the specific starting weight for it, converted sensibly from the weight they stated (account for machine vs cable vs dumbbell loading differences). Format: exercise name, recommended weight, one short sentence why. No lists.`;
    outId="so";
  }else if(type==="calftrend"){
    outId="cto";
    // Collect last 14 days of twinge data
    const now=Date.now();
    const dayMs=86400000;
    const twingeByDay=[];
    for(let d=0;d<14;d++){
      const dayStart=now-(d+1)*dayMs;
      const dayEnd=now-d*dayMs;
      const dayDate=new Date(dayEnd);
      const dayName=dayDate.toLocaleDateString("en-GB",{weekday:"short"})+' '+fmtDate(dayDate.toISOString().slice(0,10));
      let cnt=0;
      for(const[,sessData] of Object.entries(S.sessions||{})){
        const twinges=(sessData._calfTwinges||[]).filter(ts=>Number.isFinite(ts)&&ts>=dayStart&&ts<dayEnd);
        cnt+=twinges.length;
      }
      if(cnt>0)twingeByDay.push({day:dayName,count:cnt});
    }
    if(!twingeByDay.length){
      const outEl=document.getElementById(outId);
      outEl.className="ai-out show";
      outEl.textContent="No twinge data yet · use the calf logger during sessions.";
      return;
    }
    prompt=`Calf twinge data last 14 days: ${twingeByDay.map(d=>`${d.day}: ${d.count}`).join(", ")}. Analyse trend briefly (max 150 words). Is it improving, worsening, or stable?`;
    if(prompt.length>1000)prompt=prompt.slice(0,1000);
  }else if(type==="warmup"){
    outId="wuo";
    // Sanitize inputs
    let exName=(document.getElementById("wuEx").value||"").replace(/[^\x20-\x7E]/g,"").trim().slice(0,60);
    let wt=parseFloat(document.getElementById("wuWt").value)||0;
    wt=Math.max(0,Math.min(500,wt));
    if(!exName||!wt){showToast("Enter exercise name and weight");return;}
    prompt=`Warm-up sets for ${exName} working weight ${wt}kg. Give 4-5 progressive warm-up sets as a compact table (set, weight, reps). Max 120 words.`;
  }else{
    prompt=`Recovery decision request. CPAP: ${document.getElementById("sl")?.value||"?"}/100 Energy: ${document.getElementById("en")?.value||"?"}/10 Soreness: ${document.getElementById("sr")?.value||"?"}/10 Calf: ${document.getElementById("cp")?.value||"none"}. Give: Full / 80% / Light.`;
    outId="ro";
  }
  const out=document.getElementById(outId);
  out.className="ai-out show";
  out.innerHTML='<span class="spin"></span>Thinking...';
  try{
    const r=await fetchT(API_CFG.baseUrl+"/api/coach",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},body:JSON.stringify({prompt,context:{day:ctx.cDay,program:curProg()?.label||""}})},60000);
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Request failed");
    out.innerHTML=d.text?mdLite(d.text):"No response.";
  }catch(e){out.textContent="AI error: "+(e.message||"request failed");}
}

function mondayOf(isoDateStr){
  const d=new Date(isoDateStr+"T12:00:00");
  const dow=d.getDay();
  d.setDate(d.getDate()+(dow===0?-6:1-dow));
  return isoDate(d);
}
function epley1RM(weight,reps){return reps===1?weight:Math.round(weight*(1+reps/30));}
function canonicalId(exId){return ctx._prCanonMap[exId]||exId.replace(/^(?:su2?|sa2?|f2?|th2?|w2?|t2?|m2?)_/,"");}
function bestPR(exId){
  const S=ctx.getS();
  const cid=canonicalId(exId);
  const entries=S.prs[cid]||[];
  if(!entries.length)return null;
  return entries.reduce((best,e)=>e.est>best.est?e:best,entries[0]);
}
function prHint(exId,i){
  const w=parseFloat(document.getElementById("wi-"+exId+"-"+i)?.value);
  const r=parseFloat(document.getElementById("ri-"+exId+"-"+i)?.value);
  const el=document.getElementById("pr-hint-"+exId+"-"+i);
  if(!el)return;
  if(!w||!r||r>30){el.textContent="";return;}
  const est=epley1RM(w,r);
  const prev=bestPR(exId);
  el.innerHTML=prev?(est>prev.est?icon("trophy",15)+' <span>Est. 1RM: '+est+'kg · new PR!</span>':"Est. 1RM: "+est+"kg (PR: "+prev.est+"kg)"):"Est. 1RM: "+est+"kg";
  el.style.color=prev&&est>prev.est?"var(--amber)":"var(--dim)";
}
function checkAndStorePR(exId,weight,reps){
  const S=ctx.getS();
  if(!weight||!reps||reps>30)return;
  const cid=canonicalId(exId);
  const est=epley1RM(weight,reps);
  const prev=bestPR(cid);
  if(!prev||est>prev.est){
    if(!S.prs[cid])S.prs[cid]=[];
    S.prs[cid].push({date:isoToday(),weight,reps,est});
    save();queueMutation("pr",{exerciseId:cid,date:isoToday(),weight,reps,est});
    showToastBig("🏆 New PR! "+est+"kg est. 1RM");
  }
}
// A day the active program schedules nothing for. Right now that's Wednesday
// and Sunday: PROG is PROG_V3 with physio stripped until Aug 11, which leaves
// both days with zero exercises. There is literally nothing to log, so these
// must not count against a streak.
// Caveat: PROG is resolved for TODAY's date, so a streak spanning a program
// change reads the current week's rest days. Every other PROG consumer in the
// app has the same limitation; fixing it properly means date-aware program
// lookup, which is a bigger change than this bug warrants.
function isProgramRestDay(iso){
  const d=new Date(iso+"T12:00:00");
  const day=DAYS[d.getDay()===0?6:d.getDay()-1];
  // programFor(d), not PROG: PROG is a snapshot of TODAY's program, so using it
  // would judge a past date by a schedule that wasn't in force yet.
  return !(programFor(d)[day]?.exercises||[]).length;
}

// Walks back from today and returns both numbers the UI needs:
//   days     — what the badge shows. Rest days COUNT, because resting on a
//              scheduled rest day is following the program, not missing it.
//   sessions — actual workouts in that run, used for milestones so "3 days in
//              a row" can't fire off two workouts plus a rest day.
function currentStreak(){
  const today=isoToday();
  let days=0,sessions=0,pendingRest=0;
  for(let i=0;i<365;i++){
    const d=new Date(today+"T12:00:00");
    d.setDate(d.getDate()-i);
    const iso=isoDate(d);
    if(isProgramRestDay(iso)){
      // Buffered, not counted yet. A rest day may only EXTEND a streak that an
      // older session already established, never start one — otherwise a fresh
      // install would read "1 day streak" just for opening the app on a
      // Wednesday, and a trailing rest day would pad the run by one.
      pendingRest++;
      continue;
    }
    if(ctx.trainedOn(iso)){
      days+=pendingRest+1;pendingRest=0;sessions++;
      continue;
    }
    // Today not being logged yet is an unfinished day, not a broken streak.
    // Without this the badge vanished every morning until the first set.
    if(i===0)continue;
    break;
  }
  return{days,sessions};
}
function checkMilestones(){
  const S=ctx.getS();
  const today=isoToday();
  const wkKey=ctx.wk();
  // ── streak: update longest + fire 3-day toast ──
  const {days:streak,sessions}=currentStreak();
  if(streak>(S.milestones.longestStreak||0)){S.milestones.longestStreak=streak;save();queueMilestones();}
  if(sessions===3)showToastBig("🔥 3 days in a row. You're on a streak!");
  // ── 6 workouts this week (modal) ──
  if(!S.milestones.shownWeek6.includes(wkKey)){
    const mon=mondayOf(today);
    let weekTrains=0;
    for(let i=0;i<7;i++){const d=new Date(today+"T12:00:00");d.setDate(d.getDate()-i);const iso=isoDate(d);if(iso>=mon&&ctx.trainedOn(iso))weekTrains++;}
    if(weekTrains>=6){S.milestones.shownWeek6.push(wkKey);save();queueMilestones();showMilestone("💪","6 Workouts This Week","Elite consistency. Your body is adapting.");}
  }
  // ── Protein 160g+ for 7 consecutive days (modal) ──
  if(!S.milestones.shownProtein7.includes(wkKey)){
    const allHit=Array.from({length:7},(_,i)=>{const d=new Date(today+"T12:00:00");d.setDate(d.getDate()-i);const items=(S.nutrition.days?.[isoDate(d)]||{}).items||[];return items.reduce((s,it)=>s+(it.protein||0),0)>=160;}).every(Boolean);
    if(allHit){S.milestones.shownProtein7.push(wkKey);save();queueMilestones();showMilestone("🥩","7 Days of 160g+ Protein","Consistent fuelling = consistent results.");}
  }
  // ── Every 5 kg weight drop (modal) — uses latest logged weight ──
  const wtEntries=Object.entries(S.nutrition.weights||{}).filter(([,v])=>!isNaN(Number(v)));
  if(wtEntries.length){
    const current=Number(wtEntries.sort(([a],[b])=>b.localeCompare(a))[0][1]);
    for(const t of [90,95,100,105,110,115,120,125,130,135]){
      if(current<=t&&!S.milestones.shownWeight5kg.includes(t)){
        S.milestones.shownWeight5kg.push(t);save();queueMilestones();
        showMilestone("💪",`${t} kg Milestone!`,`You logged ${current.toFixed(1)} kg. Keep pushing.`);
        break;
      }
    }
  }
}

// Expose to ctx for main.js to use
ctx.renderW=renderW;

// window shims for inline onclick= handlers
window.startRest=startRest;
window.skipRest=skipRest;
window.logCalfTwinge=logCalfTwinge;
window.undoCalfTwinge=undoCalfTwinge;
window.saveNotes=saveNotes;
window.expand=expand;
window.saveF=saveF;
window.toggleSet=toggleSet;
window.toggleCardio=toggleCardio;
window.skipEx=skipEx;
window.addSet=addSet;
window.toggleDayComplete=toggleDayComplete;
ctx.currentStreak=currentStreak;
window.delSet=delSet;
window.toggleCF=toggleCF;
window.searchEx=searchEx;
window.addFromDB=addFromDB;
window.addFreeform=addFreeform;
window.addFromAlt=addFromAlt;
window.addCustom=addCustom;
window.closeSwap=closeSwap;
window.dropForSwap=dropForSwap;
window.restoreDropped=restoreDropped;
window.removeCustomEx=removeCustomEx;
window.startSess=startSess;
window.stopSess=stopSess;
window.resumeSess=resumeSess;
window.closeSummary=closeSummary;
window.aiRun=aiRun;
window.scanDemos=scanDemos;
window.prHint=prHint;
window.toggleExUnit=toggleExUnit;
window.onWtKey=onWtKey;
window.onRpKey=onRpKey;
