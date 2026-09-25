import { ctx } from "./runtime.js";
import { kg1 } from "./constants.js";
import { isGymRestDay } from "./constants.js";

// Personal constants · never rendered in UI
export const USER={birthDate:new Date(1995,7,1),weightKg:140,targetKg:90,heightCm:190.5,sex:"M",goalDate:new Date(2027,1,21)};
export const ACTIVE_MULT=0.75;

export function isoDate(d){return d.toLocaleDateString("en-CA",{timeZone:"America/Toronto"});}
export function isoToday(){return isoDate(new Date());}

// Fallback when no phase covers a date: date-driven deficit toward 90kg by
// Feb 21, 2027. Inside a phase, phase targets rule (see PHASE ENGINE below).
export function requiredDeficit(lw,daysLeft){return Math.round(Math.max(0,(lw-USER.targetKg)*7700)/daysLeft);}

// ── PHASE ENGINE (2026-07-16) ────────────────────────────────────────────────
// The plan is phase-based: fixed eat/active/resting targets inside each phase,
// colour-banded checkpoints between phases. Identity (id+version) is primary;
// plannedEnd is the immutable authored deadline, effectiveEnd() is derived
// (plannedEnd + extend-pauses). Definitions live here; runtime state
// (S.phaseRun), immutable completion snapshots (S.phaseHistory) and reviews
// ride the settings sync blob. All date math is noon-UTC-anchored on
// YYYY-MM-DD strings so Toronto DST transitions can never shift a day.
// phase_2/phase_3 (v2): revised for the 90kg-by-Feb-21 goal. No
// restingKcal/activeTargetWorkout/activeTargetRest fields — those are only
// ever hand-authored, day-1 estimates that go stale as real BMR falls across
// a 70-83 day phase. Omitted here on purpose so phaseActiveTarget/restingFor
// (below) fall through to the DYNAMIC path: computed live from the latest
// real weigh-in every day, always anchored to this phase's fixed
// phaseRequiredDeficit rather than a frozen number. phase_1 (completed,
// locked) keeps its original flat fields untouched — recomputing history
// live would make it drift with calcAge() as real time passes, see the note
// on phaseActiveTarget below.
export const PHASES=[
  {id:"phase_1",version:2,strategy:"fat_loss",curve:"front_loaded",
   start:"2026-07-28",plannedEnd:"2026-09-07",startKg:140,targetKg:128,
   eatKcal:1600,restingKcal:2446,activeTargetWorkout:900,activeTargetRest:390},
  {id:"phase_2",version:2,strategy:"fat_loss",curve:"linear",
   start:"2026-09-22",plannedEnd:"2026-11-30",startKg:128,targetKg:107,
   eatKcal:1600},
  {id:"phase_3",version:2,strategy:"fat_loss",curve:"linear",
   start:"2026-12-01",plannedEnd:"2027-02-21",startKg:107,targetKg:90,
   eatKcal:1600},
];
function phaseStore(){
  if(typeof S!=="undefined")return S;
  return ctx.getS();
}
export function noonUTC(iso){return new Date(iso+"T12:00:00Z");}
export function daysBetween(aIso,bIso){return Math.round((noonUTC(bIso)-noonUTC(aIso))/86400000);}
export function addDaysIso(iso,n){const d=noonUTC(iso);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().split("T")[0];}
// Read-only accessor — never writes to S; mutations go through explicit actions
export function getPhaseRun(id){const S=phaseStore();return(S.phaseRun&&S.phaseRun[id])||{pauses:[],completedAt:null,outcome:null,locked:false};}
export function ensurePhaseRun(id){const S=phaseStore();S.phaseRun=S.phaseRun||{};S.phaseRun[id]=S.phaseRun[id]||{pauses:[],completedAt:null,outcome:null,locked:false};return S.phaseRun[id];}
// Whole days consumed by extend:true pauses (open pauses count up to `uptoIso`)
export function pausedDaysExtend(p,uptoIso){
  let n=0;
  for(const pa of getPhaseRun(p.id).pauses){
    if(!pa.extend)continue;
    const end=pa.resumed||uptoIso;
    n+=Math.max(0,daysBetween(pa.start,end));
  }
  return n;
}
export function effectiveEnd(p,todayIso){return addDaysIso(p.plannedEnd,pausedDaysExtend(p,todayIso||isoToday()));}
// planned | active | paused | completed | locked
export function phaseState(p,todayIso){
  const run=getPhaseRun(p.id);const t=todayIso||isoToday();
  if(run.locked)return"locked";
  if(run.completedAt)return"completed";
  if(run.pauses.some(pa=>!pa.resumed))return"paused";
  if(t<p.start)return"planned";
  if(t>effectiveEnd(p,t))return"completed";
  return"active";
}
export function phaseFor(dateIso){
  return PHASES.find(p=>{
    const run=getPhaseRun(p.id);
    if(run.locked||run.completedAt)return false;
    return dateIso>=p.start&&dateIso<=effectiveEnd(p,dateIso);
  })||null;
}
// Declarative curve shapes → per-day loss shares (no magic arrays). Linear
// interpolation of a start→end rate multiplier, normalised to sum to 1 so the
// cumulative curve lands exactly on targetKg at the phase end.
export function curveWeights(shape,nDays){
  const ends={front_loaded:[1.35,0.75],moderate:[1.15,0.85],linear:[1,1],back_loaded:[0.75,1.35]};
  const[a,b]=ends[shape]||ends.linear;
  const w=[];
  for(let i=0;i<nDays;i++){const t=nDays>1?i/(nDays-1):0;w.push(a+(b-a)*t);}
  const sum=w.reduce((s,x)=>s+x,0)||1;
  return w.map(x=>x/sum);
}
export function phaseCurveKg(p,dateIso){
  const end=effectiveEnd(p,dateIso);
  const total=Math.max(1,daysBetween(p.start,end));
  const dIn=Math.min(Math.max(daysBetween(p.start,dateIso),0),total);
  const w=curveWeights(p.curve,total);
  const lost=(p.startKg-p.targetKg)*w.slice(0,dIn).reduce((s,x)=>s+x,0);
  return Math.round((p.startKg-lost)*10)/10;
}
export function phaseCorridor(p,dateIso){const e=phaseCurveKg(p,dateIso);return{expected:e,lo:Math.round((e-1)*10)/10,hi:Math.round((e+1)*10)/10};}
// Was hardcoded to Sunday. Southpaw makes WEDNESDAY the rest day and Sunday a
// full Legs & Core session, so the old rule handed out the rest-day active
// target (650) on leg day and the workout target (1500) on the rest day, an
// 850 kcal error in both directions every week, plus skewed adherence counts.
// Now derived from whatever the program actually schedules.
export function isRestDay(dateIso){return isGymRestDay(dateIso);}
// BMR for a specific phase+date. A COMPLETED phase (e.g. phase_1) keeps its
// authored restingKcal untouched rather than recomputing live — calcBMR()
// depends on calcAge(), which reads real "now", so live-recomputing a
// historical date would make that history silently drift a year from now
// purely because a birthday passed. A phase with no restingKcal authored
// (the dynamic path, phase_2/phase_3 onward) computes real BMR from the
// latest actual weigh-in, falling back to the phase's own startKg only when
// nothing has been logged yet.
export function restingForPhase(p,dateIso){
  if(p.restingKcal!=null)return p.restingKcal;
  // A manually entered resting-calorie override (saveBurn's "resting" field,
  // src/nutrition.js) already fed the display's actual-deficit line via
  // restingFor(), but this planning path — which SOLVES the active-calorie
  // target from the resting figure — never checked it, so the override had
  // no effect on the number that actually matters: calcBMR()'s generic
  // Mifflin-St Jeor formula can understate real resting burn by hundreds of
  // kcal for someone this size, which inflates the solved active target to
  // compensate for a gap that isn't real, and — if hit — overshoots the
  // phase's actual required deficit by the same amount every day.
  const ovr=phaseStore().nutrition?.days?.[dateIso]?.restingOverride;
  return ovr!=null?ovr:calcBMR(latestWeightLog()||p.startKg);
}
// Active-calorie target for a specific phase+date, split workout/rest. A
// phase with authored activeTargetWorkout/Rest (phase_1, historical) returns
// those untouched, same reasoning as restingForPhase. A phase without them
// solves BACKWARD from phaseRequiredDeficit (the phase's one fixed daily
// target — deliberately not recomputed, see the note above it) and today's
// live restingForPhase: whatever's needed to close that gap, split
// workout:rest in the same 7:3 ratio every authored phase already used
// (900:390, 840:360, 780:330 all reduce to 7:3). The number this produces
// rises smoothly as real BMR falls through the phase, instead of jumping at
// two hand-picked boundaries, and self-corrects if a weigh-in comes in
// lighter or heavier than expected rather than silently drifting off target.
export function phaseActiveTargets(p,dateIso){
  if(p.activeTargetWorkout!=null&&p.activeTargetRest!=null)
    return{workout:p.activeTargetWorkout,rest:p.activeTargetRest};
  const req=phaseRequiredDeficit(p);
  const resting=restingForPhase(p,dateIso);
  const blended=Math.max(0,(req-resting+p.eatKcal)/ACTIVE_MULT);
  const workout=Math.round(blended*49/45);
  const rest=Math.round(3*workout/7);
  return{workout,rest};
}
export function phaseActiveTarget(p,dateIso){
  const t=phaseActiveTargets(p,dateIso);
  return isRestDay(dateIso)?t.rest:t.workout;
}
// ── DEFICIT FROM LOGGED DATA ────────────────────────────────────────────────
// What the day ACTUALLY produced, from what you logged: resting (per-day
// override if present, else the phase figure), active calories discounted by
// ACTIVE_MULT because wearables overstate them, minus what you ate.
// Returns null when nothing was eaten, i.e. the day is unlogged rather than
// perfect, so callers can skip it instead of scoring a phantom deficit.
export function actualDeficit(dateIso){
  const S=phaseStore();
  const nd=S.nutrition?.days?.[dateIso]||{};
  const eaten=(nd.items||[]).reduce((a,i)=>a+(i.kcal||0),0);
  if(!eaten)return null;
  return Math.round(restingFor(dateIso,nd)+ACTIVE_MULT*(nd.active||0)-eaten);
}

// What the phase requires per day, FIXED for the whole phase: the weight it has
// to shed divided by its length. Phase 1 is 12 kg over 42 days = 2,200 kcal/day.
//
// Deliberately not recomputed from the latest weight and days remaining. An
// adaptive figure moves the goalposts under you: get ahead and the bar drops,
// so a good week quietly lowers the standard and compliance always hovers near
// the same number regardless of effort. A fixed target means being ahead
// actually reads as ahead.
//
// Derived from the phase definition rather than typed in as a constant, so it
// can never contradict that phase's own startKg/targetKg/dates.
export function phaseRequiredDeficit(p){
  if(!p)return 0;
  const days=Math.max(1,daysBetween(p.start,p.plannedEnd)+1);
  return Math.max(0,Math.round((p.startKg-p.targetKg)*7700/days));
}

export function phaseDayDeficit(p,dateIso){return Math.round(restingForPhase(p,dateIso)+ACTIVE_MULT*phaseActiveTarget(p,dateIso)-p.eatKcal);}
export function restingFor(dateIso,dayData){
  if(dayData&&dayData.restingOverride!=null)return dayData.restingOverride;
  const p=phaseFor(dateIso);
  return p?restingForPhase(p,dateIso):calcBMR(latestWeightLog()||USER.weightKg);
}
export function sevenDayAvg(dateIso){
  const S=phaseStore();
  const ws=S.nutrition.weights||{};const t=dateIso||isoToday();
  const vals=[];
  for(let i=0;i<7;i++){const d=addDaysIso(t,-i);if(ws[d]!=null)vals.push(Number(ws[d]));}
  return vals.length?Math.round(vals.reduce((s,x)=>s+x,0)/vals.length*10)/10:null;
}
export function phaseKgPerDay(p){const total=daysBetween(p.start,p.plannedEnd);return total?(p.startKg-p.targetKg)/total:0;}
export function bankedDays(p,todayIso){
  const avg=sevenDayAvg(todayIso);
  const rate=phaseKgPerDay(p);
  if(avg==null||!rate)return null;
  const kg=Math.round((phaseCurveKg(p,todayIso)-avg)*10)/10;
  return{kg,days:Math.round(kg/rate)};
}
export function projectedFinish(todayIso){
  const S=phaseStore();
  const ws=S.nutrition.weights||{};const t=todayIso||isoToday();
  const pts=[];
  for(let i=0;i<21;i++){const d=addDaysIso(t,-i);if(ws[d]!=null)pts.push({x:-i,y:Number(ws[d])});}
  if(pts.length<10)return{status:"stabilizing"};
  const p14=pts.filter(pt=>pt.x>=-13);
  const n=p14.length,sx=p14.reduce((s,pt)=>s+pt.x,0),sy=p14.reduce((s,pt)=>s+pt.y,0);
  const sxx=p14.reduce((s,pt)=>s+pt.x*pt.x,0),sxy=p14.reduce((s,pt)=>s+pt.x*pt.y,0);
  const denom=n*sxx-sx*sx;
  if(!denom)return{status:"stabilizing"};
  const slope=(n*sxy-sx*sy)/denom;
  const cur=sevenDayAvg(t);
  if(slope>=-0.01||cur==null)return{status:"stabilizing"};
  const days=Math.ceil((cur-USER.targetKg)/(-slope));
  const date=addDaysIso(t,days);
  return{status:"ok",date,confidence:pts.length>=14?"High":"Medium",deltaDays:daysBetween(date,isoDate(USER.goalDate))};
}
// ── END PHASE ENGINE ─────────────────────────────────────────────────────────

export function calcAge(){const n=new Date();let a=n.getFullYear()-USER.birthDate.getFullYear();if(n<new Date(n.getFullYear(),USER.birthDate.getMonth(),USER.birthDate.getDate()))a--;return a;}
export function calcBMR(w){return Math.round(10*w+6.25*USER.heightCm-5*calcAge()+5);}
// The single protein target, replacing five independently hardcoded numbers
// (130/143/160/190/130) that used to disagree across the drawer chart, the
// nutrition-tab chart, compliance scoring, the streak milestone and the
// server diet-review prompt. Dosed off CURRENT bodyweight, not the eventual
// goal weight — what matters during the diet is the mass actually being
// carried now, not the number five months out. 1.8g/kg sits in the
// evidence-based 1.6-2.4g/kg range for an intermediate lifter in a real
// deficit; checked against fat-free mass too (dosing off TOTAL mass can
// overshoot relative to lean mass at a higher body-fat%) and lands at a
// defensible middle point without needing lean-mass-tracking infrastructure
// this app doesn't have.
export function proteinTargetG(){return Math.round((latestWeightLog()||USER.weightKg)*1.8);}
// Rounded here too. Every renderer, prompt and export reads through this, so
// one stale unrounded value cannot leak past it.
export function latestWeightLog(){const S=phaseStore();const ws=S.nutrition.weights||{};const keys=Object.keys(ws).sort();return keys.length?kg1(ws[keys[keys.length-1]]):null;}
export function calcTarget(bmr,active,dateIso){
  const t=dateIso||isoToday();
  const lw=latestWeightLog()||USER.weightKg;
  const p=phaseFor(t);
  if(p)return{bmr,req:phaseDayDeficit(p,t),target:p.eatKcal,daysLeft:daysBetween(t,effectiveEnd(p,t)),lw,phase:p};
  const daysLeft=Math.max(1,Math.ceil((USER.goalDate-Date.now())/86400000));
  const req=requiredDeficit(lw,daysLeft);
  return{bmr,req,target:bmr+active-req,daysLeft,lw,phase:null};
}
