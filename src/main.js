import { ctx } from "./runtime.js";
import { ACTIVE_MULT, PHASES, USER, addDaysIso, bankedDays, calcBMR, calcTarget, daysBetween, effectiveEnd, ensurePhaseRun, getPhaseRun, isoDate, isoToday, isRestDay, latestWeightLog, phaseActiveTarget, phaseCorridor, phaseCurveKg, phaseDayDeficit, phaseFor, phaseState, projectedFinish, requiredDeficit, restingFor, sevenDayAvg } from "./phase.js";
import { cycleQ, quotePool } from "./quotes.js";
import { applyTheme, closeMilestone, esc, mdLite, showMilestone, showToast, showToastBig, toggleTheme } from "./ui.js";
import { save, autoBackupTick, listDailyBackups } from "./state.js";
import { API_CFG, flushOutbox, loadServerState, queueMutation, queueSession, queueSessionMeta, queueDayMeta, queueSettings, queueMilestones, setSyncDot, getOutbox, listSnapshots, restoreSnapshot } from "./sync.js";
import { EX_DB, PROG_V1, PROG_V2, PROG, DAYS, GYM, FIBRE_TARGET, SUGAR_LIMIT, SODIUM_LIMIT } from "./constants.js";
import "./workout.js";

let S=JSON.parse(localStorage.getItem("f5")||"{}");
ctx.getS=()=>S;
ctx.setS=(ns)=>{S=ns;};
if(!S.sessions)S.sessions={};
if(!S.custom)S.custom={};
if(!S.nutrition)S.nutrition={days:{},weights:{},aiDeficitModifier:0,weeklySnapshots:[]};
if(!S.nutrition.days)S.nutrition.days={};
if(!S.nutrition.weights)S.nutrition.weights={};
if(S.nutrition.aiDeficitModifier===undefined)S.nutrition.aiDeficitModifier=0;
if(!S.nutrition.weeklySnapshots)S.nutrition.weeklySnapshots=[];
if(!S.milestones)S.milestones={shownProtein7:[],shownWeight5kg:[],shownWeek6:[]};
if(!S.milestones.longestStreak)S.milestones.longestStreak=0;
if(!S.prs)S.prs={};
// Build exId→name-slug canonical map from PROG (robust across V1/V2 ID inconsistencies)
const _prCanonMap={},_prNameMap={};
(function(){for(const[,dd] of Object.entries(PROG))for(const ex of(dd.exercises||[])){const slug=ex.name.toLowerCase().replace(/[^a-z0-9]+/g,"_");if(!_prCanonMap[ex.id])_prCanonMap[ex.id]=slug;if(!_prNameMap[slug])_prNameMap[slug]=ex.name;}})();
ctx._prCanonMap=_prCanonMap;
// One-time migration: consolidate all day-keyed PR entries → name-slug keys
if(!S._prCanonMigrated2){
  const merged={};
  Object.entries(S.prs).forEach(([id,entries])=>{
    const cid=_prCanonMap[id]||id.replace(/^(?:su2?|sa2?|f2?|th2?|w2?|t2?|m2?)_/,"");
    if(!merged[cid])merged[cid]=[];
    merged[cid].push(...entries);
  });
  S.prs=merged;S._prCanonMigrated=true;S._prCanonMigrated2=true;
  // Direct write — save() isn't safe yet (_appReady/queueSync not initialised at this point)
  localStorage.setItem("f5",JSON.stringify(S));
}
if(!S.aiChat)S.aiChat=[];
// One-time backfill of historical weigh-ins (requested 2026-06-10).
// Only fills dates that have no entry; never overwrites logged data.
if(!S._wtBackfill1){
  const seed={"2026-05-25":138.0,"2026-06-02":141.4,"2026-06-07":138.8,"2026-06-08":136.6};
  for(const[d,kg]of Object.entries(seed))if(S.nutrition.weights[d]==null)S.nutrition.weights[d]=kg;
  S._wtBackfill1=true;
  localStorage.setItem("f5",JSON.stringify(S));
}
// Remove May 25 outlier — 3-point trend (Jun 2, 7, 8) is more accurate without it.
if(!S._wtBackfill2){
  delete S.nutrition.weights["2026-05-25"];
  S._wtBackfill2=true;
  localStorage.setItem("f5",JSON.stringify(S));
}
hydrateCustomExercises();
applyPlanOverrides();
applyTheme();
// Auto mode: re-resolve theme-color when the device theme flips
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>applyTheme());
let _appReady=false;
ctx.save=save;
if(!S.demoCache||(S.demoCacheV||0)<3){S.demoCache={};S.demoCacheV=3;}
function restoreDailyBackup(dateStr){
  const raw=localStorage.getItem("f5_daily_"+dateStr);
  if(!raw){showToast("Backup not found");return;}
  let state;
  try{state=JSON.parse(raw);}catch{showToast("Backup is corrupted");return;}
  const w=dataWeight(state);
  if(!confirm(`Restore local backup from ${dateStr} (~${w} entries)?\n\nThis REPLACES all current data on this device.`))return;
  S=state;save();queueMutation("restore_all",{state:S});showToast("Backup restored ✓");location.reload();
}

// True when the session for that calendar date has at least one completed set
function trainedOn(dateIso){
  const d=new Date(dateIso+"T12:00:00");
  const dayName=DAYS[d.getDay()===0?6:d.getDay()-1];
  const j=new Date(d.getFullYear(),0,1);
  const wkKey=d.getFullYear()+"W"+Math.ceil(((d-j)/86400000+j.getDay()+1)/7);
  const sess=S.sessions[dayName+"_"+wkKey];
  return!!(sess&&Object.values(sess).some(e=>e&&typeof e==="object"&&((e.sets||[]).some(s=>s.done)||e.done)));
}
function applyPlanOverrides(){
  // Migrate legacy S.plan → S.weekPlans keyed by ISO week
  if(S.plan&&!S.weekPlans){
    S.weekPlans={};
    S.weekPlans[wk()]=S.plan;
    delete S.plan;
    save();
  }
  const weekPlan=(S.weekPlans||{})[wk()];
  if(!weekPlan)return;
  for(const[day,updates]of Object.entries(weekPlan)){
    if(!PROG[day]||!Array.isArray(updates))continue;
    for(const upd of updates){
      if(upd.action==="remove"){
        PROG[day].exercises=PROG[day].exercises.filter(e=>e.id!==upd.id);
      } else if(upd.action==="add"){
        if(!PROG[day].exercises.find(e=>e.id===upd.id)){
          PROG[day].exercises.push({id:upd.id,name:upd.name,cat:upd.cat||"gym",sets:upd.sets,reps:upd.reps,hint:upd.hint||"",url:upd.url||"",cue:upd.cue||"",muscles:upd.muscles||[]});
        }
      } else {
        const ex=PROG[day].exercises.find(e=>e.id===upd.id);
        if(!ex)continue;
        if(upd.sets!==undefined)ex.sets=upd.sets;
        if(upd.reps!==undefined)ex.reps=upd.reps;
        if(upd.hint!==undefined)ex.hint=upd.hint;
      }
    }
  }
}

function hydrateCustomExercises(){
  Object.entries(S.custom||{}).forEach(([day,exs])=>{
    if(!PROG[day]||!Array.isArray(exs))return;
    const ids=new Set(PROG[day].exercises.map(ex=>ex.id));
    exs.forEach(ex=>{if(ex&&ex.id&&!ids.has(ex.id)){PROG[day].exercises.push(ex);ids.add(ex.id);}});
  });
}

function rememberCustom(day,ex){
  if(!S.custom)S.custom={};
  if(!S.custom[day])S.custom[day]=[];
  if(!S.custom[day].some(e=>e.id===ex.id)){
    S.custom[day].push(ex);
    queueMutation("custom_exercise",{id:ex.id,dayName:day,name:ex.name,cat:ex.cat,sets:ex.sets,reps:ex.reps,hint:ex.hint,url:ex.url,cue:ex.cue,muscles:ex.muscles||[]});
  }
}

let cDay="",cTab="workout",workoutOn=false,sessStart=null,sessTimer=null,selectedEx=null;
ctx.getTab=()=>cTab;
// Live ctx proxies so extracted modules (workout.js, nutrition.js) can read/write shared state
Object.defineProperty(ctx,"cDay",{get:()=>cDay,set:v=>{cDay=v;},enumerable:true});
Object.defineProperty(ctx,"cTab",{get:()=>cTab,set:v=>{cTab=v;},enumerable:true});
Object.defineProperty(ctx,"workoutOn",{get:()=>workoutOn,set:v=>{workoutOn=v;},enumerable:true});
Object.defineProperty(ctx,"sessStart",{get:()=>sessStart,set:v=>{sessStart=v;},enumerable:true});
Object.defineProperty(ctx,"sessTimer",{get:()=>sessTimer,set:v=>{sessTimer=v;},enumerable:true});
Object.defineProperty(ctx,"selectedEx",{get:()=>selectedEx,set:v=>{selectedEx=v;},enumerable:true});
let _nutDate=isoToday(),_pendingFood=null,_foodChatOpen=false,_wtOpen=false,_foodSearchOpen=false,_foodSearchQ="";
let _foodDraftText="",_foodDraftMealName=""; // survives tab switches — see openFood()/askFood() for lifecycle
let _lastFoodText="",_lastMealName="";
Object.defineProperty(ctx,"nutDate",{get:()=>_nutDate,set:v=>{_nutDate=v;},enumerable:true});
Object.defineProperty(ctx,"pendingFood",{get:()=>_pendingFood,set:v=>{_pendingFood=v;},enumerable:true});
Object.defineProperty(ctx,"foodChatOpen",{get:()=>_foodChatOpen,set:v=>{_foodChatOpen=v;},enumerable:true});
Object.defineProperty(ctx,"wtOpen",{get:()=>_wtOpen,set:v=>{_wtOpen=v;},enumerable:true});
Object.defineProperty(ctx,"foodSearchOpen",{get:()=>_foodSearchOpen,set:v=>{_foodSearchOpen=v;},enumerable:true});
Object.defineProperty(ctx,"foodSearchQ",{get:()=>_foodSearchQ,set:v=>{_foodSearchQ=v;},enumerable:true});
Object.defineProperty(ctx,"foodDraftText",{get:()=>_foodDraftText,set:v=>{_foodDraftText=v;},enumerable:true});
Object.defineProperty(ctx,"foodDraftMealName",{get:()=>_foodDraftMealName,set:v=>{_foodDraftMealName=v;},enumerable:true});
Object.defineProperty(ctx,"lastFoodText",{get:()=>_lastFoodText,set:v=>{_lastFoodText=v;},enumerable:true});
Object.defineProperty(ctx,"lastMealName",{get:()=>_lastMealName,set:v=>{_lastMealName=v;},enumerable:true});

// Expose main.js functions via ctx for workout.js
ctx.wk=wk;
ctx.nextWk=nextWk;
ctx.vwk=vwk;
ctx.sk=sk;
ctx.isPast=isPast;
ctx.isFuture=isFuture;
ctx.isPastDay=isPastDay;
ctx.isReadOnly=isReadOnly;
ctx.trainedOn=trainedOn;
ctx.rememberCustom=rememberCustom;
ctx.weekLabel=weekLabel;
ctx.isBannedExercise=isBannedExercise;
ctx.buildSparkline=buildSparkline;
ctx.renderST=()=>renderST();
ctx.renderNutrition=()=>renderNutrition();


function initApp(){
  buildNav();
  const t=DAYS[new Date().getDay()===0?6:new Date().getDay()-1];
  selectDay(t);
  updateDayNavDates();
  // Restore the tab the user was on before a refresh (sessionStorage:
  // survives reload, resets on a fresh app launch)
  let lastTab=null;
  try{lastTab=sessionStorage.getItem("forge_tab");}catch(_){}
  if(lastTab==="nutrition"||lastTab==="settings")go(lastTab);
  cycleQ();
  setInterval(cycleQ,9000);
  handleHKSync();
  _appReady=true;
  // Sequential, not concurrent: a queued restore_all (or any pending write)
  // must land before we pull authoritative state, or the pull can return
  // pre-write data and clobber it the moment the outbox empties.
  flushOutbox().then(()=>loadServerState(false));
  // Backup nudge: data exists but no backup in 14+ days
  const hasData=Object.keys(S.sessions||{}).length>3;
  const staleBackup=!S._lastBackup||Date.now()-S._lastBackup>14*86400000;
  if(hasData&&staleBackup)setTimeout(()=>showToast("💾 No recent backup · export one from Settings"),3000);
  document.addEventListener("click",e=>{
    const btn=e.target.closest("[data-action]");
    if(!btn)return;
    const{action,day,q,idx,kind}=btn.dataset;
    if(action==="freeform")addFreeform(day,q);
    else if(action==="fromdb")addFromDB(Number(idx),day);
    else if(action==="suggestalt")suggestSafeAlt(kind,day,idx!==undefined?Number(idx):undefined);
    else if(action==="fromalt")addFromAlt(day);
  });
}

window.addEventListener("DOMContentLoaded",()=>{
  if(window.FORGE_API_CFG){initApp();return;}
  const stored=localStorage.getItem("forge_key");
  if(stored){API_CFG.token=stored;initApp();return;}
  document.getElementById("lockScreen").style.display="flex";
  setTimeout(()=>document.getElementById("lockInput").focus(),100);
});

function go(tab){
  closeForgeChat();
  cTab=tab;
  try{sessionStorage.setItem("forge_tab",tab);}catch(_){}
  document.querySelectorAll(".nav-item").forEach(n=>n.classList.remove("active"));
  const navEl=document.getElementById("nav-"+tab);
  if(navEl)navEl.classList.add("active");
  document.getElementById("dayNav").style.display=tab==="workout"?"flex":"none";
  document.getElementById("mainScroll").scrollTop=0;
  if(tab==="workout")renderW();
  else if(tab==="nutrition"){_nutDate=isoToday();renderNutrition();}
  else renderST();
}

function buildNav(){
  const el=document.getElementById("dayNav");
  el.style.display="flex";
  const ti=new Date().getDay()===0?6:new Date().getDay()-1;
  DAYS.forEach((d,i)=>{
    const b=document.createElement("div");
    b.className="day-btn"+(i===ti?" today":"");
    b.id="p-"+d;b.textContent=d.slice(0,3).toUpperCase();
    b.onclick=()=>selectDay(d);
    el.appendChild(b);
  });
}

function selectDay(day){
  cDay=day;
  DAYS.forEach(d=>{const p=document.getElementById("p-"+d);if(p)p.classList.toggle("active",d===day);});
  renderW();
}

function wk(){const d=new Date(),j=new Date(d.getFullYear(),0,1);return d.getFullYear()+"W"+Math.ceil(((d-j)/86400000+j.getDay()+1)/7);}
function nextWk(){const d=new Date();d.setDate(d.getDate()+(d.getDay()===0?1:7));const j=new Date(d.getFullYear(),0,1);return d.getFullYear()+"W"+Math.ceil(((d-j)/86400000+j.getDay()+1)/7);}
function nthPrevWk(n){const d=new Date();d.setDate(d.getDate()-n*7);const j=new Date(d.getFullYear(),0,1);return d.getFullYear()+"W"+Math.ceil(((d-j)/86400000+j.getDay()+1)/7);}
function weekLabel(wkStr){const m=wkStr.match(/(\d{4})W(\d+)/);if(!m)return wkStr;const yr=+m[1],wn=+m[2],jan1=new Date(yr,0,1),dow=jan1.getDay()||7,mon=new Date(yr,0,1+(wn-1)*7-(dow-1));return mon.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});}
// Returns the Monday Date object for the Mon-Sun week containing Date d.
// Named distinctly from the ISO-string mondayOf() defined later in this file.
function mondayDateOf(d){const day=d.getDay(),diff=day===0?-6:1-day,m=new Date(d);m.setDate(d.getDate()+diff);m.setHours(0,0,0,0);return m;}
function _todayMonday(){return mondayDateOf(new Date());}
// Navigation state: Date of Monday being viewed, null = current week
let _viewMon=null;
Object.defineProperty(ctx,"viewMon",{get:()=>_viewMon,set:v=>{_viewMon=v;},enumerable:true});
// vwk() must return a wkStr whose session key matches what was stored this week.
// wk() uses a formula that may put Sunday in the NEXT week, so for non-current weeks
// we apply wk()'s formula to Wednesday of the viewed week (safely mid-week).
function _wkFromDate(d){const j=new Date(d.getFullYear(),0,1);return d.getFullYear()+"W"+Math.ceil(((d-j)/86400000+j.getDay()+1)/7);}
function vwk(){
  if(!_viewMon)return wk();
  const wed=new Date(_viewMon);wed.setDate(_viewMon.getDate()+2);
  return _wkFromDate(wed);
}
function wkOrd(w){const m=(w||"").match(/(\d{4})W(\d+)/);return m?+m[1]*100+(+m[2]):0;}
function isPast(){return !!_viewMon&&_viewMon<_todayMonday();}
function isFuture(){return !!_viewMon&&_viewMon>_todayMonday();}
// A "past day" = any earlier week, or an earlier day within the current week
function isPastDay(){
  if(isFuture())return false;
  if(isPast())return true;
  const ti=new Date().getDay()===0?6:new Date().getDay()-1;
  return DAYS.indexOf(cDay)<ti;
}
let _unlocked={}; // session-only edit unlocks, keyed by day_week
Object.defineProperty(ctx,"unlocked",{get:()=>_unlocked,set:v=>{_unlocked=v;},enumerable:true});
function unlockDay(){_unlocked[sk(cDay)]=true;renderW();showToast("Editing unlocked for this day");}
function lockDay(){delete _unlocked[sk(cDay)];renderW();}
function isReadOnly(key){
  if(isPastDay())return !_unlocked[key];
  return !workoutOn&&!!S.sessions[key]?._stopped;
}
function sk(day){return day+"_"+vwk();}
function shiftWeek(delta){
  const curMon=_viewMon||_todayMonday();
  const newMon=new Date(curMon);newMon.setDate(curMon.getDate()+delta*7);
  // Cap: cannot navigate past next week's Monday
  const nextMon=new Date(_todayMonday());nextMon.setDate(nextMon.getDate()+7);
  if(newMon>nextMon)return;
  _viewMon=newMon.getTime()===_todayMonday().getTime()?null:newMon;
  updateDayNavDates();renderW();
}
function goCurrentWeek(){_viewMon=null;updateDayNavDates();renderW();}

// Returns exercises for next week with any queued plan overrides applied (preview only)
function getPreviewExercises(day){
  const base=(PROG[day]?.exercises||[]).map(ex=>({...ex}));
  const overrides=((S.weekPlans||{})[nextWk()]||{})[day]||[];
  let exs=base;
  for(const upd of overrides){
    if(upd.action==="remove"){exs=exs.filter(e=>e.id!==upd.id);}
    else if(upd.action==="add"){if(!exs.find(e=>e.id===upd.id))exs.push({...upd});}
    else{const ex=exs.find(e=>e.id===upd.id);if(ex){if(upd.sets!==undefined)ex.sets=upd.sets;if(upd.reps!==undefined)ex.reps=upd.reps;if(upd.hint!==undefined)ex.hint=upd.hint;}}
  }
  return exs;
}
function updateDayNavDates(){
  const mon=_viewMon||_todayMonday();
  DAYS.forEach((d,i)=>{
    const btn=document.getElementById("p-"+d);if(!btn)return;
    const dd=new Date(mon);dd.setDate(mon.getDate()+i);
    btn.innerHTML=`<span>${d.slice(0,3)}</span><small class="day-date">${dd.getDate()}</small>`;
  });
}

ctx.queueSettings=queueSettings;

