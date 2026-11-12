// Hoist ROC-IT machines and their weight ratio (Nov 12; the user: "I can add
// plate number and you calculate weight"). On these machines the seat or pad
// moves the user's body with the stack, so the weight actually lifted at a pin
// LEVEL depends on body weight. Hoist's product pages ask Hoist's own
// calculator service for the table (model number + body weight in lb); the
// app asks the same service through /api/state?hoist=MODEL&bw=LB and caches
// the table per machine, refreshed once body weight has moved 2 kg (the user:
// "it needs to be recalculated post 2 kg weight loss").
//
// The 30 machines with a calculator on hoistfitness.com (sitemap, Nov 12
// 2026). RS-1000 and RS-2000 are two generations with different tables: the
// model number is on the machine's shroud.
//
// Pure (no DOM, no ctx): the app and api/state.js both import it.
export const HOIST_MACHINES=[
  {model:"RS-1101",name:"Seated Dip"},
  {model:"RS-1102",name:"Biceps Curl"},
  {model:"RS-1201",name:"Lat Pulldown"},
  {model:"RS-1203",name:"Seated Mid Row"},
  {model:"RS-1204",name:"Low Back"},
  {model:"RS-1301",name:"Chest Press"},
  {model:"RS-1302",name:"Pec Fly"},
  {model:"RS-1401",name:"Leg Extension"},
  {model:"RS-1402",name:"Leg Curl"},
  {model:"RS-1403",name:"Leg Press"},
  {model:"RS-1406",name:"Inner Thigh"},
  {model:"RS-1407",name:"Outer Thigh"},
  {model:"RS-1415",name:"Rotary Calf"},
  {model:"RS-1501",name:"Shoulder Press"},
  {model:"RS-1601",name:"Abdominals"},
  {model:"RS-2101",name:"Seated Dip"},
  {model:"RS-2102",name:"Biceps Curl"},
  {model:"RS-2201",name:"Lat Pulldown"},
  {model:"RS-2203",name:"Seated Mid Row"},
  {model:"RS-2204",name:"Low Back"},
  {model:"RS-2301",name:"Chest Press"},
  {model:"RS-2302",name:"Pec Fly"},
  {model:"RS-2401",name:"Leg Extension"},
  {model:"RS-2402",name:"Leg Curl"},
  {model:"RS-2403",name:"Leg Press"},
  {model:"RS-2406",name:"Inner Thigh"},
  {model:"RS-2407",name:"Outer Thigh"},
  {model:"RS-2415",name:"Rotary Calf"},
  {model:"RS-2501",name:"Shoulder Press"},
  {model:"RS-2601",name:"Abdominals"},
];
export const HOIST_LB=2.20462;

// The calculator answers with an HTML table: LEVEL | ACTUAL WEIGHT LIFTED.
export function parseHoistTable(html){
  const out=[];
  const rows=String(html||"").match(/<tr[\s\S]*?<\/tr>/gi)||[];
  for(const r of rows){
    const cells=(r.match(/<td[^>]*>([\s\S]*?)<\/td>/gi)||[]).map(c=>c.replace(/<[^>]+>/g,"").replace(/[^0-9.]/g,""));
    if(cells.length>=2&&cells[0]!==""&&cells[1]!==""){
      const level=Number(cells[0]),lb=Number(cells[1]);
      if(Number.isInteger(level)&&level>0&&level<100&&Number.isFinite(lb)&&lb>=0&&lb<2000)out.push({level,lb});
    }
  }
  return out;
}

// Best guess at the machine for an exercise name (the user confirms it).
const HOIST_WORDS=[
  [/leg\s*curl/i,"Leg Curl"],[/leg\s*ext/i,"Leg Extension"],[/leg\s*press/i,"Leg Press"],
  [/inner\s*thigh|adduct/i,"Inner Thigh"],[/outer\s*thigh|abduct/i,"Outer Thigh"],[/calf/i,"Rotary Calf"],
  [/chest\s*press|incline.*press/i,"Chest Press"],[/pec|fly/i,"Pec Fly"],[/shoulder\s*press/i,"Shoulder Press"],
  [/pulldown|lat\b/i,"Lat Pulldown"],[/row/i,"Seated Mid Row"],[/bicep|curl/i,"Biceps Curl"],
  [/dip|tricep/i,"Seated Dip"],[/ab(s|dominal)?\b|crunch/i,"Abdominals"],[/low\s*back|back\s*ext/i,"Low Back"],
];
export function suggestHoist(exName){
  const hit=HOIST_WORDS.find(([rx])=>rx.test(String(exName||"")));
  return hit?HOIST_MACHINES.filter(m=>m.name===hit[1]):[];
}
export function hoistName(model){const m=HOIST_MACHINES.find(x=>x.model===model);return m?`${m.model} ${m.name}`:model;}

// Weight (lb) at a level, from a fetched table.
export function hoistLb(table,level){const r=(table||[]).find(x=>x.level===Number(level));return r?r.lb:null;}
// The level for a target weight: the heaviest level at or under the target
// (+2 lb of slack for rounding), never below level 1.
export function hoistLevelFor(table,targetLb){
  if(!table||!table.length||!(targetLb>0))return null;
  const ok=table.filter(x=>x.lb<=targetLb+2);
  return (ok.length?ok[ok.length-1]:table[0]).level;
}
// Body weight the tables are computed at: kept until the current weight has
// moved 2 kg from it, so the levels don't reshuffle with daily water swings.
export function hoistBodyKg(currentKg,storedKg){
  if(!(currentKg>0))return storedKg>0?storedKg:null;
  if(storedKg>0&&Math.abs(currentKg-storedKg)<2)return storedKg;
  return Math.round(currentKg*2)/2;
}
