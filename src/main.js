import { ctx } from "./runtime.js";
import { ACTIVE_MULT, PHASES, USER, addDaysIso, bankedDays, calcBMR, calcTarget, daysBetween, effectiveEnd, ensurePhaseRun, getPhaseRun, isoDate, isoToday, isRestDay, latestWeightLog, phaseActiveTarget, phaseCorridor, phaseCurveKg, phaseDayDeficit, phaseFor, phaseState, projectedFinish, requiredDeficit, restingFor, sevenDayAvg } from "./phase.js";
import { cycleQ, quotePool } from "./quotes.js";
import { applyTheme, closeMilestone, esc, fmtDate, mdLite, showMilestone, showToast, showToastBig, toggleTheme } from "./ui.js";
import { save, autoBackupTick, listDailyBackups } from "./state.js";
import { API_CFG, flushOutbox, loadServerState, queueMutation, queueSession, queueSessionMeta, queueDayMeta, queueSettings, queueMilestones, setSyncDot, getOutbox, listSnapshots, restoreSnapshot } from "./sync.js";
import { planMonFor, isBannedExercise } from "./plan.js";
import { FEATURES, weekKeyOf, EX_DB, PROG_V1, PROG_V2, PROG_V3, PROG_V4, PROG_V5, PROG_V6, PROG_V7, v4IdToV7, PROG, programFor, programKeyFor, PR_ALIAS, prSlug, kg1, DAYS, GYM, FIBRE_TARGET, SUGAR_LIMIT, SODIUM_LIMIT } from "./constants.js";
import { renderW, sessionKeyToIso } from "./workout.js";
import { renderNutrition, buildSparkline } from "./nutrition.js";
import { renderST } from "./settings.js";
import { closeForgeChat } from "./chat.js";

let S=JSON.parse(localStorage.getItem("f5")||"{}");
// One-time repairs are guarded by S._flags, but the server does not store
// those flags: every sync replaced S and wiped them, so EVERY repair re-ran on
// every launch. One of them (the week repair) then moved a workout logged
// early on Wednesday's screen into the previous week. Flags now also live in
// their own localStorage key, which a sync never touches.
const _ONCE_KEY="f5_once";
try{for(const k of JSON.parse(localStorage.getItem(_ONCE_KEY)||"[]"))S[k]=true;}catch(_){}
function persistOnceFlags(){
  try{
    const have=new Set(JSON.parse(localStorage.getItem(_ONCE_KEY)||"[]"));
    for(const[k,v]of Object.entries(S))if(k.startsWith("_")&&v===true)have.add(k);
    localStorage.setItem(_ONCE_KEY,JSON.stringify([...have]));
  }catch(_){}
}
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
  for(const P of [PROG,PROG_V7,PROG_V6,PROG_V5,PROG_V4,PROG_V3,PROG_V2,PROG_V1])for(const[,dd] of Object.entries(P))for(const ex of(dd.exercises||[]))add(ex);
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
// One-off, requested by the user: Monday 28 Sep 2026 (first day of the PROG_V6
// deload) was trained but not logged, so every exercise on it is marked done.
// Existing sets are kept; only the done flag is set. Queued so it reaches
// Postgres, because a sync replaces state wholesale. Idempotent, and scoped to
// that one week so it can never touch another Monday.
if(!S._v6MonDone1){
  const d=new Date(2026,8,28),j=new Date(2026,0,1);
  const key="Monday_2026W"+Math.ceil(((d-j)/86400000+j.getDay()+1)/7);
  S.sessions=S.sessions||{};
  const sess=S.sessions[key]=S.sessions[key]||{};
  for(const ex of programFor(d).Monday.exercises){
    const ed=sess[ex.id]=sess[ex.id]||{sets:[]};
    if(ed.done)continue;
    ed.done=true;ed.skipped=false;
    queueSession(key,ex.id);
  }
  S._v6MonDone1=true;
  localStorage.setItem("f5",JSON.stringify(S));
}
// Heal plan stamps that came back from a sync as ["v","4"] (see applyPlan in
// settings.js): rejoin the characters so the plan applies again.
for(const w of Object.values(S.weekPlans||{})){
  if(w&&Array.isArray(w._prog))w._prog=w._prog.every(x=>typeof x==="string"&&x.length===1)?w._prog.join(""):w._prog[w._prog.length-1];
}
// One-off: the plan generated Mon 5 Oct 2026 was saved for the week of 12 Oct
// (plans always targeted "next week"). Move it onto the week it was meant for,
// locally and on the server, only if this week has no plan of its own.
if(!S._planMove41){
  const wp=S.weekPlans||{},from="2026W42",to="2026W41";
  if(wp[from]&&!wp[to]&&wk()===to){
    wp[to]=wp[from];delete wp[from];
    queueMutation("week_plan_reset",{weekKey:from});
    queueMutation("week_plan_reset",{weekKey:to});
    for(const[day,ups]of Object.entries(wp[to])){
      if(day==="_prog")continue;
      for(const upd of(ups||[]))queueMutation("week_plan_update",{weekKey:to,dayName:day,update:upd});
    }
    if(wp[to]._prog)queueMutation("week_plan_update",{weekKey:to,dayName:"_prog",update:wp[to]._prog});
  }
  if(wk()!=="2026W41"||wp[to])S._planMove41=true;
  localStorage.setItem("f5",JSON.stringify(S));
}
// Date of a session key ("Wednesday_2026W42" -> that Wednesday).
function keyToDate(day,wkKey){
  const yr=+wkKey.slice(0,4),d=new Date(yr-1,11,20,12);
  for(let i=0;i<400;i++){if(weekKeyOf(d)===wkKey&&DAYS[(d.getDay()+6)%7]===day)return new Date(d);d.setDate(d.getDate()+1);}
  return null;
}
// The week-key repair (S._wkFix1) is gone. It ran once on Oct 12 and its
// result reached the database, but with the flag wiped by every sync it kept
// re-running, and its "a session dated in the future is misfiled" rule moved a
// workout logged early on Wednesday's screen into the previous week. Nothing
// may move logged sessions automatically again.
// One-time, for this user's data (verified against their Oct 11 and Oct 13
// backups). The week repair above, re-running after every sync, treated the
// Legs session logged on Mon 12 Oct (on the Wednesday Oct 14 screen) as
// "dated in the future" and merged it into Wednesday Oct 7: Calf Raise, Inner
// Thigh and Lateral Raise were added there, and Oct 7's Seated Leg Curl
// (160x12, 145x10 lbs) was overwritten by Oct 12's (60/70/70/70 kg). Move the
// Oct 12 exercises to Monday Oct 12 under their V7 (Legs & Shoulders) ids and
// restore Oct 7's leg curl. Runs only if the data is exactly that shape.
if(!S._oct12Fix1){
  const W41=S.sessions?.Wednesday_2026W41,slc=W41?.w4_slc;
  const sig=e=>(e?.sets||[]).filter(x=>x&&x.done).map(x=>x.weight+"x"+x.reps).join(",");
  if(W41&&slc&&slc.unit==="kg"&&sig(slc)==="60x15,70x17,70x17,70x18"&&W41.w4_calf&&W41.w4_hiad&&W41.w4_slr){
    const mon=S.sessions.Monday_2026W42=S.sessions.Monday_2026W42||{};
    for(const[from,to]of[["w4_calf","m7_calf"],["w4_hiad","m7_hiad"],["w4_slr","m7_slr"],["w4_slc","m7_slc"]]){
      if(!mon[to])mon[to]=W41[from];
      delete W41[from];
    }
    W41.w4_slc={done:true,skipped:false,unit:"lbs",sets:[{done:true,reps:"12",weight:"160",attempted:true},{done:true,reps:"10",weight:"145",attempted:true}]};
    queueMutation("session_key_delete",{sessionKey:"Wednesday_2026W41"});
    for(const k of Object.keys(W41))if(!k.startsWith("_"))queueSession("Wednesday_2026W41",k);
    queueSessionMeta("Wednesday_2026W41");
    for(const k of Object.keys(mon))if(!k.startsWith("_"))queueSession("Monday_2026W42",k);
    queueSessionMeta("Monday_2026W42");
    setTimeout(()=>showToast("Monday's legs session restored to Oct 12 ✓"),3000);
  }
  S._oct12Fix1=true;
  localStorage.setItem("f5",JSON.stringify(S));
}
// Second half of the Oct 12 repair: the merge into Wednesday Oct 7 kept Oct
// 7's Leg Press / Outer Thigh / Inner Thigh / warm-up (more sets) and DROPPED
// Oct 12's. The device keeps snapshots taken before each sync (f5_snapshots)
// and daily backups (f5_daily_*); one taken on Oct 12 after the workout still
// holds Wednesday_2026W42 as logged. Put back any Oct 12 exercise found there
// that Monday Oct 12 does not have yet. Only ADDS; never overwrites or deletes.
if(!S._oct12Recover1){
  const srcs=[];
  try{for(const sn of JSON.parse(localStorage.getItem("f5_snapshots")||"[]"))if(sn?.state?.sessions)srcs.push(sn.state.sessions);}catch(_){}
  for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.startsWith("f5_daily_"))try{const st=JSON.parse(localStorage.getItem(k));if(st?.sessions)srcs.push(st.sessions);}catch(_){}}
  const doneN=e=>(e?.sets||[]).filter(x=>x&&x.done).length;
  const best={};
  for(const ses of srcs){
    const w=ses.Wednesday_2026W42;if(!w||typeof w!=="object")continue;
    for(const[id,ed]of Object.entries(w)){
      if(id.startsWith("_")||!/^w4_/.test(id)||!doneN(ed))continue;
      if(!best[id]||doneN(ed)>doneN(best[id]))best[id]=ed;
    }
  }
  const mon=S.sessions.Monday_2026W42=S.sessions.Monday_2026W42||{};
  const restored=[];
  for(const[id,ed]of Object.entries(best)){
    const to=id.replace(/^w4_/,"m7_");
    if(doneN(mon[to])>0)continue;
    mon[to]=JSON.parse(JSON.stringify(ed));
    queueSession("Monday_2026W42",to);
    restored.push(id);
  }
  if(!Object.keys(mon).length)delete S.sessions.Monday_2026W42;
  S._oct12Recover1=true;
  S._oct12Restored=restored;
  localStorage.setItem("f5",JSON.stringify(S));
  if(restored.length)setTimeout(()=>showToast("Recovered "+restored.length+" exercise"+(restored.length===1?"":"s")+" from Monday Oct 12 ✓"),3500);
  else setTimeout(()=>showToast("No backup of Monday's leg press found on this device"),3500);
}
// Oct 12's Leg Extension and Leg Press were lost to the merge and were not in
// any on-device snapshot. Re-entered from the user's own numbers: Leg
// Extension 68 kg x 15 (a PR: est 102 > 65.8x15 = 99) and Leg Press 280 lbs
// x 12 (127 kg, est 178: below the 123x21 = 209 record, so no PR). Only adds
// where Monday has no done sets for that exercise, and only adds the PR once.
if(!S._oct12Manual1){
  const mon=S.sessions.Monday_2026W42=S.sessions.Monday_2026W42||{};
  const has=id=>(mon[id]?.sets||[]).some(x=>x&&x.done);
  const add=(id,unit,w,r)=>{if(has(id))return false;mon[id]={done:true,skipped:false,unit,sets:[{done:true,reps:String(r),weight:String(w),attempted:true}]};queueSession("Monday_2026W42",id);return true;};
  add("m7_le","kg",68,15);
  add("m7_lp","lbs",280,12);
  const le=(S.prs=S.prs||{}).leg_extension_machine=S.prs.leg_extension_machine||[];
  if(!le.some(e=>e.date==="2026-10-12"&&Number(e.weight)===68&&Number(e.reps)===15)){
    const pr={date:"2026-10-12",weight:68,reps:15,est:102};
    le.push(pr);queueMutation("pr",{exerciseId:"leg_extension_machine",...pr});
  }
  S._oct12Manual1=true;
  localStorage.setItem("f5",JSON.stringify(S));
}
// One-time: Southpaw was reordered from Mon 12 Oct 2026 (PROG_V7: chest off
// Monday). The user did Legs & Shoulders on Monday the 12th, which under the
// old order lived on Wednesday, so this week's (2026W42) sessions and plan
// are moved onto the day that now holds each exercise, with its V7 id.
// Only that week; never overwrites an exercise that already has done sets; old
// keys are deleted server-side after the moved entries are queued.
if(!S._v7Move1){
  const W="2026W42",doneN=e=>(e?.sets||[]).filter(x=>x&&x.done).length+(e?.done?1:0);
  const touched=new Set(),emptied=new Set();
  for(const day of DAYS){
    const key=day+"_"+W,sess=S.sessions?.[key];
    if(!sess||typeof sess!=="object")continue;
    for(const[id,ed]of Object.entries(sess)){
      if(id.startsWith("_"))continue;
      const to=v4IdToV7(id);
      if(!to||(to.day===day&&to.id===id))continue;
      // Never move logged work onto a day that has not happened yet: Monday's
      // chest sets would otherwise land on Wednesday Oct 14. Left in place,
      // they show under "Also logged this day".
      const tDate=keyToDate(to.day,W),today=new Date();today.setHours(23,59,59,999);
      if(!tDate||tDate>today)continue;
      const tkey=to.day+"_"+W,dst=S.sessions[tkey]=S.sessions[tkey]||{};
      if(!dst[to.id]||doneN(ed)>doneN(dst[to.id]))dst[to.id]=ed;
      delete sess[id];touched.add(tkey);emptied.add(key);
      // The session meta (duration, notes, twinges) travels with the workout.
      for(const mk of["_duration","_notes","_calfTwinges","_stopped","_complete"])
        if(sess[mk]!=null&&dst[mk]==null){dst[mk]=sess[mk];}
    }
  }
  for(const key of emptied){
    const sess=S.sessions[key];
    if(sess&&!Object.keys(sess).some(k=>!k.startsWith("_"))){
      for(const mk of["_duration","_notes","_calfTwinges","_stopped","_complete"])delete sess[mk];
      delete S.sessions[key];queueMutation("session_key_delete",{sessionKey:key});
    }else if(sess){queueMutation("session_key_delete",{sessionKey:key});for(const k of Object.keys(sess))if(!k.startsWith("_"))queueSession(key,k);queueSessionMeta(key);}
  }
  for(const key of touched){for(const k of Object.keys(S.sessions[key]))if(!k.startsWith("_"))queueSession(key,k);queueSessionMeta(key);}
  // This week's plan follows its exercises to their new days.
  const wp=(S.weekPlans||{})[W];
  if(wp&&wp._prog==="v4"){
    const np={_prog:"v7"};
    for(const[day,ups]of Object.entries(wp)){
      if(day==="_prog"||!Array.isArray(ups))continue;
      for(const u of ups){
        const to=u.id?v4IdToV7(u.id):null;
        const d=to?to.day:day;
        (np[d]=np[d]||[]).push(to?{...u,id:to.id}:u);
      }
    }
    S.weekPlans[W]=np;
    queueMutation("week_plan_reset",{weekKey:W});
    for(const[day,ups]of Object.entries(np)){if(day==="_prog")continue;for(const u of ups)queueMutation("week_plan_update",{weekKey:W,dayName:day,update:u});}
    queueMutation("week_plan_update",{weekKey:W,dayName:"_prog",update:"v7"});
  }
  S._v7Move1=true;
  localStorage.setItem("f5",JSON.stringify(S));
  if(touched.size)setTimeout(()=>showToast("This week moved to the new day order ✓"),2500);
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
if(!S._prRecompute2){
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
  // A PR whose exercise has NO logged sets at all cannot be verified, rebuilt
  // or ever beaten honestly. It is a record with nothing behind it, usually an
  // exercise whose sessions were lost. Remove it so the PR list only ever shows
  // lifts the log can account for.
  //
  // Archived to S._prPurged rather than simply deleted. This is the only pass
  // here that destroys data outright instead of correcting it, and a record
  // that turns out to have been real is otherwise unrecoverable.
  let purged=0;
  for(const[cid,list]of Object.entries(S.prs||{})){
    if(!Array.isArray(list)||!list.length)continue;
    if(setsFor(cid).length)continue;
    (S._prPurged=S._prPurged||{})[cid]=(S._prPurged[cid]||[]).concat(list);
    for(const e of list)queueMutation("pr_delete",{exerciseId:cid,date:e.date,est:e.est});
    delete S.prs[cid];
    purged+=list.length;
  }
  S._prRecompute1=true;
  S._prRecompute2=true;
  localStorage.setItem("f5",JSON.stringify(S));
  if(rebuilt)setTimeout(()=>showToast(rebuilt+" unverified PR"+(rebuilt===1?"":"s")+" rebuilt from your logged sets"),4000);
  if(purged)setTimeout(()=>showToast(purged+" PR"+(purged===1?"":"s")+" with no logged sets removed"),6000);
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
// PR audit (Oct 29, from the user's backup). Three kinds of wrong record:
// - Jul 31 chest press at 133 lbs (60.3 kg) was a DIFFERENT machine (user:
//   "different machine so wrong number"): its sets are tagged otherMachine and
//   never count toward a PR or a target again (the log keeps them).
// - The Aug 3 custom leg extension (100/120 x15) had no unit; the same session's
//   pec fly was lbs, and 120 kg is ~1.8x the usual 68 kg: it was lbs.
// - Warm-up sets were saved as PRs, and some PRs match no logged set at all
//   (72.6 x 18 leg curl, 49.9 x 13 cable curl, 13.6 x 10 hammer curl).
// Every PR is rebuilt from the log: unverifiable entries go, the best provable
// lift is put back, warm-up and set-less PRs are archived to S._prPurged.
// Idempotent: on clean data every step is a no-op.
if(!S._prAudit1){
  const LB=0.45359237;
  const tag=(key,exId,fn)=>{const ed=S.sessions?.[key]?.[exId];if(ed&&fn(ed))queueSession(key,exId);};
  tag("Friday_2026W31","f3_cp",ed=>{let ch=false;for(const st of ed.sets||[])if(ed.unit==="lbs"&&String(st.weight)==="133"&&!st.otherMachine){st.otherMachine=true;ch=true;}return ch;});
  tag("Monday_2026W32","c_1785773891369",ed=>{if(ed.unit||!(ed.sets||[]).some(st=>String(st.weight)==="120"))return false;ed.unit="lbs";for(const st of ed.sets||[])st.unitOk=true;return true;});
  const canon=exId=>{const c=_prCanonMap[exId]||exId.replace(/^(?:su2?|sa2?|f2?|th2?|w2?|t2?|m2?)_/,"");return PR_ALIAS[c]||c;};
  const setsFor=cid=>{
    const out=[];
    for(const[key,sess]of Object.entries(S.sessions||{})){
      if(!sess||typeof sess!=="object")continue;
      for(const[exId,ed]of Object.entries(sess)){
        if(!ed||typeof ed!=="object"||exId.startsWith("_")||canon(exId)!==cid)continue;
        for(const st of(ed.sets||[])){
          if(!st||!st.done||!st.weight||!st.reps||st.otherMachine)continue;
          const w=ed.unit==="lbs"?Math.round(Number(st.weight)*LB*10)/10:Number(st.weight),r=Number(st.reps);
          if(!w||!r||r>30)continue;
          out.push({key,weight:w,reps:r,est:r===1?w:Math.round(w*(1+r/30))});
        }
      }
    }
    return out;
  };
  let fixed=0;
  for(const[cid,list]of Object.entries(S.prs||{})){
    if(!Array.isArray(list)||!list.length)continue;
    const sets=/^warm_up_/.test(cid)?[]:setsFor(cid);
    const ok=e=>sets.some(s=>s.weight===Number(e.weight)&&s.reps===Number(e.reps));
    const bad=list.filter(e=>!ok(e));
    if(!bad.length)continue;
    if(!sets.length)(S._prPurged=S._prPurged||{})[cid]=(S._prPurged[cid]||[]).concat(list);
    for(const e of bad)queueMutation("pr_delete",{exerciseId:cid,date:e.date,est:e.est});
    const kept=list.filter(ok);
    const best=sets.reduce((b,s)=>!b||s.est>b.est?s:b,null),bestKept=kept.reduce((b,e)=>!b||e.est>b.est?e:b,null);
    if(best&&(!bestKept||best.est>bestKept.est)){
      const date=sessionKeyToIso(best.key)||isoToday();
      kept.push({date,weight:best.weight,reps:best.reps,est:best.est});
      queueMutation("pr",{exerciseId:cid,date,weight:best.weight,reps:best.reps,est:best.est});
    }
    if(kept.length)S.prs[cid]=kept;else delete S.prs[cid];
    fixed+=bad.length;
  }
  S._prAudit1=true;
  localStorage.setItem("f5",JSON.stringify(S));
  if(fixed)setTimeout(()=>showToast(fixed+" PR record"+(fixed===1?"":"s")+" corrected from your logged sets"),4000);
}
// Remove May 25 outlier — 3-point trend (Jun 2, 7, 8) is more accurate without it.
if(!S._wtBackfill2){
  delete S.nutrition.weights["2026-05-25"];
  S._wtBackfill2=true;
  localStorage.setItem("f5",JSON.stringify(S));
}
persistOnceFlags();
hydrateCustomExercises();
applyDroppedExercises();
applyPlanOverrides();
applyTheme();
// Auto mode: re-resolve theme-color when the device theme flips
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>applyTheme());
let _appReady=false;
ctx.save=save;
// v4: demos are all bundled now; the cache held remote MuscleWiki/GitHub URLs.
// Cleared here AND on the server (queueSettings), so no device fetches them.
if(!S.demoCache||(S.demoCacheV||0)<4){const had=Object.keys(S.demoCache||{}).length>0;S.demoCache={};S.demoCacheV=4;if(had)queueSettings();}
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
  const wkKey=weekKeyOf(d);
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

// A custom exercise belongs to the WEEK it was added in, not to the weekday
// forever. S.custom is keyed by day name only, so this used to attach every
// custom ever added to that weekday on every launch: a Leg Extension added
// once months ago kept reappearing on every Monday, through every program
// change, and looked like the app was adding it by itself. The id carries its
// creation time (c_<Date.now()>), so no schema change is needed: show it this
// week if it was created this week or has sets logged this week. Past weeks
// get their own logged customs back through customsLoggedIn() in curProg.
function customInWeek(ex,day,weekKey,monTs){
  const ts=Number(String(ex?.id||"").replace(/^c_/,""));
  if(Number.isFinite(ts)&&ts>=monTs&&ts<monTs+7*86400000)return true;
  return !!S.sessions?.[day+"_"+weekKey]?.[ex.id];
}
function hydrateCustomExercises(){
  const monTs=_todayMonday().getTime(),weekKey=wk();
  Object.entries(S.custom||{}).forEach(([day,exs])=>{
    if(!PROG[day]||!Array.isArray(exs))return;
    const ids=new Set(PROG[day].exercises.map(ex=>ex.id));
    exs.forEach(ex=>{if(ex&&ex.id&&!ids.has(ex.id)&&customInWeek(ex,day,weekKey,monTs)){PROG[day].exercises.push(ex);ids.add(ex.id);}});
  });
}
ctx.customsLoggedIn=(day,weekKey)=>(S.custom?.[day]||[]).filter(ex=>ex&&ex.id&&S.sessions?.[day+"_"+weekKey]?.[ex.id]);

// Exercises the user swapped out when adding a custom one. Kept as a separate
// list rather than mutating the program, so the drop survives a reload without
// the program itself drifting away from what was planned.
function applyDroppedExercises(){
  // Only drops made THIS week apply. They used to be keyed by weekday alone,
  // so one swap removed that exercise from that weekday in every later week
  // and every later program. Legacy drops carry no week and have expired.
  const weekKey=wk();
  Object.entries(S.dropped||{}).forEach(([day,ids])=>{
    if(!PROG[day]||!Array.isArray(ids)||!ids.length)return;
    const drop=new Set(ids.filter(id=>S.droppedWk?.[id]===weekKey));
    if(!drop.size)return;
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
// ?demo=streak previews the week streak with 4 fake past weeks (Mon-Fri)
// layered over the real log. DISPLAY ONLY: it swaps the trainedOn the streak
// reads, writes nothing to S, and checkMilestones skips its longestStreak
// write so the fake run can never reach the database. Drop the query to exit.
const DEMO_STREAK=typeof location!=="undefined"&&/[?&]demo=streak\b/.test(location.search||"");
ctx.demoStreak=DEMO_STREAK;
ctx.trainedOn=DEMO_STREAK?(iso=>{
  if(trainedOn(iso))return true;
  const t=isoToday(),dow=new Date(t+"T12:00:00Z").getUTCDay(),mon=addDaysIso(t,dow===0?-6:1-dow);
  const wd=new Date(iso+"T12:00:00Z").getUTCDay();
  return iso<mon&&iso>=addDaysIso(mon,-28)&&wd>=1&&wd<=5;
}):trainedOn;
ctx.rememberCustom=rememberCustom;
ctx.weekLabel=weekLabel;
ctx.isBannedExercise=isBannedExercise;
ctx.buildSparkline=buildSparkline;
ctx.renderST=renderST;
ctx.renderNutrition=renderNutrition;


function initApp(){
  buildNav();
  const t=DAYS[new Date().getDay()===0?6:new Date().getDay()-1];
  // A running workout lived only in memory. iOS unloads a backgrounded PWA
  // (switching to music, messages, the camera) and the reload came back with
  // Start Workout showing and the timer gone, so it looked like the workout
  // "closed on its own". startSess persists it; restore it here if it is
  // today's session and under 6 hours old.
  try{
    const a=JSON.parse(localStorage.getItem("f5_active")||"null");
    if(a&&a.key===t+"_"+wk()&&Date.now()-a.start<6*3600000){workoutOn=true;sessStart=a.start;}
    else if(a)localStorage.removeItem("f5_active");
  }catch(_){}
  selectDay(t);
  updateDayNavDates();
  // Restore the tab the user was on before a refresh (sessionStorage:
  // survives reload, resets on a fresh app launch)
  let lastTab=null;
  try{lastTab=sessionStorage.getItem("forge_tab");}catch(_){}
  if(lastTab==="nutrition"||lastTab==="settings")go(lastTab);
  // Quote card switched off (FEATURES): hide it and skip the rotation timer.
  if(FEATURES.quoteCard){cycleQ();setInterval(cycleQ,9000);}
  else{const q=document.getElementById("quoteEl");if(q)q.style.display="none";}
  handleHKSync();
  _appReady=true;
  // Sequential, not concurrent: a queued restore_all (or any pending write)
  // must land before we pull authoritative state, or the pull can return
  // pre-write data and clobber it the moment the outbox empties.
  // Auto-plan runs AFTER the pull, so it sees the server's plans (another
  // device may already have generated this week's) and is not overwritten.
  flushOutbox().then(()=>loadServerState(false)).then(()=>ctx.maybeAutoPlan?.()).then(()=>ctx.maybeUnitReview?.()).catch(()=>{});
  // Backup nudge: data exists but no backup in 14+ days
  const hasData=Object.keys(S.sessions||{}).length>3;
  const staleBackup=!S._lastBackup||Date.now()-S._lastBackup>14*86400000;
  if(hasData&&staleBackup)setTimeout(()=>showToast("No recent backup. Export one from Settings."),3000);
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
  // The iOS redesign ships one tab at a time; the stylesheet keys it on this.
  document.body.dataset.tab=tab;
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

function wk(){return weekKeyOf(new Date());}
function nextWk(){const d=new Date();d.setDate(d.getDate()+7);return weekKeyOf(d);}
// The week a generated plan is FOR. On Monday that is the week just starting:
// it was always "next week", so a plan generated Monday morning (Mon 5 Oct)
// landed on the following Monday (12 Oct) and this week ran unplanned. Sunday
// and Tue-Sat still target the coming Monday. One source for the key, the
// program stamp, the AI's snapshot and every label, so they cannot disagree.
function planMon(){return planMonFor(new Date());}
function planWk(){return weekKeyOf(planMon());}
function nthPrevWk(n){const d=new Date();d.setDate(d.getDate()-n*7);return weekKeyOf(d);}
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
function _wkFromDate(d){return weekKeyOf(d);}
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

