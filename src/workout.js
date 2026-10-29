import { ctx } from "./runtime.js";
import { isoToday, isoDate, proteinTargetG, phaseFor, phaseActiveTarget, eatKcalFor, activeMult } from "./phase.js";
import { esc, fmtDate, showToast, showToastBig, showMilestone, mdLite, icon } from "./ui.js";
import { save } from "./state.js";
import { API_CFG, queueSession, queueSessionMeta, queueMutation, queueMilestones } from "./sync.js";
import { weekKeyOf, EX_DB, PROG, programFor, PROG_V1, PROG_V2, PROG_V3, PROG_V4, PROG_V5, PROG_V6, PROG_V7, DAYS, GYM } from "./constants.js";

function fetchT(url, opts, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

// ── UNITS · per-exercise label (no conversion, you enter what you see) ──
// An entry's unit is stored on it (ed.unit). Entries with logged weights but no
// unit predate the field and were always kg, so they must keep reading as kg.
// Only a fresh entry takes a default, and ensure() persists it immediately so
// the number typed and the unit it is converted with can never disagree.
function getExUnit(key,exId){
  const ed=ctx.getS().sessions[key]?.[exId];
  if(ed?.unit)return ed.unit;
  if(ed&&(ed.sets||[]).some(s=>s&&s.weight))return "kg";
  return defaultUnit(exId);
}
// New entries start in the unit last used for this exercise, else the unit used
// most overall: the mix-ups came from an exercise silently starting in kg when
// it was always lifted in lbs.
function defaultUnit(exId){
  const S=ctx.getS(),cid=canonicalId(exId);
  let last=null,lastOrd=-1;const count={kg:0,lbs:0};
  for(const[key,sess]of Object.entries(S.sessions||{})){
    if(!sess||typeof sess!=="object")continue;
    const m=key.match(/_(\d{4})W(\d+)$/);const ord=m?+m[1]*100+(+m[2]):0;
    for(const[id,ed]of Object.entries(sess)){
      if(!ed||typeof ed!=="object"||id.startsWith("_")||!(ed.sets||[]).some(s=>s&&s.weight))continue;
      const u=ed.unit==="lbs"?"lbs":"kg";count[u]++;
      if(canonicalId(id)===cid&&ord>lastOrd){lastOrd=ord;last=u;}
    }
  }
  return last||(count.lbs>count.kg?"lbs":"kg");
}
function toggleExUnit(key,exId){
  const S=ctx.getS();
  if(ctx.isReadOnly(key))return;
  if(!S.sessions[key])S.sessions[key]={};
  if(!S.sessions[key][exId])S.sessions[key][exId]={done:false,sets:[],skipped:false};
  S.sessions[key][exId].unit=getExUnit(key,exId)==="kg"?"lbs":"kg";
  save();queueSession(key,exId);reCard(key,exId);
}
// Placeholder for the weight box. The box already prints its unit (.wt-wrap),
// so the hint carries numbers only, converted when the box is in lbs: it used
// to relabel a kg range as lbs ("7-9 lbs" beside LBS) without converting it.
function hintDisp(hint,unit){
  if(!hint)return"";
  const h=String(hint);
  if(!/\bkg\b/i.test(h))return h.replace(/\b(kg|lbs)\b/gi,"").trim();
  const nums=h.replace(/\s*kg\b/gi,"").trim();
  if(unit!=="lbs")return nums;
  return nums.replace(/\d+(?:\.\d+)?/g,n=>String(Math.round(Number(n)/LB_TO_KG)));
}


// ── LAST SESSION HELPER ──
// The most recent earlier session of this exercise. Weights come back in KG
// (kgSets / weight) plus the unit they were typed in, so callers can show them
// in whatever unit the box is in now: "Last: 90kg" was 90 lbs shown as kg.
function lastSessionEx(exId){
  const S=ctx.getS();
  const curKey=ctx.sk(ctx.cDay);
  const sessions=S.sessions||{};
  let best=null;
  // Matched by canonical exercise (name), not the day's id: ids change with the
  // program (m6_ in the deload, m4_ in Southpaw), and "last time I did this"
  // must follow the exercise across that boundary.
  const cid=canonicalId(exId);
  for(const[key,data] of Object.entries(sessions)){
    if(key===curKey||!data||typeof data!=="object")continue;
    const hit=Object.keys(data).find(id=>!id.startsWith("_")&&(id===exId||canonicalId(id)===cid));
    const ed=hit&&data[hit];
    if(!ed||!ed.sets)continue;
    const doneSets=ed.sets.filter(s=>s.done&&s.weight&&s.reps);
    if(!doneSets.length)continue;
    const m=key.match(/_(\d{4})W(\d+)$/);
    if(!m)continue;
    const ord=+m[1]*100+(+m[2]);
    if(!best||ord>best.ord){best={ord,sets:doneSets,unit:ed.unit==="lbs"?"lbs":"kg"};}
  }
  if(!best)return null;
  // raw = the number as typed, so a box in the same unit pre-fills exactly
  // what was lifted instead of a kg round trip.
  const kgSets=best.sets.map(s=>({kg:toKg(s.weight,best.unit),reps:Number(s.reps),raw:s.weight})).filter(s=>s.kg>0);
  if(!kgSets.length)return null;
  const reps=best.sets.map(s=>s.reps).find(r=>r)||"?";
  const avgKg=kgSets.reduce((a,s)=>a+s.kg,0)/kgSets.length;
  // The set to beat: best by estimated 1RM, so weight and reps both count.
  const top=kgSets.reduce((b,s)=>!b||epley1RM(s.kg,s.reps)>epley1RM(b.kg,b.reps)?s:b,null);
  return{weight:avgKg,reps,sets:best.sets,unit:best.unit,kgSets,top};
}
const inUnit=(kg,unit)=>unit==="lbs"?Math.round(kg/LB_TO_KG*10)/10:Math.round(kg*10)/10;
// A weight you can actually load: converting last session's kg to lbs gave
// "145.1". Pre-filled boxes snap to the nearest 2.5 lbs / 0.5 kg.
const inUnitLoadable=(kg,unit)=>unit==="lbs"?Math.round(kg/LB_TO_KG/2.5)*2.5:Math.round(kg*2)/2;
// Best set by estimated 1RM, so weight AND reps count and every set does.
// UNROUNDED Epley for the arrow. epley1RM() rounds to whole kg, which on a
// light lift erases a rep: 14x10 (18.67) and 14x11 (19.13) both became 19 and
// showed "=" for a rep fewer. Stored/displayed PRs still use the rounded one.
const e1rmExact=(kg,r)=>r===1?kg:kg*(1+r/30);
const bestE1RM=sets=>sets.reduce((b,s)=>Math.max(b,s.reps>0&&s.reps<=30?e1rmExact(s.kg,s.reps):0),0);

// ── OVERLOAD DIRECTION ──
function overloadDir(exId,sess){
  const last=lastSessionEx(exId);
  if(!last)return null;
  const ed=sess[exId];
  if(!ed||!ed.sets)return null;
  // Compared on the BEST set's estimated 1RM, in kg. The old version averaged
  // raw weights: it ignored reps, let a light first set drag the average down,
  // and compared lbs to kg, so a PR set could still show a down arrow.
  const unit=ed.unit==="lbs"?"lbs":"kg";
  const cur=ed.sets.filter(s=>s.done&&s.weight&&s.reps).map(s=>({kg:toKg(s.weight,unit),reps:Number(s.reps)})).filter(s=>s.kg>0);
  if(!cur.length)return null;
  const now=bestE1RM(cur),then=bestE1RM(last.kgSets);
  if(!then)return null;
  // Equal only when it really is the same (float noise aside): one rep more or
  // less at the same weight must move the arrow. The old 1% band hid it.
  if(now>then+0.01)return"up";
  if(now<then-0.01)return"down";
  return"eq";
}

// ── CALF LOGGER ──
// Toggles the mandatory-note state in place. renderW() would rebuild the
// textarea and drop focus mid-sentence, which is exactly when this fires.
function refreshNotesRequirement(){
  const S=ctx.getS();
  const sess=S.sessions[ctx.sk(ctx.cDay)]||{};
  const twinges=(sess._calfTwinges||[]).filter(ts=>Number.isFinite(ts)).length;
  const ta=document.getElementById("sessNotes");
  if(!ta)return;
  const filled=!!String(ta.value||"").trim();
  const need=twinges>0&&!filled;
  ta.classList.toggle("needed",need);
  const wrap=ta.closest(".notes-wrap");
  if(!wrap)return;
  const lbl=wrap.querySelector(".notes-label");
  if(lbl){
    let tag=lbl.querySelector(".notes-req");
    if(twinges&&!tag){tag=document.createElement("span");tag.className="notes-req";lbl.appendChild(tag);}
    if(tag){
      if(!twinges)tag.remove();
      else{tag.textContent=need?"required":"noted";tag.classList.toggle("met",!need);}
    }
  }
  let hint=wrap.querySelector(".notes-hint");
  if(need&&!hint){
    hint=document.createElement("div");hint.className="notes-hint";
    wrap.appendChild(hint);
  }
  if(hint){
    if(!need)hint.remove();
    else hint.innerHTML=icon("alert",15)+"You logged "+twinges+" calf twinge"+(twinges===1?"":"s")+". Describe it before stopping the workout.";
  }
  if(twinges)ta.placeholder="What were you doing when the calf twinged? How did it feel?";
}

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
    showToast("Three calf twinges today. Consider stopping.");
    if(navigator.vibrate)navigator.vibrate([100,50,100,50,100]);
  } else {
    
  }
  refreshNotesRequirement();
}
function undoCalfTwinge(){
  const S=ctx.getS();
  const key=ctx.sk(ctx.cDay);
  const arr=S.sessions[key]?._calfTwinges;
  if(!arr||!arr.length){showToast("Nothing to undo");return;}
  arr.pop();
  save();queueSessionMeta(key);
  
  renderW();
  refreshNotesRequirement();
}

// ── VOLUME DATA ──
// Planned sets come from PROG, which applyPlanOverrides() has already
// mutated with this week's AI-generated plan - so planned volume tracks
// the live weekly plan, not the static base program.
function wkForDate(d){
  // Compute the same week key that wk() would return for a given Date object.
  return weekKeyOf(d);
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
    refreshNotesRequirement();
  },500);
}

// The program for the day being VIEWED, not for today. PROG is a snapshot
// resolved at load time, so using it made next week render this week's plan:
// browsing to Aug 3 still showed the V3 return block instead of Southpaw.
function curProg(day){
  const d=day||ctx.cDay,p=programFor(ctx.viewDate())[d];
  // Another week: show the customs actually logged in THAT week, so history
  // stays visible now that customs no longer follow the weekday forever.
  if(!p||!ctx.isPast())return p;
  const ids=new Set(p.exercises.map(e=>e.id));
  const extra=(ctx.customsLoggedIn?.(d,ctx.vwk())||[]).filter(e=>!ids.has(e.id));
  return extra.length?{...p,exercises:[...p.exercises,...extra]}:p;
}

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
    <button class="wk-nav-btn" onclick="shiftWeek(-1)" aria-label="Previous week">‹</button>
    <div class="wk-nav-lbl">${esc(wkLbl)}${(past||future)
      ?`<span class="wk-nav-back" onclick="goCurrentWeek()">Back to this week</span>`
      :`<span class="wk-nav-cur">${esc(_curMonLbl)}</span>`}
    </div>
    <button class="wk-nav-btn" ${canGoForward?'':'disabled'} onclick="shiftWeek(1)" aria-label="Next week">›</button>
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
  // Safari (not the Home Screen app) may evict stored data after 7 days of
  // no use, offline demos included. One quiet line, dismissed for good.
  if(showInstallHint())h=`<div class="install-hint" id="installHint">Add Forge to your Home Screen to keep demos offline.<button onclick="dismissInstallHint()">Dismiss</button></div>`+h;
  if(ctx.isPastDay()){
    h+=lockedPast
      ?`<div class="past-banner lock-banner">${icon("lock",18)} Past day, read-only<button class="edit-pill" onclick="unlockDay()" title="Unlock editing">${icon("pencil",18)}</button></div>`
      :`<div class="past-banner lock-banner" style="color:var(--amber);border-color:var(--amber)">${icon("pencil",18)} Editing past day<button class="edit-pill" onclick="lockDay()" title="Lock editing">${icon("unlock",18)}</button></div>`;
  }
  if(future){
    // Plans are stored under nextWk(); read the same key (vwk() can differ near the Sunday boundary)
    const hasPlan=!!((S.weekPlans||{})[ctx.nextWk()]);
    h+=`<div class="past-banner" style="color:var(--amber);border-color:var(--amber)">Next week preview. ${hasPlan?'Plan queued.':'Default program.'}</div>`;
  }
  h+=`<div class="hero ${heroCls(prog.label)}"${heroStyleAttr(heroCls(prog.label))}>
    <div class="hero-kicker">${esc((()=>{const d=new Date(_vm);d.setDate(d.getDate()+DAYS.indexOf(cDay));return d.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"});})())}</div>
    <div class="hero-title">${esc(prog.label)}</div>${prog.tag?`<div class="hero-tag">${esc(prog.tag)} session</div>`:""}
    ${!total?(()=>{const nx=nextSession();return nx?`<div class="hero-next">
      <span class="hero-next-lbl">Next</span>
      <span class="hero-next-day">${esc(nx.when)}</span>
      <span class="hero-next-ex">${esc(nx.label)}</span>
    </div>`:"";})():""}
    ${future||!total?"":(()=>{
      // Summary as an iOS grouped cell: label above value, no separators.
      const {weeks,thisWeek,need}=currentStreak();const longest=S.milestones.longestStreak||0;
      return `<div class="hero-sum">
        <div><small>Exercises</small><b class="hero-count">${done}<em> of ${total}</em></b></div>
        <div><small>This week</small><b>${thisWeek}<em> of ${need}</em></b></div>
        <div class="hero-streak"><small>Streak</small><b>${weeks}<em> ${weeks===1?"week":"weeks"}</em></b></div>
        <div class="hero-prog"><div class="hero-prog-fill" style="width:${pct}%"></div></div>
      </div>${weeks>=1&&longest>weeks?`<div class="hero-best">Best streak ${longest} weeks.</div>`:""}`;})()}
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
      h+=`<div class="session-bar"><div class="sess-complete">Session complete${manualDone?`<button class="sess-undo" onclick="toggleDayComplete()">Undo</button>`:""}</div></div>`;
    } else if(stopped){
      h+=`<div class="session-bar"><button class="btn-start" onclick="resumeSess()">Resume Workout</button></div>`;
    } else {
      // Build calf twinge button if workout is active
      const twinges=(sess._calfTwinges||[]).filter(ts=>Number.isFinite(ts)).length;
      const calfWarnCls=twinges>=3?" calf-warn":"";
      const calfBtnHtml=ctx.workoutOn?`<button class="calf-btn${calfWarnCls}" id="calfBtn" onclick="logCalfTwinge()">${icon("bolt",18)} Calf twinge<span class="calf-badge">${twinges}</span></button>${twinges>0?`<button class="btn-g" style="padding:8px 12px;font-size:11px" onclick="undoCalfTwinge()">Undo</button>`:""}`:"";
      h+=`<div class="session-bar">
        <button class="btn-start${ctx.workoutOn?" hide":""}" id="bStart" onclick="startSess()">Start Workout</button>
        <button class="btn-stop${ctx.workoutOn?" show":""}" id="bStop" onclick="stopSess()">Stop Workout</button>
        ${calfBtnHtml}
      </div>`;
    }
  }

  if(cDay==="Sunday"){
    h+=`<div class="physio-banner">Rest day. Physio only.</div>`;
  }

  // Late-week planning nudge: Sat/Sun, current week, no plan queued yet
  const _dowNow=new Date().getDay();
  if(!ctx.isPastDay()&&!ctx.isFuture()&&_dowNow===0&&!(S.weekPlans||{})[ctx.nextWk()]){
    h+=`<div class="plan-nudge">
      <div><div class="plan-nudge-ttl">Plan next week</div><div class="plan-nudge-sub">Built from this week's sessions</div></div>
      <button class="btn-o gen-plan-btn" onclick="genWeeklyPlan()" style="flex:0 0 auto;width:auto;padding:10px 16px">Generate</button>
    </div>`;
  }

  if(gymExs.length){h+=`<details class="st-acc" open><summary class="sec" style="padding:12px 16px">${prog.sub.includes("Gym")?"Gym":"Exercises"}</summary>`;gymExs.forEach(ex=>{h+=card(ex,sess,key,readOnly);});h+=`</details>`;}
  if(physioExs.length){h+=`<details class="st-acc" open><summary class="sec" style="padding:12px 16px">Physio on the mat</summary>`;physioExs.forEach(ex=>{h+=card(ex,sess,key,readOnly);});h+=`</details>`;}

  // Show exercises stored under a previous program version (e.g. V2 data visible when V3 is active)
  if(!future){
    const _allExMap={};
    [PROG_V1,PROG_V2,PROG_V3,PROG_V4,PROG_V5,PROG_V6,PROG_V7].forEach(pv=>Object.values(pv).forEach(day=>(day.exercises||[]).forEach(e=>{_allExMap[e.id]=e;})));
    const curIds=new Set(dispExs.map(e=>e.id));
    const orphanEntries=Object.entries(sess).filter(([id,ed])=>!id.startsWith('_')&&!curIds.has(id)&&_allExMap[id]&&ed&&(ed.done||(ed.sets||[]).some(s=>s&&s.done)));
    if(orphanEntries.length){
      h+=`<details class="st-acc" open><summary class="sec" style="padding:12px 16px;color:var(--dim)">Also logged this day</summary>`;
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
            <div class="ex-info"><div class="ex-name">${esc(ex.name)}</div><div class="ex-meta">Previous program, read-only</div></div>
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

  // Session notes. A logged calf twinge makes them mandatory: the twinge count
  // alone records THAT something happened, not what you were doing or how it
  // felt, and that context is the whole point of logging it. Amber, because
  // this is a warning state and nothing else in the app may use amber.
  if(!readOnly){
    const savedNotes=sess._notes||"";
    const twinges=(sess._calfTwinges||[]).filter(ts=>Number.isFinite(ts)).length;
    const needNote=twinges>0&&!savedNotes.trim();
    h+=`<div class="notes-wrap">
      <span class="notes-label">Session Notes${twinges?`<span class="notes-req${needNote?"":" met"}">${needNote?"required":"noted"}</span>`:""}</span>
      <textarea class="notes-area${needNote?" needed":""}" id="sessNotes" placeholder="${twinges?"What were you doing when the calf twinged? How did it feel?":"Notes"}" oninput="saveNotes(this.value)">${esc(savedNotes)}</textarea>
      ${needNote?`<div class="notes-hint">${icon("alert",15)}You logged ${twinges} calf twinge${twinges===1?"":"s"}. Describe it before stopping the workout.</div>`:""}
    </div>`;
  }

  // "How was today?" (user, Oct 28): an AI review of today's session AND
  // today's food. Only on today's own screen (current week, today's weekday):
  // a past day is finished and a future one has nothing to review.
  if(isTodayScreen()){
    const rev=dayReviewGet();
    h+=`<div class="day-review">
      <button class="day-review-btn" id="dayReviewBtn" onclick="reviewToday()">${icon("spark",18)} ${rev?"Review today again":"How was today?"}</button>
      <div class="day-review-out" id="dayReviewOut"${rev?"":" hidden"}>${rev?mdLite(rev.text)+`<div class="day-review-meta">Reviewed at ${new Date(rev.at).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</div>`:""}</div>
    </div>`;
  }

  if(!readOnly)h+=`<div class="custom-wrap">
    <button class="custom-trigger" onclick="toggleCF()">Add Exercise</button>
    <div class="custom-form" id="cf">
      <label class="cf-label">Search exercise library</label>
      <div class="search-wrap">
        <input class="cf-inp" id="cfSearch" placeholder="Type exercise name to search..." oninput="searchEx(this.value,'${cDay}')" autocomplete="off">
        <div class="search-dd" id="cfDD"></div>
      </div>
      <div style="font-size:11px;color:var(--dim);margin-top:8px;letter-spacing:0.2px">Tap + to add it to today.</div>
    </div>
  </div>`;
  h+=`<div style="height:12px"></div>`;
  // .wv scopes the iOS Workout styles (index.html) to this tab only.
  el.innerHTML='<div class="wv">'+h+'</div>';
}
ctx.renderW=renderW;

function showInstallHint(){
  try{if(localStorage.getItem("f5_installHint")==="dismissed")return false;}catch(_){}
  const ios=/iPhone|iPad|iPod/.test(navigator.userAgent||"");
  const standalone=navigator.standalone===true||(window.matchMedia&&matchMedia("(display-mode: standalone)").matches);
  return ios&&!standalone;
}
function dismissInstallHint(){
  try{localStorage.setItem("f5_installHint","dismissed");}catch(_){}
  document.getElementById("installHint")?.remove();
}
window.dismissInstallHint=dismissInstallHint;
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

// Form demos · ALL bundled with the app: demos/map.json + WebP start/end pairs,
// built by scripts/build-demos.mjs from the public-domain free-exercise-db.
// Nothing is fetched from another site, so demos also load offline (sw.js
// caches them). Older builds stored remote MuscleWiki/GitHub URLs in synced
// S.demoCache: never read here, and cleared by the demoCacheV 4 reset in main.js.
let _localDemos=null; // name -> [frame0, frame1]
const _localDemosReady=fetch("demos/map.json").then(r=>r.ok?r.json():null).then(m=>{
  _localDemos=m;
  // Fill any placeholders rendered before the map arrived.
  document.querySelectorAll(".demo-wrap[data-demo-name]").forEach(w=>resolveDemo(w));
}).catch(()=>{});
// A free-typed custom exercise gets the closest BUNDLED demo (same scoring as
// the build script, minus its hand aliases), never a remote one.
const _DEMO_ABBR={db:"dumbbell",bb:"barbell",kb:"kettlebell",sa:"single"};
const _demoToks=s=>String(s).toLowerCase().replace(/warm-up ·/g," ").replace(/[^a-z0-9 ]/g," ").split(/\s+/)
  .map(t=>_DEMO_ABBR[t]||t).filter(t=>t&&!["the","a","with","machine","seated","standing","lying","precor","hoist"].includes(t));
function localFuzzyDemo(name){
  if(!_localDemos)return null;
  const q=_demoToks(name);if(!q.length)return null;
  let best=null,bestScore=0;
  for(const k of Object.keys(_localDemos)){
    const c=_demoToks(k),overlap=q.filter(t=>c.includes(t)).length;
    const score=overlap/Math.max(q.length,c.length)+(overlap===q.length?0.3:0);
    if(score>bestScore){bestScore=score;best=k;}
  }
  return bestScore>=0.75?_localDemos[best]:null;
}
// undefined = map not loaded yet, null = no demo, array = the two frames.
function demoFor(name){
  if(!_localDemos)return undefined;
  const d=_localDemos[name]||localFuzzyDemo(name);
  return Array.isArray(d)?d:null;
}
const _demoFlip=pair=>`<div class="demo-flip"><img src="${pair[0]}" alt="" loading="lazy" onerror="this.closest('.demo-wrap').style.display='none'"><img src="${pair[1]}" alt="" loading="lazy"></div>`;
// "No demo for this one. Works chest and triceps." beats an empty gap.
function noDemoLine(muscles){
  const m=(muscles||[]).filter(Boolean);
  const list=m.length>1?m.slice(0,-1).join(", ")+" and "+m[m.length-1]:m[0];
  return`<div class="demo-none">No demo for this one.${list?" Works "+esc(list)+".":""}</div>`;
}
function demoHtml(name,muscles){
  const d=demoFor(name);
  if(d===undefined)return`<div class="demo-wrap" data-demo-name="${esc(name)}" data-muscles="${esc((muscles||[]).join("|"))}" style="display:none"></div>`;
  return d?`<div class="demo-wrap">${_demoFlip(d)}</div>`:noDemoLine(muscles);
}
async function resolveDemo(wrap){
  const name=wrap.getAttribute("data-demo-name");
  if(!name)return;
  if(!_localDemos)await _localDemosReady;
  if(!_localDemos)return; // map failed to load: leave the card as it is
  wrap.removeAttribute("data-demo-name");
  const d=demoFor(name);
  if(d){wrap.innerHTML=_demoFlip(d);wrap.style.display="";}
  else wrap.outerHTML=noDemoLine((wrap.getAttribute("data-muscles")||"").split("|"));
}

function card(ex,sess,key,rdOnly=false){
  const S=ctx.getS();
  const ed=sess[ex.id]||{done:false,sets:[],skipped:false};
  const isDone=ed.done,isSkip=ed.skipped;
    const iconCls=ex.cat==="physio"?"physio":ex.cat==="cardio"?"cardio":"gym";
  const sLbl=ex.cat==="cardio"?`${ex.reps}`:`${ex.sets} × ${ex.reps}`;
  // Display only: "Warm-Up · Leg Press" stays the stored name (PR history is
  // keyed by a slug of it); the card shows "Leg Press" with a Warm-up label.
  const cls=isSkip?"skipped":isDone?"done":"";
  const isActive=document.getElementById("sb-"+ex.id)?.classList.contains("open");
  // Always use a search link · stored video URLs rot, search never 404s
  const name=esc(ex.name.replace(/^Warm-Up · /,"")),cue=esc(ex.cue),reps=esc(ex.reps);
  // You train for a PR every session, so the suggested weight IS last
  // session's best set; the program's range is only a fallback for an exercise
  // with no history yet.
  const _last=(ex.cat==="gym")?lastSessionEx(ex.id):null;
  const _tUnit=getExUnit(key,ex.id);
  const target=_last?.top?{w:inUnit(_last.top.kg,_tUnit),r:_last.top.reps}:null;
  const url="https://www.youtube.com/results?search_query="+encodeURIComponent(ex.name+" form");
  const demo=demoHtml(ex.name,ex.muscles);

  // Last session ghost
  const lastSess=(ex.sets>1&&ex.cat!=="cardio")?lastSessionEx(ex.id):null;
  const exUnit=getExUnit(key,ex.id);
  const ghostHtml=lastSess?.top?`<div class="last-ghost">Last best: ${inUnit(lastSess.top.kg,exUnit)} ${exUnit} × ${esc(String(lastSess.top.reps))}</div>`:"";

  // Overload badge, in its own span so it can be refreshed in place.
  const olBadge=ex.sets>1?`<span id="ol-${ex.id}">${olBadgeHtml(ex.id,sess)}</span>`:"";

  let body="";
  if(ex.cat==="cardio"){
    const cardioEvt=rdOnly?'':` onclick="toggleCardio('${key}','${ex.id}')"`;
    body=`${demo}<div class="cue-box">${cue}</div>
    <div class="action-row"><a class="watch-chip" href="${url}" target="_blank">Watch form</a>${!isDone&&!isSkip&&!rdOnly?`<button class="skip-btn" onclick="skipEx('${key}','${ex.id}')">Skip</button>`:""}</div>
    <div class="sets-wrap"><div class="cardio-row ${isDone?"done":""}"${rdOnly?' style="cursor:default"':""}${cardioEvt}><div class="cardio-dur">${reps}</div><div class="cardio-chk">${isDone?"✓":"○"}</div></div></div>`;
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
        // Every set starts at last session's best weight: the target is a PR.
        if(lastSetsForCarry.top)weightVal=lastSetsForCarry.unit===exUnit?Number(lastSetsForCarry.top.raw):inUnitLoadable(lastSetsForCarry.top.kg,exUnit);
      }
      rows+=`<div class="set-row ${rCls}" id="sr-${ex.id}-${i}">
        <div class="sn">${i+1}</div>
        <span class="wt-wrap" data-unit="${exUnit}"><input id="wi-${ex.id}-${i}" class="si" type="number" inputmode="decimal" enterkeyhint="next" placeholder="${hintDisp(ex.hint,exUnit)||exUnit}" value="${esc(String(weightVal||""))}" ${rdOnly?'disabled':''} onchange="saveF('${key}','${ex.id}',${i},'weight',this.value)" oninput="prHint('${ex.id}',${i})" onkeydown="onWtKey(event,'${ex.id}',${i})" onfocus="this.select()"></span>
        <div class="sx">×</div>
        <input id="ri-${ex.id}-${i}" class="si" type="number" inputmode="numeric" enterkeyhint="done" placeholder="${typeof ex.reps==="number"?ex.reps:"-"}" value="${esc(String(sd.reps||""))}" ${rdOnly?'disabled':''} onchange="saveF('${key}','${ex.id}',${i},'reps',this.value)" oninput="prHint('${ex.id}',${i})" onkeydown="onRpKey(event)" onfocus="this.select()">
        <button class="sdone ${sd.done?"done":""} ${!hasD?"locked":""}" ${rdOnly?'disabled':''} onclick="toggleSet('${key}','${ex.id}',${i})" title="${!hasD?"Enter weight and reps first":"Done"}">${sd.done?"✓":"○"}</button>
        ${rdOnly?'<div></div>':`<button class="sdel" onclick="delSet('${key}','${ex.id}',${i})" aria-label="Delete set ${i+1}" title="Delete set ${i+1}">${icon("trash",15)}</button>`}
      </div><div id="pr-hint-${ex.id}-${i}" style="font-size:10px;min-height:14px;margin:-4px 0 4px;padding-right:4px;text-align:right;transition:color .2s"></div>`;
    }
    body=`${demo}<div class="cue-box">${cue}</div>
    <div class="action-row"><a class="watch-chip" href="${url}" target="_blank">Watch form</a>${!isDone&&!isSkip&&!rdOnly?`<button class="skip-btn" onclick="skipEx('${key}','${ex.id}')">Skip</button>`:""}</div>
    <div class="sets-wrap">${rows}${!rdOnly?`<button class="add-set-btn" onclick="addSet('${key}','${ex.id}')">Add Set</button>`:""}</div>`;
  }

  return `<div class="ex-card ${cls}${isActive?" active-card":""}" id="ex-${ex.id}">
    <div class="ex-top" onclick="expand('${ex.id}')">
      <div class="ex-icon ${iconCls}">${icon(iconCls)}</div>
      <div class="ex-info"><div class="ex-name">${name}${olBadge}</div><div class="ex-meta">${esc([/^Warm-Up · /.test(ex.name)?"Warm-up":"",sLbl,ex.ss?"superset":"",isSkip?"skipped":""].filter(Boolean).join(", "))}</div>${ghostHtml}${(()=>{const pr=bestPR(ex.id);return pr?`<div class="pr-badge">Best ${pr.weight} kg × ${pr.reps}, est. 1RM ${pr.est} kg</div>`:"";})()}</div>
      <div class="ex-right"><span class="ex-hint">${target?esc(`${target.w} ${_tUnit} × ${target.r}`):esc(ex.hint||"")}</span>${ex.custom&&!rdOnly?`<button class="ex-del" onclick="event.stopPropagation();removeCustomEx('${key.split("_")[0]}','${ex.id}')" title="Remove this exercise" aria-label="Remove ${esc(ex.name)}">${icon("trash",15)}</button>`:""}${isDone?'<span class="ex-done" aria-label="Done"></span>':""}<div class="ex-chev" id="chev-${ex.id}"><svg class="chev-svg" viewBox="0 0 8 14" width="8" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m1 1 6 6-6 6"/></svg></div></div>
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
  const ed=S.sessions[key][exId];
  if(!ed.unit&&!(ed.sets||[]).some(s=>s&&s.weight))ed.unit=defaultUnit(exId);
  while(ed.sets.length<=i)ed.sets.push({});
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
  // Editing a ticked set can change the session's best set.
  refreshOlBadge(key,exId);
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
  // Weight/reps are only committed to session state on input blur (onchange
  // in saveF), but tapping this button directly right after typing both —
  // no Enter pressed, the common path on mobile — can beat that blur to the
  // click. Read what's actually on screen first so the check below can
  // never see state stale relative to what the user visibly typed. Mirror
  // unconditionally, not just when there's a value: backspacing a field to
  // empty and tapping done immediately must invalidate completeness too,
  // not silently keep whatever was committed before.
  const wEl=document.getElementById(`wi-${exId}-${i}`),rEl=document.getElementById(`ri-${exId}-${i}`);
  if(wEl)sd.weight=wEl.value.trim();
  if(rEl)sd.reps=rEl.value.trim();
  if(!sd.weight||!sd.reps){showToast("Enter weight and reps first");return;}
  const prog=curProg();
  const ex=prog.exercises.find(e=>e.id===exId)||{sets:1};
  if(!sd.done&&!sd.unitOk)checkUnitOnLog(key,exId,i,sd,ex,wEl);
  sd.done=!sd.done;sd.attempted=true;
  const ed=S.sessions[key][exId];
  updateExerciseDone(key,exId);
  if(sd.done){checkAndStorePR(exId,Number(sd.weight),Number(sd.reps),getExUnit(key,exId));}
  
  if(navigator.vibrate)navigator.vibrate(sd.done?[30]:[15]);
  // Deferred one tick: an immediate blur here can reflow the viewport
  // mid-render on iOS Safari/standalone PWA (keyboard dismissing) in the
  // same frame as the toast/re-render below, shifting scroll position.
  if(sd.done)requestAnimationFrame(()=>{if(document.activeElement?.blur)document.activeElement.blur();});
  save();queueSession(key,exId);if(sd.done)checkMilestones();reCard(key,exId);
  refreshOlBadge(key,exId);
}

function toggleCardio(key,exId){
  const S=ctx.getS();
  if(ctx.isReadOnly(key))return;
  if(!S.sessions[key])S.sessions[key]={};
  if(!S.sessions[key][exId])S.sessions[key][exId]={done:false,sets:[],skipped:false};
  S.sessions[key][exId].done=!S.sessions[key][exId].done;
  if(S.sessions[key][exId].done)
  if(navigator.vibrate)navigator.vibrate([25]);
  save();queueSession(key,exId);renderW();
}

function skipEx(key,exId){
  const S=ctx.getS();
  if(ctx.isReadOnly(key))return;
  if(!S.sessions[key])S.sessions[key]={};
  if(!S.sessions[key][exId])S.sessions[key][exId]={done:false,sets:[],skipped:false};
  S.sessions[key][exId].skipped=true;
  save();queueSession(key,exId);renderW();
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
export function sessionKeyToIso(key){
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
// PRs are stored in KG, always. The set inputs accept lbs per exercise, and
// every PR path used to take the typed number at face value: 120 lbs logged as
// a 120 kg PR, then rendered "160kg est. 1RM". The unit lives on the session
// entry (ed.unit), so it has to be applied wherever a set becomes a PR.
export const LB_TO_KG=0.45359237;
export function toKg(weight,unit){
  const w=Number(weight);
  if(!Number.isFinite(w))return null;
  return unit==="lbs"?Math.round(w*LB_TO_KG*10)/10:w;
}

function bestFromSessions(cid){
  const S=ctx.getS();
  let best=null;
  for(const[key,sess]of Object.entries(S.sessions||{})){
    if(!sess||typeof sess!=="object")continue;
    for(const[exId,ed]of Object.entries(sess)){
      if(!ed||typeof ed!=="object"||exId.startsWith("_"))continue;
      if(canonicalId(exId)!==cid)continue;
      for(const st of(ed.sets||[])){
        // otherMachine: logged on a different machine (user, Oct 29); kept in
        // the log but never a PR.
        if(!st||!st.done||!st.weight||!st.reps||st.otherMachine)continue;
        const w=toKg(st.weight,ed.unit),r=Number(st.reps);
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

function dropPRForSet(exId,weight,reps,unit){
  const S=ctx.getS();
  const cid=canonicalId(exId);
  const list=S.prs?.[cid];
  if(!list||!list.length)return;
  const w=toKg(weight,unit),r=Number(reps);
  const idx=list.findIndex(e=>Number(e.weight)===w&&Number(e.reps)===r);
  if(idx<0)return;
  const gone=list[idx];
  list.splice(idx,1);
  if(!list.length)delete S.prs[cid];
  queueMutation("pr_delete",{exerciseId:cid,date:gone.date,est:gone.est});
  const next=recoverPRFromLog(cid)||(S.prs[cid]||[]).reduce((b,e)=>!b||e.est>b.est?e:b,null);
  showToast(next?`PR removed. Best is now ${next.weight} kg × ${next.reps}.`:"PR removed with the set.");
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
  if(n<=1){showToast("Keep at least one set. Use Skip instead.");return;}
  const sd=ed.sets[i];
  // Silent on empty rows; confirm only when there's logged data to lose. The
  // app has no undo, so a destructive action on real data needs a beat.
  if(sd&&(sd.weight||sd.reps)&&!confirm(`Delete set ${i+1}? Logged data for this set will be lost.`))return;
  // A PR is written when a set is logged but S.prs is append-only, so deleting
  // the set used to leave the record behind. That is how a mistyped weight
  // became a permanent PR. Drop any entry this exact set produced.
  // Remove the set BEFORE dropping its PR. dropPRForSet recomputes the best
  // remaining lift from the logged sessions, so with the set still present it
  // recovered the very PR it had just deleted and nothing appeared to change.
  const unit=ed.unit;
  if(i<ed.sets.length)ed.sets.splice(i,1);
  ed.nSets=n-1;
  if(sd&&sd.weight&&sd.reps)dropPRForSet(exId,sd.weight,sd.reps,unit);
  updateExerciseDone(key,exId);
  save();queueSession(key,exId);renderW();
  reopenEx(exId);
  
}

function olBadgeHtml(exId,sess){
  const dir=overloadDir(exId,sess);
  return dir==="up"?`<span class="ol-up">↑</span>`:dir==="down"?`<span class="ol-down">↓</span>`:dir==="eq"?`<span class="ol-eq">=</span>`:"";
}
// Refresh just the up/down/equal arrow. reCard() skips the whole card while an
// input inside it has focus (so the iOS keyboard is not dismissed mid-entry),
// and right after ticking a set the box you typed in still has focus, so the
// arrow kept its first-set value: hitting a PR on set 2 or 3 still showed down.
function refreshOlBadge(key,exId){
  const el=document.getElementById("ol-"+exId);
  if(el)el.innerHTML=olBadgeHtml(exId,ctx.getS().sessions[key]||{});
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
      <span class="swap-meta">${esc(String(e.sets))} × ${esc(String(e.reps))}${e.hint?", "+esc(e.hint):""}</span>
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
  // Stamped with this week: a swap is for this week's session, not a
  // permanent edit to the program (see applyDroppedExercises).
  if(!S.droppedWk)S.droppedWk={};
  S.droppedWk[id]=ctx.wk();
  queueMutation("dropped_exercise",{id,dayName:day,weekKey:ctx.wk()});
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
  showToast("Restored. Reload to see it.");
  renderW();
}

function afterCustomAdd(day,ex,label){
  save();
  const si=document.getElementById("cfSearch");if(si)si.value="";
  document.getElementById("cfDD")?.classList.remove("show");
  renderW();
  offerSwapOut(day,ex.id);
}

function addCustom(key){
  showToast("Use the search above to add exercises");
}

// Session
// Persisted so a workout survives iOS unloading the app in the background.
function saveActive(){try{localStorage.setItem("f5_active",JSON.stringify({key:ctx.cDay+"_"+ctx.wk(),start:ctx.sessStart}));}catch(_){}}
function clearActive(){try{localStorage.removeItem("f5_active");}catch(_){}}
function startSess(){
  ctx.workoutOn=true;ctx.sessStart=Date.now();saveActive();
  
  if(navigator.vibrate)navigator.vibrate([40,20,40]);
  renderW();
}

// Apple's workout duration style: "48 min", "1 hr 5 min", never "0m 01s".
function fmtWorkoutDur(sec){
  sec=Math.max(0,Math.floor(Number(sec)||0));
  if(sec<60)return "Under a minute";
  const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60);
  return h?(m?`${h} hr ${m} min`:`${h} hr`):`${m} min`;
}
function openStopSheet(){
  const S=ctx.getS(),m=document.getElementById("stopModal");
  if(!m)return;
  const key=ctx.cDay+"_"+ctx.wk(),sess=S.sessions[key]||{},prog=curProg();
  const el=ctx.sessStart?Math.floor((Date.now()-ctx.sessStart)/1000):0;
  const sets=prog.exercises.reduce((a,ex)=>a+((sess[ex.id]?.sets||[]).filter(s=>s&&s.done).length),0);
  const exDone=prog.exercises.filter(ex=>sess[ex.id]?.done).length;
  const stat=(v,l)=>`<div class="stop-stat"><div class="stop-stat-val">${v}</div><div class="stop-stat-lbl">${l}</div></div>`;
  // Total so far: earlier stretches (before a resume) plus this one.
  document.getElementById("stopStats").innerHTML=stat(fmtWorkoutDur((sess._duration||0)+el),"Time")+stat(sets,"Sets")+stat(`${exDone} of ${prog.exercises.length}`,"Exercises");
  m.classList.add("show");
}
function closeStopSheet(){document.getElementById("stopModal")?.classList.remove("show");}
window.closeStopSheet=closeStopSheet;
function stopSess(confirmed){
  const S=ctx.getS();
  const sKey=ctx.sk(ctx.cDay);
  const sess=S.sessions[sKey]||{};
  // A twinge with no note is the one thing worth blocking on. Written up days
  // later it is unattributable, and attribution is the only reason the twinge
  // button exists.
  if((sess._calfTwinges||[]).filter(ts=>Number.isFinite(ts)).length&&!String(sess._notes||"").trim()){
    showToast("Describe the calf twinge before stopping");
    const ta=document.getElementById("sessNotes");
    if(ta){
      ta.scrollIntoView({behavior:"smooth",block:"center"});
      ta.classList.add("needed");
      setTimeout(()=>ta.focus(),350);
    }
    if(navigator.vibrate)navigator.vibrate([60,40,60]);
    return;
  }
  // A styled sheet instead of the native confirm() (which iOS renders as a
  // plain system box). The sheet's "Finish & save" calls stopSess(true).
  if(confirmed!==true){openStopSheet();return;}
  closeStopSheet();
  ctx.workoutOn=false;clearInterval(ctx.sessTimer);clearActive();
  const el=ctx.sessStart?Math.floor((Date.now()-ctx.sessStart)/1000):0;
  const key=ctx.cDay+"_"+ctx.wk(); // always write to current week
  if(!S.sessions[key])S.sessions[key]={};
  S.sessions[key]._duration=(S.sessions[key]._duration||0)+el; // accumulate across resumes
  S.sessions[key]._stopped=true;
  save();queueSessionMeta(key);
  const prog=curProg();
  const setsDone=prog.exercises.reduce((a,ex)=>a+((S.sessions[key]||{})[ex.id]?.sets?.filter(s=>s.done)?.length||0),0);
  // The whole workout, not just the stretch since the last resume (which
  // read "0m 01s" after resuming a finished session).
  document.getElementById("sumDur").textContent=fmtWorkoutDur(S.sessions[key]._duration);
  document.getElementById("sumSets").textContent=setsDone;
  const exDone=prog.exercises.filter(ex=>(S.sessions[key]||{})[ex.id]?.done).length;
  const sumEx=document.getElementById("sumEx");if(sumEx)sumEx.textContent=`${exDone} of ${prog.exercises.length}`;
  const sumSub=document.getElementById("sumSub");if(sumSub)sumSub.textContent=prog.label||"";
  document.getElementById("sum").classList.add("show");
  if(navigator.vibrate)navigator.vibrate([80,40,160]);
  ctx.sessStart=null;
}

function resumeSess(){
  const S=ctx.getS();
  const key=ctx.cDay+"_"+ctx.wk();
  if(S.sessions[key]?._stopped){delete S.sessions[key]._stopped;save();queueSessionMeta(key);}
  ctx.workoutOn=true;ctx.sessStart=Date.now();saveActive();
  
  if(navigator.vibrate)navigator.vibrate([40,20,40]);
  renderW();
}

function closeSummary(){
  document.getElementById("sum").classList.remove("show");
  ctx.workoutOn=false;clearActive();renderW();
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

// ── "HOW WAS TODAY?" ────────────────────────────────────────────────────────
// Today's screen only. The review is kept on this device for today (shown again
// when you come back) and replaced by the next one; it is advice, not data.
function isTodayScreen(){
  return !ctx.isPast()&&!ctx.isFuture()&&ctx.cDay===DAYS[(new Date().getDay()+6)%7];
}
function dayReviewGet(){
  try{const r=JSON.parse(localStorage.getItem("f5_dayreview")||"null");return r&&r.date===isoToday()?r:null;}catch(_){return null;}
}
// Everything the coach needs about today, as compact facts (no raw food log
// text beyond item names). Exported for the test.
export function buildDayReviewFacts(){
  const S=ctx.getS(),t=isoToday(),prog=curProg(),sess=S.sessions[ctx.sk(ctx.cDay)]||{};
  const fmtSet=(s,u)=>`${s.weight||"?"} ${u} x ${s.reps||"?"}${s.done?"":" (not ticked)"}`;
  const exercises=(prog.exercises||[]).map(ex=>{
    const ed=sess[ex.id]||{},u=ed.unit==="lbs"?"lbs":"kg";
    const last=ex.cat==="gym"?lastSessionEx(ex.id):null;
    return{name:ex.name.replace(/^Warm-Up · /,"Warm-up: "),type:ex.cat,planned:`${ex.sets} x ${ex.reps}`,
      done:!!ed.done,skipped:!!ed.skipped,sets:(ed.sets||[]).filter(s=>s&&(s.weight||s.reps)).map(s=>fmtSet(s,u)),
      lastTimeBest:last?.top?`${Math.round(last.top.kg*10)/10} kg x ${last.top.reps}`:null};
  });
  const prsToday=Object.entries(S.prs||{}).flatMap(([k,a])=>(a||[]).filter(p=>p.date===t).map(p=>`${(ctx.prName?ctx.prName(k):k)}: ${p.weight} kg x ${p.reps}`));
  const nd=S.nutrition?.days?.[t]||{},items=nd.items||[];
  const sum=f=>Math.round(items.reduce((a,i)=>a+(Number(i[f])||0),0));
  const p=phaseFor(t),eaten=sum("kcal"),eatTarget=p?eatKcalFor(p,t):null;
  const activeTarget=p?Math.round(phaseActiveTarget(p,t)+Math.max(0,eaten-eatTarget)/activeMult(t)):null;
  // Derived numbers, computed here so the coach never does arithmetic: how far
  // over/under food is, what protein/active is left, the time, and the week.
  const now=new Date(),hour=now.getHours()+now.getMinutes()/60;
  const kcalLeft=eatTarget!=null?eatTarget-eaten:null;
  const wk=ctx.weekDeficitNow?.();
  const week=wk?{completeDaysCounted:wk.counted,deficitSoFar:Math.round(wk.total),neededSoFar:Math.round(wk.need),
    aheadBy:Math.round(wk.gap),weekNeeds:wk.weekNeed,notEnoughData:!!wk.thin}:null;
  const status={localTime:now.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}),late:hour>=21,
    foodOver:kcalLeft!=null&&kcalLeft<0,kcalOverBy:kcalLeft!=null&&kcalLeft<0?-kcalLeft:0,kcalRoomLeft:kcalLeft!=null&&kcalLeft>0?kcalLeft:0,
    proteinLeftG:Math.max(0,proteinTargetG()-sum("protein")),
    activeLeft:activeTarget!=null?Math.max(0,activeTarget-(Number(nd.active)||0)):null,
    biggestItem:items.slice().sort((a,b)=>(b.kcal||0)-(a.kcal||0))[0]?.name||null,week};
  // Foods the user has eaten before that fit what is left: the coach may only
  // suggest food from this list (familiar items, already sized to the room).
  status.suggestions=!status.foodOver&&status.kcalRoomLeft>=100&&ctx.foodSuggestions
    ?ctx.foodSuggestions(t,status.kcalRoomLeft,status.proteinLeftG).map(s=>`${s.name} (${s.kcal} kcal, ${s.protein} g protein)`):[];
  return{date:t,day:ctx.cDay,session:prog.label||"",sessionType:prog.tag||"",status,
    workout:{started:!!ctx.workoutOn||!!sess._stopped||exercises.some(e=>e.sets.length||e.done),minutes:sess._duration?Math.round(sess._duration/60):null,
      exercises,prsToday,notes:(sess._notes||"").trim()||null,calfTwinges:(sess._calfTwinges||[]).length},
    food:{items:items.map(i=>`${i.name} (${Math.round(i.kcal||0)} kcal, ${Math.round(i.protein||0)} g protein)`),
      kcal:eaten,kcalTarget:eatTarget,proteinG:sum("protein"),proteinTargetG:proteinTargetG(),carbsG:sum("carbs"),fatG:sum("fat"),fibreG:sum("fibre"),sugarG:sum("sugar"),sodiumMg:sum("sodium")},
    activity:{watchActive:Number(nd.active)||0,watchActiveTarget:activeTarget,weighedInToday:S.nutrition?.weights?.[t]!=null}};
}
async function reviewToday(){
  const btn=document.getElementById("dayReviewBtn"),out=document.getElementById("dayReviewOut");
  if(!btn||!out)return;
  btn.disabled=true;out.hidden=false;out.innerHTML='<span class="spin"></span>Looking at today…';
  const facts=buildDayReviewFacts();
  const st=facts.status;
  // The rules come from the user (Oct 28): an over-target day happens; judge
  // it inside the week, never prescribe late-night catch-up cardio, never
  // suggest more food once over, and name the cause with a fix for next time.
  const prompt=`You are the user's calm, practical coach reviewing their day. Goal: 95 kg by Feb 28 2027 on a weekly deficit plan.
Facts (all numbers are already worked out, use them as given): ${JSON.stringify(facts)}

Rules:
- Judge food inside the WEEK, not the day alone. status.week shows the counted days' deficit vs what the plan needed (aheadBy > 0 is ahead). One day over moves the week a little; say what it does to the week in plain numbers.
- ${st.foodOver?`Food is OVER today's target by ${st.kcalOverBy} kcal. Do NOT suggest eating anything more today, not even a protein snack. Treat the protein gap as a note for tomorrow (for example a high-protein breakfast).`:`Food has ${st.kcalRoomLeft} kcal of room left and ${st.proteinLeftG} g protein to go. If you suggest food, it must fit inside that room and close the protein gap. ${st.suggestions.length?`Suggest ONLY from status.suggestions, foods they have eaten before that already fit (name it exactly, e.g. "${st.suggestions[0].replace(/ \(.*$/,"")}"). Never invent a food they have not logged.`:"They have no logged food that fits, so suggest a simple high-protein option in general terms."}`}
- ${st.late?`It is late (${st.localTime}). Do NOT set a calorie-burning target for tonight. At most an optional gentle 10 to 20 minute walk. Spread any shortfall over the next few days instead (for example 100 kcal less a day or a slightly longer walk).`:`There is still time today; any activity suggestion must be realistic for the hours left.`}
- If they went over, name the likely cause (status.biggestItem or the item list) and one specific swap for next time. One short sentence, no guilt, no lecture. Days like this happen.
- Workout: compare logged sets with lastTimeBest, mention PRs in prsToday only if real, call out skipped or unfinished work and calf twinges. Weights falling set to set mean the first set was too heavy.
- Never praise and scold in the same breath, never use the words "disappointing" or "unfortunately".
Write three short parts, plain text, no headings, no em dashes:
1) Workout, one or two sentences.
2) Food, one or two sentences including what it means for the week.
3) "Next:" one or two concrete actions with numbers, for tonight only if it is not late and not over, otherwise for tomorrow.`;
  try{
    const r=await fetchT(API_CFG.baseUrl+"/api/coach",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},body:JSON.stringify({prompt,context:{day:ctx.cDay,program:facts.session}})},60000);
    const d=await r.json();
    if(!r.ok||!d.text)throw new Error(d.error||"failed");
    const rev={date:facts.date,text:d.text,at:Date.now()};
    try{localStorage.setItem("f5_dayreview",JSON.stringify(rev));}catch(_){}
    out.innerHTML=mdLite(d.text)+`<div class="day-review-meta">Reviewed at ${new Date(rev.at).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</div>`;
    btn.innerHTML=`${icon("spark",18)} Review today again`;
  }catch(e){out.textContent="Couldn't reach the coach. Try again in a moment.";}
  btn.disabled=false;
}
window.reviewToday=reviewToday;

function mondayOf(isoDateStr){
  const d=new Date(isoDateStr+"T12:00:00");
  const dow=d.getDay();
  d.setDate(d.getDate()+(dow===0?-6:1-dow));
  return isoDate(d);
}
export function epley1RM(weight,reps){return reps===1?weight:Math.round(weight*(1+reps/30));}
export function canonicalId(exId){return ctx._prCanonMap[exId]||exId.replace(/^(?:su2?|sa2?|f2?|th2?|w2?|t2?|m2?)_/,"");}
function bestPR(exId){
  const S=ctx.getS();
  const cid=canonicalId(exId);
  const entries=S.prs[cid]||[];
  if(!entries.length)return null;
  return entries.reduce((best,e)=>e.est>best.est?e:best,entries[0]);
}
function prHint(exId,i){
  const raw=parseFloat(document.getElementById("wi-"+exId+"-"+i)?.value);
  const r=parseFloat(document.getElementById("ri-"+exId+"-"+i)?.value);
  const el=document.getElementById("pr-hint-"+exId+"-"+i);
  if(!el)return;
  // The typed number is in the exercise's own unit, but the stored PR is kg
  // (always). Without this the hint read 120 lbs as "160kg est. 1RM" and, worse,
  // compared that inflated number against the real kg PR, so it announced a new
  // PR on a lift that was nowhere near one.
  const w=toKg(raw,getExUnit(ctx.sk(ctx.cDay),exId));
  if(!w||!r||r>30){el.textContent="";return;}
  const est=epley1RM(w,r);
  const prev=bestPR(exId);
  el.innerHTML=prev?(est>prev.est?icon("trophy",15)+' <span>Est. 1RM: '+est+'kg · new PR!</span>':"Est. 1RM: "+est+"kg (PR: "+prev.est+"kg)"):"Est. 1RM: "+est+"kg";
  el.style.color=prev&&est>prev.est?"var(--amber)":"var(--dim)";
}
function checkAndStorePR(exId,weight,reps,unit){
  const S=ctx.getS();
  const kg=toKg(weight,unit);
  if(!kg||!reps||reps>30)return;
  const cid=canonicalId(exId);
  // Warm-ups are not PRs (they were, until the Oct 29 audit).
  if(/^warm_up_/.test(cid))return;
  weight=kg;
  const est=epley1RM(weight,reps);
  const prev=bestPR(cid);
  if(!prev||est>prev.est){
    if(!S.prs[cid])S.prs[cid]=[];
    S.prs[cid].push({date:isoToday(),weight,reps,est});
    save();queueMutation("pr",{exerciseId:cid,date:isoToday(),weight,reps,est});
    showToastBig("New best: "+weight+" kg × "+reps);
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
  // No GYM work, not "no exercises": Sunday carries a physio block, and with
  // the old check an unlogged Sunday read as a missed training day, so the
  // streak reset every Monday. Same definition as isGymRestDay().
  return !(programFor(d)[day]?.exercises||[]).some(e=>e.cat==="gym");
}

// The streak counts WEEKS, not days (the user's rule, Oct 2026): a Mon-Sun
// week keeps it alive once it has STREAK_WEEK_MIN trained days. A single
// missed day used to reset weeks of consistency to zero on a 6-day plan.
//   weeks    — completed qualifying weeks in a row, plus this week once it
//              qualifies. The week in progress never breaks the streak: it
//              only counts or doesn't, so the badge can't vanish on Monday.
//   thisWeek — trained days so far this week, need — what this week needs.
// A week the program schedules fewer training days for (a deload) needs only
// as many as it plans, so following the program always keeps the streak.
const STREAK_WEEK_MIN=5;
function shiftIso(iso,n){const d=new Date(iso+"T12:00:00");d.setDate(d.getDate()+n);return isoDate(d);}
function weekTrainCount(mon){
  let n=0,plan=0;
  for(let i=0;i<7;i++){const iso=shiftIso(mon,i);if(!isProgramRestDay(iso))plan++;if(ctx.trainedOn(iso))n++;}
  return{n,need:Math.max(1,Math.min(STREAK_WEEK_MIN,plan))};
}
function weekQualifies(mon){const r=weekTrainCount(mon);return r.n>=r.need;}
function currentStreak(){
  const mon=mondayOf(isoToday());
  const cur=weekTrainCount(mon);
  let weeks=0;
  for(let w=1;w<520&&weekQualifies(shiftIso(mon,-7*w));w++)weeks++;
  if(cur.n>=cur.need)weeks++;
  return{weeks,thisWeek:cur.n,need:cur.need};
}
// Longest run, recomputed from the log rather than accumulated, so the stored
// figure (which used to be in DAYS) is simply replaced by the right one.
function longestWeekStreak(){
  const mon=mondayOf(isoToday());
  let best=0,run=0;
  for(let w=104;w>=0;w--){if(weekQualifies(shiftIso(mon,-7*w))){run++;if(run>best)best=run;}else if(w>0)run=0;}
  return best;
}
function checkMilestones(){
  const S=ctx.getS();
  const today=isoToday();
  const wkKey=ctx.wk();
  // ── streak: update longest + fire 3-day toast ──
  const {weeks,thisWeek,need}=currentStreak();
  const longest=longestWeekStreak();
  if(!ctx.demoStreak&&longest!==(S.milestones.longestStreak||0)){S.milestones.longestStreak=longest;save();queueMilestones();}
  // Once per week, the moment this week starts counting toward the streak.
  if(!ctx.demoStreak&&thisWeek===need){let seen=null;try{seen=localStorage.getItem("f5_streak_toast");}catch(_){}
    if(seen!==wkKey){try{localStorage.setItem("f5_streak_toast",wkKey);}catch(_){}showToastBig(`${need} workouts this week. ${weeks}-week streak.`);}}
  // ── 6 workouts this week (modal) ──
  if(!S.milestones.shownWeek6.includes(wkKey)){
    const mon=mondayOf(today);
    let weekTrains=0;
    for(let i=0;i<7;i++){const d=new Date(today+"T12:00:00");d.setDate(d.getDate()-i);const iso=isoDate(d);if(iso>=mon&&ctx.trainedOn(iso))weekTrains++;}
    if(weekTrains>=6){S.milestones.shownWeek6.push(wkKey);save();queueMilestones();showMilestone("💪","6 Workouts This Week","Elite consistency. Your body is adapting.");}
  }
  // ── Protein target hit for 7 consecutive days (modal) ──
  // Threshold matches the shared proteinTargetG(), not a hardcoded number
  // that used to disagree with the target shown everywhere else in the app.
  if(!S.milestones.shownProtein7.includes(wkKey)){
    const pt=proteinTargetG();
    const allHit=Array.from({length:7},(_,i)=>{const d=new Date(today+"T12:00:00");d.setDate(d.getDate()-i);const items=(S.nutrition.days?.[isoDate(d)]||{}).items||[];return items.reduce((s,it)=>s+(it.protein||0),0)>=pt;}).every(Boolean);
    if(allHit){S.milestones.shownProtein7.push(wkKey);save();queueMilestones();showMilestone("🥩",`7 Days of ${pt}g+ Protein`,"Consistent fuelling = consistent results.");}
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
window.prHint=prHint;
window.toggleExUnit=toggleExUnit;
window.onWtKey=onWtKey;
window.onRpKey=onRpKey;

// ── KG / LBS MIX-UP DETECTION ──
// A weight typed in lbs while the exercise is set to kg is stored as kg, and
// every PR repair trusts the log, so it survived all of them: Leg Extension
// "120 kg x 15" was 120 lbs. 1 lb = 0.4536 kg, so a mix-up moves a number by
// 2.2x. Flag anything 1.8x above the exercise's usual, or below 0.55x of it
// when in lbs mode (kg typed into lbs). The baseline is the LOWER QUARTILE of
// the logged sets, so a run of mis-typed sets cannot drag "usual" up to match.
const UNIT_HI=1.8,UNIT_LO=0.55;
function loggedSetsKg(cid){
  const S=ctx.getS(),out=[];
  for(const[key,sess]of Object.entries(S.sessions||{})){
    if(!sess||typeof sess!=="object")continue;
    for(const[exId,ed]of Object.entries(sess)){
      if(!ed||typeof ed!=="object"||exId.startsWith("_")||canonicalId(exId)!==cid)continue;
      (ed.sets||[]).forEach((st,i)=>{
        if(!st||!st.done||!st.weight||!st.reps)return;
        const kg=toKg(st.weight,ed.unit);
        if(kg>0)out.push({key,exId,i,kg,unit:ed.unit==="lbs"?"lbs":"kg",weight:Number(st.weight),reps:Number(st.reps),ok:!!st.unitOk});
      });
    }
  }
  return out;
}
function usualKg(sets){
  const v=sets.map(s=>s.kg).sort((a,b)=>a-b);
  return v.length>=3?v[Math.floor((v.length-1)*0.25)]:null;
}
function hintMidKg(hint){
  const m=String(hint||"").match(/(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?\s*kg/);
  return m?(m[2]?(+m[1]+ +m[2])/2:+m[1]):null;
}
// "lbs" = typed lbs into a kg entry; "kg" = typed kg into an lbs entry.
export function unitSuspect(kg,unit,usual){
  if(!usual||!kg)return null;
  const r=kg/usual;
  if(unit!=="lbs"&&r>=UNIT_HI)return "lbs";
  if(unit==="lbs"&&r<=UNIT_LO)return "kg";
  return null;
}
const r1=x=>Math.round(x*10)/10;
function checkUnitOnLog(key,exId,i,sd,ex,wEl){
  const cid=canonicalId(exId),unit=getExUnit(key,exId),w=Number(sd.weight);
  const others=loggedSetsKg(cid).filter(s=>!(s.key===key&&s.exId===exId&&s.i===i));
  const usual=usualKg(others)??hintMidKg(ex.hint);
  const kg=toKg(w,unit),sus=unitSuspect(kg,unit,usual);
  if(!sus)return;
  const name=ex.name||"this exercise";
  if(sus==="lbs"){
    const conv=r1(w*LB_TO_KG);
    if(confirm(`${w} kg is much heavier than your usual ~${Math.round(usual)} kg on ${name}.\n\nDid you mean ${w} lbs?\n\nOK: log it as ${conv} kg\nCancel: keep ${w} kg`)){sd.weight=String(conv);if(wEl)wEl.value=sd.weight;}
    else sd.unitOk=true;
  }else{
    const conv=r1(w/LB_TO_KG);
    if(confirm(`${w} lbs is much lighter than your usual ~${Math.round(usual/LB_TO_KG)} lbs on ${name}.\n\nDid you mean ${w} kg?\n\nOK: log it as ${conv} lbs\nCancel: keep ${w} lbs`)){sd.weight=String(conv);if(wEl)wEl.value=sd.weight;}
    else sd.unitOk=true;
  }
}

// Every logged set that looks like the wrong unit, for the review sheet.
// Sets already confirmed (unitOk) are never asked about again.
export function findUnitSuspects(){
  const S=ctx.getS(),cids=new Set();
  for(const sess of Object.values(S.sessions||{})){
    if(!sess||typeof sess!=="object")continue;
    for(const[exId,ed]of Object.entries(sess))if(ed&&typeof ed==="object"&&!exId.startsWith("_"))cids.add(canonicalId(exId));
  }
  const out=[];
  for(const cid of cids){
    const sets=loggedSetsKg(cid),usual=usualKg(sets);
    for(const s of sets){
      if(s.ok)continue;
      const to=unitSuspect(s.kg,s.unit,usual);
      if(to)out.push({...s,cid,to,usual,name:ctx.prName?.(cid)||cid,date:sessionKeyToIso(s.key)});
    }
  }
  return out.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
}

// After a correction, PR entries the log can no longer support (inflated by
// the mix-up) are deleted and the best provable lift is put back.
function rebuildPRsFor(cid){
  const S=ctx.getS();
  const best=bestFromSessions(cid);
  const cap=(best?best.est:0)+1;
  const list=S.prs?.[cid]||[];
  const keep=list.filter(e=>Number(e.est)<=cap);
  for(const e of list)if(Number(e.est)>cap)queueMutation("pr_delete",{exerciseId:cid,date:e.date,est:e.est});
  if(keep.length)S.prs[cid]=keep;else if(S.prs)delete S.prs[cid];
  recoverPRFromLog(cid);
}

let _unitQueue=[];
function openUnitReview(auto){
  _unitQueue=findUnitSuspects();
  if(!_unitQueue.length){if(!auto)showToast("No kg/lbs mix-ups found.");return;}
  renderUnitReview();
}
function renderUnitReview(){
  const m=document.getElementById("planModal");
  if(!m)return;
  if(!_unitQueue.length){m.classList.remove("show");showToast("Units checked. PRs rebuilt.");ctx.renderW?.();return;}
  const rows=_unitQueue.map((s,idx)=>{
    const conv=s.to==="lbs"?`${r1(s.weight*LB_TO_KG)} kg`:`${r1(s.weight/LB_TO_KG)} lbs`;
    const typed=`${s.weight} ${s.unit}`;
    const usual=s.unit==="lbs"?`~${Math.round(s.usual/LB_TO_KG)} lbs`:`~${Math.round(s.usual)} kg`;
    return `<div class="pm-change">
      <div class="pm-change-day">${esc(s.date?fmtDate(s.date):"")}</div>
      <div class="pm-change-ex">${esc(String(s.name).replace(/^Warm-Up · /,""))}${/^Warm-Up · /.test(s.name)?" (warm-up)":""}</div>
      <div class="pm-change-val">${esc(typed)} × ${esc(String(s.reps))}, usual ${esc(usual)}</div>
      <div class="pm-change-reason">Looks like ${s.to} was meant. Convert to ${esc(conv)}?</div>
      <div class="uf-btns"><button class="pm-cancel uf-sm" onclick="unitFix(${idx},false)">Keep</button><button class="pm-apply uf-sm" onclick="unitFix(${idx},true)">Convert</button></div>
    </div>`;}).join("");
  m.innerHTML=`<div class="pm-title">Check units</div>
    <div class="pm-sub">${_unitQueue.length} logged set${_unitQueue.length===1?"":"s"} look like kg and lbs got mixed up. Convert fixes the set and rebuilds that exercise's PR. Keep if the weight really was that.</div>
    ${rows}
    <div class="pm-btns"><button class="pm-cancel" onclick="closeUnitReview()">Later</button></div>`;
  m.classList.add("show");
}
function unitFix(idx,convert){
  const S=ctx.getS(),s=_unitQueue[idx];
  if(!s)return;
  const ed=S.sessions[s.key]?.[s.exId],st=ed?.sets?.[s.i];
  if(st){
    if(convert)st.weight=String(s.to==="lbs"?r1(s.weight*LB_TO_KG):r1(s.weight/LB_TO_KG));
    st.unitOk=true;
    queueSession(s.key,s.exId);
    if(convert)rebuildPRsFor(s.cid);
    save();
  }
  _unitQueue.splice(idx,1);
  renderUnitReview();
}
function closeUnitReview(){document.getElementById("planModal")?.classList.remove("show");_unitQueue=[];}
// Shown by itself once a day after launch while anything is unresolved, so a
// mix-up gets caught even if nobody goes looking for it.
function maybeUnitReview(){
  const mark="f5_unitreview_"+isoToday();
  try{if(localStorage.getItem(mark))return;localStorage.setItem(mark,"1");}catch{return;}
  if(document.getElementById("planModal")?.classList.contains("show"))return;
  openUnitReview(true);
}
ctx.maybeUnitReview=maybeUnitReview;
window.openUnitReview=openUnitReview;
window.unitFix=unitFix;
window.closeUnitReview=closeUnitReview;
