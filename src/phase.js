import { ctx } from "./runtime.js";

// Personal constants · never rendered in UI
export const USER={birthDate:new Date(1995,7,1),weightKg:138,targetKg:90,heightCm:190.5,sex:"M",goalDate:new Date(2027,1,20)};
export const ACTIVE_MULT=0.75;

export function isoDate(d){return d.toLocaleDateString("en-CA",{timeZone:"America/Toronto"});}
export function isoToday(){return isoDate(new Date());}

// Fallback when no phase covers a date: date-driven deficit toward 90kg by
// Feb 20, 2027. Inside a phase, phase targets rule (see PHASE ENGINE below).
export function requiredDeficit(lw,daysLeft){return Math.round(Math.max(0,(lw-USER.targetKg)*7700)/daysLeft);}

// ── PHASE ENGINE (2026-07-16) ────────────────────────────────────────────────
// The plan is phase-based: fixed eat/active/resting targets inside each phase,
// colour-banded checkpoints between phases. Identity (id+version) is primary;
// plannedEnd is the immutable authored deadline, effectiveEnd() is derived
// (plannedEnd + extend-pauses). Definitions live here; runtime state
// (S.phaseRun), immutable completion snapshots (S.phaseHistory) and reviews
// ride the settings sync blob. All date math is noon-UTC-anchored on
// YYYY-MM-DD strings so Toronto DST transitions can never shift a day.
export const PHASES=[
  {id:"phase_1",version:1,strategy:"fat_loss",curve:"front_loaded",
   start:"2026-07-17",plannedEnd:"2026-08-31",startKg:138,targetKg:128,
   eatKcal:2100,restingKcal:2850,activeTargetWorkout:1500,activeTargetRest:650}
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
export function isRestDay(dateIso){return noonUTC(dateIso).getUTCDay()===0;}
export function phaseActiveTarget(p,dateIso){return isRestDay(dateIso)?p.activeTargetRest:p.activeTargetWorkout;}
export function phaseDayDeficit(p,dateIso){return Math.round(p.restingKcal+ACTIVE_MULT*phaseActiveTarget(p,dateIso)-p.eatKcal);}
export function restingFor(dateIso,dayData){
  if(dayData&&dayData.restingOverride!=null)return dayData.restingOverride;
  const p=phaseFor(dateIso);
  return p?p.restingKcal:calcBMR(latestWeightLog()||USER.weightKg);
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
export function latestWeightLog(){const S=phaseStore();const ws=S.nutrition.weights||{};const keys=Object.keys(ws).sort();return keys.length?ws[keys[keys.length-1]]:null;}
export function calcTarget(bmr,active,dateIso){
  const t=dateIso||isoToday();
  const lw=latestWeightLog()||USER.weightKg;
  const p=phaseFor(t);
  if(p)return{bmr,req:phaseDayDeficit(p,t),target:p.eatKcal,daysLeft:daysBetween(t,effectiveEnd(p,t)),lw,phase:p};
  const daysLeft=Math.max(1,Math.ceil((USER.goalDate-Date.now())/86400000));
  const req=requiredDeficit(lw,daysLeft);
  return{bmr,req,target:bmr+active-req,daysLeft,lw,phase:null};
}
