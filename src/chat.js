import { ctx } from "./runtime.js";
import { isoToday } from "./phase.js";
import { esc, mdLite, showToast } from "./ui.js";
import { save } from "./state.js";
import { API_CFG, queueMutation } from "./sync.js";

// ── AI CHAT ──────────────────────────────────────────────────────────────────
function sanitizeCtx(str,max=100){return String(str||"").slice(0,max).replace(/[<>{}\[\]]/g,"");}
function buildChatContext(){
  const today=isoToday();
  const dayData=S.nutrition.days[today]||{};
  const consumed=(dayData.items||[]).reduce((a,i)=>a+i.kcal,0);
  const active=dayData.active||0;
  const currentWeight=latestWeightLog()||USER.weightKg;
  // Respect the day's custom resting-calorie override (tap-to-edit), else formula BMR
  const bmr=dayData.restingOverride!=null?dayData.restingOverride:calcBMR(currentWeight);
  const{target,req:dailyDeficitReq,phase}=calcTarget(bmr,Math.round(active*ACTIVE_MULT),today);
  const daysLeft=Math.max(1,Math.ceil((USER.goalDate-Date.now())/86400000));
  // Explicit goal framing so AI knows this is a weight-loss context
  const phaseCtx=phase?(()=>{
    const cor=phaseCorridor(phase,today);
    const banked=bankedDays(phase,today);
    const comp=weekCompliance(phase,mondayOfIso(today),today);
    return{id:phase.id,strategy:phase.strategy,endsEffective:effectiveEnd(phase,today),
      eatKcal:phase.eatKcal,activeTargetToday:phaseActiveTarget(phase,today),activeSoFar:active,
      targetRangeToday:[cor.lo,cor.hi],bankedDays:banked?banked.days:null,
      weekCompliance:comp.calculating?null:comp.overall,expectedDeficitToday:dailyDeficitReq};
  })():null;
  const goal={
    type:"weight loss",
    currentKg:currentWeight,
    targetKg:USER.targetKg,
    remainingKg:Math.round((currentWeight-USER.targetKg)*10)/10,
    goalDate:isoDate(USER.goalDate),
    daysLeft,
    dailyDeficitRequired:dailyDeficitReq,
    phase:phaseCtx,
    intakeTargetToday:target,
    consumedToday:consumed,
    remainingToday:target-consumed,
    activeCaloriesToday:active,
    bmr,
    fibreToday:(dayData.items||[]).reduce((s,i)=>s+(i.fibre||0),0),
    fibreTarget:FIBRE_TARGET,
    sugarToday:(dayData.items||[]).reduce((s,i)=>s+(i.sugar||0),0),
    sodiumTodayMg:(dayData.items||[]).reduce((s,i)=>s+(i.sodium||0),0)
  };
  const sessions=Object.entries(S.sessions||{})
    .sort(([a],[b])=>b.localeCompare(a)).slice(0,7)
    .map(([date,sess])=>({date,day:sanitizeCtx(sess.day,20),
      setsLogged:sess.logs?Object.values(sess.logs).flat().length:0,
      calfEvents:sess.calfCount||0,notes:sanitizeCtx(sess.notes,100)}));
  const weights=Object.entries(S.nutrition.weights||{})
    .sort(([a],[b])=>b.localeCompare(a)).slice(0,5)
    .map(([date,kg])=>({date,kg}));
  const todayItems=(dayData.items||[]).slice(0,10)
    .map(i=>({name:sanitizeCtx(i.name,50),kcal:i.kcal,protein:i.protein||0,carbs:i.carbs||0,fat:i.fat||0,fibre:i.fibre||0,sugar:i.sugar||0,sodiumMg:i.sodium||0}));
  return{today,goal,sessions,weights,todayItems};
}
function renderAiChatBubbles(){
  if(!S.aiChat||!S.aiChat.length){
    return`<div class="ai-chat-empty"><div class="ai-chat-empty-icon">🤖</div><div class="ai-chat-empty-ttl">Ask Forge anything</div><div class="ai-chat-empty-sub">Nutrition, exercises, progress, calf pain — I've got context on your training and logs.</div></div>`;
  }
  return S.aiChat.slice(-20).map(m=>m.role==="user"
    ?`<div class="chat-bubble chat-user">${esc(m.text)}</div>`
    :`<div class="chat-ai-row"><div class="chat-ai-avatar">🤖</div><div class="chat-bubble chat-ai">${mdLite(m.text)}</div></div>`
  ).join("");
}
function scrollChatBottom(){const el=document.getElementById("aiChatMessages");if(el)el.scrollTop=el.scrollHeight;}
function openForgeChat(){
  const overlay=document.getElementById("forgeChatOverlay");
  const modal=document.getElementById("forgeChatModal");
  const msgs=document.getElementById("aiChatMessages");
  if(msgs)msgs.innerHTML=renderAiChatBubbles();
  if(overlay)overlay.classList.add("open");
  if(modal)modal.classList.add("open");
  requestAnimationFrame(()=>{ scrollChatBottom(); const inp=document.getElementById("aiChatInp"); if(inp)inp.focus(); });
}
export function closeForgeChat(){
  document.getElementById("forgeChatOverlay")?.classList.remove("open");
  document.getElementById("forgeChatModal")?.classList.remove("open");
}
function clearAiChat(){S.aiChat=[];save();queueMutation("ai_chat_clear",{});const el=document.getElementById("aiChatMessages");if(el)el.innerHTML=renderAiChatBubbles();}
function typewriterBubble(text,onDone){
  const msgs=document.getElementById("aiChatMessages");
  if(!msgs){onDone&&onDone();return;}
  const empty=msgs.querySelector(".ai-chat-empty");
  if(empty)empty.remove();
  const row=document.createElement("div");
  row.className="chat-ai-row";
  row.innerHTML='<div class="chat-ai-avatar">🤖</div>';
  const bubble=document.createElement("div");
  bubble.className="chat-bubble chat-ai";
  row.appendChild(bubble);
  msgs.appendChild(row);
  scrollChatBottom();
  let i=0;
  const CHUNK=3;
  const tick=setInterval(()=>{
    i=Math.min(i+CHUNK,text.length);
    bubble.innerHTML=mdLite(text.slice(0,i));
    scrollChatBottom();
    if(i>=text.length){clearInterval(tick);onDone&&onDone();}
  },18);
}
async function sendAiChat(){
  const inp=document.getElementById("aiChatInp");
  const btn=document.getElementById("aiChatSend");
  if(!inp)return;
  const text=inp.value.trim().slice(0,500);
  if(!text)return;
  inp.value="";
  if(!S.aiChat)S.aiChat=[];
  S.aiChat.push({role:"user",text,ts:Date.now()});
  queueMutation("ai_chat_add",{role:"user",content:text});
  if(S.aiChat.length>20)S.aiChat=S.aiChat.slice(-20);
  save();
  const msgs=document.getElementById("aiChatMessages");
  if(msgs){msgs.innerHTML=renderAiChatBubbles();const thinking=document.createElement("div");thinking.className="chat-thinking";thinking.id="chatThinking";thinking.textContent="Thinking…";msgs.appendChild(thinking);scrollChatBottom();}
  if(btn)btn.disabled=true;
  try{
    const ctx=buildChatContext();
    const r=await fetch(API_CFG.baseUrl+"/api/coach",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+API_CFG.token},
      body:JSON.stringify({
        prompt:text,
        context:{day:"",program:"",chatContext:JSON.stringify(ctx)}
      })
    });
    const d=await r.json();
    const reply=d.text||d.error||"No response";
    S.aiChat.push({role:"ai",text:reply,ts:Date.now()});
    queueMutation("ai_chat_add",{role:"ai",content:reply});
    if(S.aiChat.length>20)S.aiChat=S.aiChat.slice(-20);
    save();
    document.getElementById("chatThinking")?.remove();
    if(btn)btn.disabled=false;
    
    typewriterBubble(reply);
    return;
  }catch(e){
    S.aiChat.push({role:"ai",text:"Sorry, I couldn't connect right now. Try again.",ts:Date.now()});
    save();
  }
  if(btn)btn.disabled=false;
  document.getElementById("chatThinking")?.remove();
  if(msgs){msgs.innerHTML=renderAiChatBubbles();scrollChatBottom();}
  
}

// ---- Pull-to-refresh ----
// Data lives in localStorage ("f5") and is saved on every mutation, so a
// reload never loses anything; we save() once more before reloading anyway.
(function(){
  const scroll=document.getElementById("mainScroll"),ind=document.getElementById("ptr");
  if(!scroll||!ind)return;
  const THRESHOLD=80;let startY=0,pulling=false,dist=0;
  scroll.addEventListener("touchstart",e=>{
    if(scroll.scrollTop<=0){startY=e.touches[0].clientY;pulling=true;dist=0;}
  },{passive:true});
  scroll.addEventListener("touchmove",e=>{
    if(!pulling)return;
    dist=e.touches[0].clientY-startY;
    if(dist<=0||scroll.scrollTop>0){ind.style.transform="translate(-50%,-48px)";return;}
    const y=Math.min(dist*0.45,72);
    ind.style.transform=`translate(-50%,${y-36}px) rotate(${dist*1.5}deg)`;
  },{passive:true});
  scroll.addEventListener("touchend",()=>{
    if(!pulling)return;pulling=false;
    if(dist>=THRESHOLD&&scroll.scrollTop<=0){
      ind.classList.add("spin");
      ind.style.transform="translate(-50%,14px)";
      try{save();}catch(_){}
      setTimeout(()=>location.reload(),300);
    }else{
      ind.style.transform="translate(-50%,-48px)";
    }
  },{passive:true});
})();

window.openForgeChat=openForgeChat;
window.closeForgeChat=closeForgeChat;
window.clearAiChat=clearAiChat;
window.sendAiChat=sendAiChat;
