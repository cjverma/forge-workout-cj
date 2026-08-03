import { ctx } from "./runtime.js";
import { ACTIVE_MULT, PHASES, USER, addDaysIso, bankedDays, calcBMR, calcTarget, daysBetween, effectiveEnd, ensurePhaseRun, getPhaseRun, isoDate, isoToday, isRestDay, latestWeightLog, phaseActiveTarget, phaseCorridor, phaseCurveKg, phaseDayDeficit, phaseFor, phaseState, projectedFinish, requiredDeficit, restingFor, sevenDayAvg } from "./phase.js";
import { cycleQ, quotePool } from "./quotes.js";
import { applyTheme, closeMilestone, esc, fmtDate, mdLite, showMilestone, showToast, showToastBig, toggleTheme } from "./ui.js";
import { save, autoBackupTick, listDailyBackups } from "./state.js";
import { API_CFG, flushOutbox, loadServerState, queueMutation, queueSession, queueSessionMeta, queueDayMeta, queueSettings, queueMilestones, setSyncDot, getOutbox, listSnapshots, restoreSnapshot } from "./sync.js";
import { EX_DB, PROG_V1, PROG_V2, PROG_V3, PROG_V4, PROG, programFor, programKeyFor, PR_ALIAS, prSlug, kg1, DAYS, GYM, FIBRE_TARGET, SUGAR_LIMIT, SODIUM_LIMIT } from "./constants.js";
import { renderW, sessionKeyToIso } from "./workout.js";
import { renderNutrition, buildSparkline } from "./nutrition.js";
import { isBannedExercise, renderST } from "./settings.js";
import { closeForgeChat } from "./chat.js";

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
// Alias applied HERE so every downstream consumer (the migration, PR reads and
// PR writes) agrees on one slug and a rename cannot split an exercise's history.
// Built from EVERY program version plus EX_DB, not just the current one: PR
// history outlives the program that created it, so a slug written under V2 must
// still resolve to a readable name while V4 is active. Alias applied here so the
// migration, reads and writes all agree on one slug.
// Custom exercises keep their "c_<ts>" id as the PR key, so without a name
// registry they resolved to the generic "Custom exercise" label in the PR list,
// the PDF report and the CSV export. S._exNames is the durable half: S.custom
// loses an entry when the exercise is removed from a day, but its PR history
// outlives it and still needs a readable name.
function seedCustomNames(){
  const s=S;
  for(const arr of Object.values(s.custom||{}))for(const ex of(arr||[])){
    if(ex&&ex.id&&ex.name){_prNameMap[ex.id]=ex.name;(s._exNames=s._exNames||{})[ex.id]=ex.name;}
  }
  // A sync replaces state wholesale, so names for exercises no longer in
  // S.custom live only in the in-memory map. Write them back into the new S.
  for(const[id,nm] of Object.entries(_prNameMap))if(id.startsWith("c_"))(s._exNames=s._exNames||{})[id]=nm;
  for(const[id,nm] of Object.entries(s._exNames||{}))if(!_prNameMap[id])_prNameMap[id]=nm;
}
ctx.seedCustomNames=seedCustomNames;
(function(){
  const add=ex=>{const raw=prSlug(ex.name);const slug=PR_ALIAS[raw]||raw;
    if(ex.id&&!_prCanonMap[ex.id])_prCanonMap[ex.id]=slug;
    if(!_prNameMap[slug])_prNameMap[slug]=ex.name;};
  for(const P of [PROG,PROG_V4,PROG_V3,PROG_V2,PROG_V1])for(const[,dd] of Object.entries(P))for(const ex of(dd.exercises||[]))add(ex);
  for(const ex of EX_DB)add(ex);
  seedCustomNames();
})();

// Display name for a PR slug. The de-slug fallback is the important part: it
// guarantees a readable name for ANY key, so a slug can never leak into the UI
// as "tricep_extension_machine" just because its exercise left the program.
function prName(slug){
  if(!slug)return "";
  // Alias FIRST. _prNameMap only ever holds canonical slugs, so a key stored
  // under a retired name misses the map and falls through to the de-slug,
  // which prints the retired name back verbatim: "seated_hip_adduction_machine"
  // rendered as "Seated Hip Adduction Machine" in the PDF report and the
  // backup export. Resolving here fixes every caller at once, and works
  // whether or not the storage migration has run yet.
  const norm=String(slug).replace(/^_+|_+$/g,"");
  const canon=PR_ALIAS[norm]||norm;
  if(_prNameMap[canon])return _prNameMap[canon];
  const S2=ctx.getS?.();
  if(S2?._exNames?.[canon])return S2._exNames[canon];
  if(canon.startsWith("c_"))return "Custom exercise";
  return canon.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase());
}
ctx.prName=prName;
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
// PR_ALIAS canonical for the thigh machines flipped to the names actually on
// the equipment. Re-run the alias merge so history written under the old
// clinical slug lands on the new key instead of being orphaned.
if(!S._prCanonMigrated3){
  const merged={};
  Object.entries(S.prs||{}).forEach(([id,entries])=>{
    const norm=String(id).replace(/^_+|_+$/g,"");
    const cid=PR_ALIAS[norm]||norm;
    if(!merged[cid])merged[cid]=[];
    merged[cid].push(...entries);
  });
  for(const k of Object.keys(merged))
    merged[k].sort((a,b)=>(b.est||0)-(a.est||0)||String(b.date).localeCompare(String(a.date)));
  S.prs=merged;S._prCanonMigrated3=true;
  localStorage.setItem("f5",JSON.stringify(S));
}
// The HealthKit shortcut wrote raw floats ("136.00000001") for months. Round
// what is already stored, and re-queue it so the server copy is fixed too.
if(!S._wtRound1){
  const ws=S.nutrition?.weights||{};
  for(const[d,v]of Object.entries(ws)){
    const r=kg1(v);
    if(r!==null&&r!==v)ws[d]=r;
  }
  S._wtRound1=true;
  localStorage.setItem("f5",JSON.stringify(S));
}
// PRs were written in whatever unit the set was typed in, so a 120 lbs lift
// became a "120 kg" PR reading 160kg est. 1RM. Heal them by finding the logged
// set each PR came from and converting when that set was in lbs. Matched on
// exact weight+reps so an entry that was already kg is left alone.
// _prLbFix1 healed localStorage ONLY. A sync replaces state wholesale, so the
// still-wrong server rows came straight back on the next pull and the PR looked
// unfixed (Leg Extension). This pass queues the correction so it reaches
// Postgres, and matches the canonical id the same way canonicalId() does, since
// an exercise whose id is not in _prCanonMap was never even considered.
// A third pass because fix2 compared the PR key raw. A list still stored under
// a RETIRED slug ("hip_abduction_machine") can never equal the canonical slug
// the sessions resolve to ("outer_thigh_machine"), so those entries were never
// examined and stayed in lbs while their canonical sibling was healed. Alias
// the PR key first, then match.
if(!S._prLbFix3){
  const LB=0.45359237;
  const canon=exId=>{const c=_prCanonMap[exId]||exId.replace(/^(?:su2?|sa2?|f2?|th2?|w2?|t2?|m2?)_/,"");return PR_ALIAS[c]||c;};
  const unitFor=(cid,w,r)=>{
    for(const sess of Object.values(S.sessions||{})){
      if(!sess||typeof sess!=="object")continue;
      for(const[exId,ed]of Object.entries(sess)){
        if(!ed||typeof ed!=="object"||exId.startsWith("_"))continue;
        if(canon(exId)!==cid)continue;
        for(const st of(ed.sets||[]))
          if(Number(st?.weight)===Number(w)&&Number(st?.reps)===Number(r))return ed.unit||"kg";
      }
    }
    return null;
  };
  let fixed=0;
  for(const[key,list]of Object.entries(S.prs||{})){
    if(!Array.isArray(list))continue;
    const cid=PR_ALIAS[key]||key;
    for(const e of list){
      // Matched on exact weight+reps against a logged set, so a PR that is
      // already in kg finds no lbs set and is left alone. That is also what
      // makes this safe to re-run: a converted 54.4 no longer matches the 120
      // that was typed, so it cannot be halved twice.
      if(unitFor(cid,e.weight,e.reps)!=="lbs")continue;
      const oldEst=e.est;
      e.weight=Math.round(e.weight*LB*10)/10;
      e.est=Math.round(e.weight*(1+e.reps/30));
      // Delete under the key the server actually stored it under, insert under
      // the canonical one, so the alias merge reaches Postgres as well.
      queueMutation("pr_delete",{exerciseId:key,date:e.date,est:oldEst});
      queueMutation("pr",{exerciseId:cid,date:e.date,weight:e.weight,reps:e.reps,est:e.est});
      fixed++;
    }
  }
  // Fold any list still sitting under a retired slug into its canonical key, or
  // the PR list renders two rows for one exercise and only one of them can ever
  // receive a new PR.
  for(const key of Object.keys(S.prs||{})){
    const cid=PR_ALIAS[key];
    if(!cid||cid===key)continue;
    S.prs[cid]=(S.prs[cid]||[]).concat(S.prs[key]);
    delete S.prs[key];
  }
  S._prLbFix1=true;
  S._prLbFix2=true;
  S._prLbFix3=true;
  localStorage.setItem("f5",JSON.stringify(S));
  if(fixed)setTimeout(()=>showToast(fixed+" PR"+(fixed===1?"":"s")+" corrected from lbs to kg"),2500);
}
// The lbs heal converts only what it can PROVE, by matching a PR to the exact
// logged set it came from. Entries whose set was later edited or deleted are
// unverifiable, so they were left standing in lbs: a 203kg seated leg curl, a
// 120kg tricep extension. An inflated best is not harmless. checkAndStorePR
// only writes when you BEAT the current best, so every real lift underneath a
// phantom is silently discarded.
//
// This pass rebuilds those from the log, which is unit-aware and therefore
// truthful whichever unit was typed. It only touches an exercise that HAS
// logged sets to rebuild from: with no evidence there is nothing better to put
// back, and dropping the entry would destroy history rather than correct it.
if(!S._prRecompute1){
  const LB=0.45359237;
  const canon=exId=>{const c=_prCanonMap[exId]||exId.replace(/^(?:su2?|sa2?|f2?|th2?|w2?|t2?|m2?)_/,"");return PR_ALIAS[c]||c;};
  const setsFor=cid=>{
    const out=[];
    for(const[key,sess]of Object.entries(S.sessions||{})){
      if(!sess||typeof sess!=="object")continue;
      for(const[exId,ed]of Object.entries(sess)){
        if(!ed||typeof ed!=="object"||exId.startsWith("_"))continue;
        if(canon(exId)!==cid)continue;
        for(const st of(ed.sets||[])){
          if(!st||!st.done||!st.weight||!st.reps)continue;
          const w=ed.unit==="lbs"?Math.round(Number(st.weight)*LB*10)/10:Number(st.weight);
          const r=Number(st.reps);
          if(!w||!r||r>30)continue;
          out.push({key,weight:w,reps:r,est:r===1?w:Math.round(w*(1+r/30))});
        }
      }
    }
    return out;
  };
  const verifiable=(sets,e)=>sets.some(s=>s.weight===Number(e.weight)&&s.reps===Number(e.reps));
  let rebuilt=0;
  for(const[cid,list]of Object.entries(S.prs||{})){
    if(!Array.isArray(list)||!list.length)continue;
    const sets=setsFor(cid);
    if(!sets.length)continue;
    const bad=list.filter(e=>!verifiable(sets,e));
    if(!bad.length)continue;
    const kept=list.filter(e=>verifiable(sets,e));
    for(const e of bad)queueMutation("pr_delete",{exerciseId:cid,date:e.date,est:e.est});
    // Put back the best the log can actually prove, if nothing verified beats it.
    const best=sets.reduce((b,s)=>!b||s.est>b.est?s:b,null);
    const bestKept=kept.reduce((b,e)=>!b||e.est>b.est?e:b,null);
    if(best&&(!bestKept||best.est>bestKept.est)){
      const date=sessionKeyToIso(best.key)||isoToday();
      kept.push({date,weight:best.weight,reps:best.reps,est:best.est});
      queueMutation("pr",{exerciseId:cid,date,weight:best.weight,reps:best.reps,est:best.est});
    }
    if(kept.length)S.prs[cid]=kept;else delete S.prs[cid];
    rebuilt+=bad.length;
  }
  S._prRecompute1=true;
  localStorage.setItem("f5",JSON.stringify(S));
  if(rebuilt)setTimeout(()=>showToast(rebuilt+" unverified PR"+(rebuilt===1?"":"s")+" rebuilt from your logged sets"),4000);
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
applyDroppedExercises();
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
  const now=dataWeight(S);
  const loss=now-w;
  if(!confirm(
    `Restore local backup from ${fmtDate(dateStr)}?\n\n`
    +`Now: ~${now} entries\nBackup: ~${w} entries\n`
    +(loss>0?`\nYou will LOSE about ${loss} entries.\n`:"")
    +`\nThis replaces your data on this device AND in the database, on every device. It cannot be undone.`
  ))return;
  // Preserve TODAY's backup before overwriting state. The restored state carries
  // an old _lastAutoBackupDay, so the very next save() would rewrite today's
  // backup with the restored data and destroy the only copy of today's work.
  const today=isoToday();
  const todayBak=localStorage.getItem("f5_daily_"+today);
  S=state;
  S._lastAutoBackupDay=today;
  save();
  if(todayBak)localStorage.setItem("f5_daily_"+today,todayBak);
  queueMutation("restore_all",{state:S});showToast("Backup restored ✓");location.reload();
}

// True when the session for that calendar date has at least one completed set
function trainedOn(dateIso){
  const d=new Date(dateIso+"T12:00:00");
  const dayName=DAYS[d.getDay()===0?6:d.getDay()-1];
  const j=new Date(d.getFullYear(),0,1);
  const wkKey=d.getFullYear()+"W"+Math.ceil(((d-j)/86400000+j.getDay()+1)/7);
  const sess=S.sessions[dayName+"_"+wkKey];
  if(!sess)return false;
  // Manual completion counts as trained. Sessions are keyed by EXERCISE ID, so
  // when the program changes the work you logged under the old plan's ids stops
  // matching the new plan's exercises and the day silently reads as untrained,
  // taking the streak with it. This is the escape hatch for that, and for any
  // session done away from the app.
  if(sess._complete)return true;
  // Note this already ignores ids: any entry with a completed set counts, so
  // orphaned data from a previous program still holds the streak.
  return Object.values(sess).some(e=>e&&typeof e==="object"&&((e.sets||[]).some(s=>s.done)||e.done));
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
  // A plan references exercise ids from the program it was generated against.
  // Once the program switches those ids are stale: "update" and "remove" fail
  // safe because they look the id up first, but "add" trusted it blindly and
  // pushed a phantom exercise into the new week. Reproduced turning Southpaw
  // Monday from 10 exercises into 11. Refuse a plan built for another program.
  const activeKey=programKeyFor(new Date());
  if(weekPlan._prog&&weekPlan._prog!==activeKey)return;
  for(const[day,updates]of Object.entries(weekPlan)){
    if(day==="_prog")continue;
    if(!PROG[day]||!Array.isArray(updates))continue;
    // Unstamped legacy plans get the same protection from the id itself: every
    // exercise on a day shares its day prefix, so an id from another program
    // cannot match and is dropped rather than added.
    const dayPrefix=(PROG[day].exercises[0]?.id||"").split("_")[0];
    for(const upd of updates){
      if(upd.action==="remove"){
        PROG[day].exercises=PROG[day].exercises.filter(e=>e.id!==upd.id);
      } else if(upd.action==="add"){
        if(!weekPlan._prog&&dayPrefix&&!String(upd.id||"").startsWith(dayPrefix+"_"))continue;
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

// Exercises the user swapped out when adding a custom one. Kept as a separate
// list rather than mutating the program, so the drop survives a reload without
// the program itself drifting away from what was planned.
function applyDroppedExercises(){
  Object.entries(S.dropped||{}).forEach(([day,ids])=>{
    if(!PROG[day]||!Array.isArray(ids)||!ids.length)return;
    const drop=new Set(ids);
    PROG[day].exercises=PROG[day].exercises.filter(ex=>!drop.has(ex.id));
  });
}
ctx.applyDroppedExercises=applyDroppedExercises;

function rememberCustom(day,ex){
  if(!S.custom)S.custom={};
  if(!S.custom[day])S.custom[day]=[];
  if(!S.custom[day].some(e=>e.id===ex.id)){
    S.custom[day].push(ex);
    _prNameMap[ex.id]=ex.name;
    (S._exNames=S._exNames||{})[ex.id]=ex.name;
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
ctx.renderST=renderST;
ctx.renderNutrition=renderNutrition;


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
    else if(action==="swapkeep")closeSwap();
    else if(action==="swapdrop")dropForSwap(btn.dataset.drop);
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
function weekLabel(wkStr){const m=wkStr.match(/(\d{4})W(\d+)/);if(!m)return wkStr;const yr=+m[1],wn=+m[2],jan1=new Date(yr,0,1),dow=jan1.getDay()||7,mon=new Date(yr,0,1+(wn-1)*7-(dow-1));return fmtDate(mon.toISOString().slice(0,10));}
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
// Date object for the day currently being VIEWED (viewed Monday + weekday
// offset). Needed because the program changes by date: browsing to next week
// must render that week's program, not today's.
function viewDate(){
  const mon=_viewMon||_todayMonday();
  const d=new Date(mon);
  d.setDate(mon.getDate()+Math.max(0,DAYS.indexOf(cDay)));
  return d;
}
ctx.viewDate=viewDate;

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
  // programFor(viewDate()), not PROG: PROG is today's snapshot, so previewing a
  // future week listed THIS week's exercises under next week's heading. That is
  // why Southpaw did not appear when browsing forward.
  const base=((programFor(viewDate())[day])?.exercises||[]).map(ex=>({...ex}));
  const plan=(S.weekPlans||{})[nextWk()]||{};
  // Same staleness guard as applyPlanOverrides: a plan generated against another
  // program has ids that cannot match, and "add" would inject phantom exercises.
  if(plan._prog&&plan._prog!==programKeyFor(viewDate()))return base;
  const overrides=plan[day]||[];
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

function submitLock(){
  const inp=document.getElementById("lockInput");
  if(!inp)return;
  const v=inp.value.trim();
  if(!v){showToast("Enter your access token");return;}
  localStorage.setItem("forge_key",v);
  API_CFG.token=v;
  document.getElementById("lockScreen").style.display="none";
  initApp();
}
function lockApp(){
  localStorage.removeItem("forge_key");
  API_CFG.token="";
  location.reload();
}

window.submitLock=submitLock;
window.lockApp=lockApp;

ctx.queueSettings=queueSettings;

