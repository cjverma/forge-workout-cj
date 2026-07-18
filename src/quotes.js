import { ctx } from "./runtime.js";

export const Q=[
  "We are what we repeatedly do. Excellence, then, is not an act, but a habit. - Will Durant",
  "Take care of your body. It's the only place you have to live. - Jim Rohn",
  "The body achieves what the mind believes. - Napoleon Hill",
  "Motivation is what gets you started. Habit is what keeps you going. - Jim Ryun",
  "Whether you think you can, or you think you can't, you're right. - Henry Ford",
  "If it doesn't challenge you, it doesn't change you. - Fred DeVito",
  "What hurts today makes you stronger tomorrow. - Jay Cutler",
  "Do something today that your future self will thank you for. - Sean Patrick Flanery",
  "You do not rise to the level of your goals. You fall to the level of your systems. - James Clear",
  "The clock is ticking. Are you becoming the person you want to be? - Greg Plitt",
];

let qIdx = 0;

export function quotePool() {
  const S = ctx.getS();
  return (Array.isArray(S.weeklyQuotes) && S.weeklyQuotes.length) ? S.weeklyQuotes : Q;
}

export function cycleQ() {
  const body = document.getElementById("quoteBody");
  const auth = document.getElementById("quoteAuthor");
  if (!body) return;
  const card = body.closest(".quote-card");
  const pool = quotePool();
  const q=pool[qIdx++%pool.length];
  const sep = q.lastIndexOf(" - ");
  const isFirst = !body.textContent;
  if (card && !isFirst) {
    const ov = document.createElement("div");
    ov.className = "quote-overlay";
    ov.innerHTML = `<span class="quote-body">${body.innerHTML}</span><span class="quote-author">${auth ? auth.innerHTML : ""}</span>`;
    card.appendChild(ov);
    requestAnimationFrame(() => requestAnimationFrame(() => { ov.style.opacity = 0; }));
    setTimeout(() => ov.remove(), 900);
  }
  if (sep > 0 && auth) {
    body.textContent = "“" + q.slice(0, sep) + "”";
    auth.textContent = q.slice(sep + 3);
  } else {
    body.textContent = q;
    if (auth) auth.textContent = "";
  }
}
