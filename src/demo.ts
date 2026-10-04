import type { Context } from "hono";
import type { Env } from "./env";
import { Db } from "./db/client";

/**
 * MODO DEMO — chat web público para enseñarle el bot a un prospecto.
 *
 * Se enciende con `DEMO_MODE = "on"`. Apagado por defecto: un bot de producción
 * no debe exponer un chat sin autenticar. El visitante manda POST /demo/send
 * (canal `web`, el mismo pipeline del agente) y la página recoge la respuesta
 * con GET /demo/poll.
 *
 * El cursor de ese poll es `created_at` del SERVIDOR. Si el cliente lo arma con
 * el reloj del navegador (`Date.now()`), un reloj adelantado pide mensajes
 * "del futuro" y el poll vuelve vacío aunque la respuesta ya esté en el panel.
 * Por eso la página, al cargar, pide `?after=0`, se queda con el `at` más alto
 * que ya existe y no pinta ese historial. Nunca usa el reloj del visitante.
 *
 * Tampoco corta el sondeo en la primera burbuja: con `max_chunks` las siguientes
 * llegan unos segundos después. Sigue pidiendo ~6 s desde la última burbuja.
 */

/** Tope de turnos por sesión: un demo real no pasa de unas pocas preguntas. */
const MAX_TURNS_PER_SESSION = 40;

/** Tras la última burbuja, el sondeo rápido sigue este rato por si hay más. */
export const DEMO_FOLLOW_MS = 6000;

/** Si para entonces no llegó nada, se deja de esperar y se suelta el input. */
export const DEMO_GIVE_UP_MS = 90_000;

export function demoEnabled(env: Env): boolean {
  return (env.DEMO_MODE ?? "").toLowerCase() === "on";
}

/** Cuántos mensajes del visitante lleva esta sesión (anti-abuso de costo). */
export async function demoTurnsUsed(env: Env, sessionId: string): Promise<number> {
  const db = new Db(env.DB);
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel = 'web' AND c.channel_user_id = ? AND m.role = 'user'`,
    [sessionId],
  );
  return row?.n ?? 0;
}

export function demoOverLimit(used: number): boolean {
  return used >= MAX_TURNS_PER_SESSION;
}

export interface DemoPollMessage {
  id: string;
  text: string;
  at: number;
}

/** GET /demo/poll?session=…&after=… → mensajes del bot posteriores a `after`. */
export async function demoPoll(c: Context<{ Bindings: Env }>) {
  if (!demoEnabled(c.env)) return c.json({ ok: false, error: "demo_off" }, 404);

  const sessionId = (c.req.query("session") ?? "").slice(0, 64);
  const after = Number(c.req.query("after") ?? 0) || 0;
  if (!sessionId) return c.json({ ok: false, error: "missing_session" }, 400);

  const db = new Db(c.env.DB);
  const conv = await db.first<{ id: string }>(
    "SELECT id FROM conversations WHERE channel = 'web' AND channel_user_id = ? LIMIT 1",
    [sessionId],
  );
  if (!conv) return c.json({ ok: true, messages: [] });

  const rows = await db.all<{ id: string; content: string; created_at: number }>(
    `SELECT id, content, created_at FROM messages
      WHERE conversation_id = ? AND created_at > ? AND role = 'assistant'
      ORDER BY created_at ASC LIMIT 20`,
    [conv.id, after],
  );

  const messages: DemoPollMessage[] = rows.map((r) => ({
    id: r.id,
    text: r.content,
    at: r.created_at,
  }));
  return c.json({ ok: true, messages });
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * JS del chat. El cursor (`since`) solo avanza con `at` que devolvió el
 * servidor. `seen` evita pintar dos veces la misma fila si dos sondeos se
 * cruzan. La clave es el id; si no viniera, at+texto, para no tirar una
 * segunda burbuja que compartiera milisegundo con la primera.
 */
export function demoClientScript(): string {
  return `(function(){
  var KEY='forja_demo_session';
  var sid=localStorage.getItem(KEY);
  if(!sid){ sid=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2));
            localStorage.setItem(KEY,sid); }

  var chat=document.getElementById('chat'), ta=document.getElementById('t'), btn=document.getElementById('s');
  var since=0, polling=null, followTimer=null, giveUpTimer=null, waiting=false, seen={};

  function scroll(){ chat.scrollTop=chat.scrollHeight; }
  function add(text,who,cls){
    var r=document.createElement('div'); r.className='row '+who;
    var b=document.createElement('div'); b.className='bub'+(cls?' '+cls:''); b.textContent=text;
    r.appendChild(b); chat.appendChild(r); scroll(); return r;
  }
  function typing(){
    var r=document.createElement('div'); r.className='row bot'; r.id='typing';
    r.innerHTML='<div class="bub typing"><i></i><i></i><i></i></div>';
    chat.appendChild(r); scroll(); return r;
  }
  function stopTyping(){ var e=document.getElementById('typing'); if(e) e.remove(); }

  ta.addEventListener('input',function(){ ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,120)+'px'; });
  ta.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
  btn.addEventListener('click',send);

  function clave(m){ return m.id || (String(m.at)+"\\n"+m.text); }
  function tomar(m, pintar){
    var k=clave(m);
    if(seen[k]) return false;
    seen[k]=1;
    if(typeof m.at==='number' && m.at>since) since=m.at;
    if(pintar) add(m.text,'bot');
    return true;
  }

  function pararSondeo(){
    if(polling){ clearInterval(polling); polling=null; }
  }

  function poll(){
    fetch('/demo/poll?session='+encodeURIComponent(sid)+'&after='+since)
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(!d||!d.ok||!d.messages||!d.messages.length) return;
        var nuevos=0;
        d.messages.forEach(function(m){ if(tomar(m,true)) nuevos++; });
        if(!nuevos) return;
        stopTyping();
        // No cerrar en la primera burbuja: las siguientes (max_chunks) llegan
        // un poco después. El reloj de gracia corre desde la ÚLTIMA.
        if(followTimer) clearTimeout(followTimer);
        followTimer=setTimeout(function(){
          followTimer=null;
          waiting=false; btn.disabled=false;
          pararSondeo();
        }, ${DEMO_FOLLOW_MS});
      }).catch(function(){});
  }

  // Una sola sincronización, al cargar, y el envío espera a que termine.
  // Así el cursor sale del servidor y un poll tardío no se traga la respuesta
  // que acaba de generar el turno (la marcaría como "ya vista" sin pintarla).
  var listo=new Promise(function(resolve){
    fetch('/demo/poll?session='+encodeURIComponent(sid)+'&after=0')
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d&&d.ok&&d.messages) d.messages.forEach(function(m){ tomar(m,false); });
      })
      .catch(function(){})
      .then(resolve);
  });

  function send(){
    var text=ta.value.trim(); if(!text||waiting) return;
    waiting=true; btn.disabled=true;
    listo.then(function(){
      add(text,'me'); ta.value=''; ta.style.height='auto';
      typing();
      fetch('/demo/send',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sessionId:sid,text:text})})
        .then(function(r){ return r.json().catch(function(){ return {ok:r.ok}; }); })
        .then(function(d){
          if(d&&d.ok===false){
            stopTyping(); waiting=false; btn.disabled=false;
            add(d.error==='limit'
                ? ${JSON.stringify("Se acabó la demo 🙂 Escríbele al dueño para seguir la conversación.")}
                : ${JSON.stringify("Ups, algo falló. Intenta de nuevo.")},'bot','err');
            return;
          }
          pararSondeo();
          if(followTimer){ clearTimeout(followTimer); followTimer=null; }
          polling=setInterval(poll,1200);
          if(giveUpTimer) clearTimeout(giveUpTimer);
          giveUpTimer=setTimeout(function(){
            giveUpTimer=null;
            if(!waiting) return;
            stopTyping(); waiting=false; btn.disabled=false;
            pararSondeo();
            if(followTimer){ clearTimeout(followTimer); followTimer=null; }
          }, ${DEMO_GIVE_UP_MS});
        })
        .catch(function(){ stopTyping(); waiting=false; btn.disabled=false;
                           add(${JSON.stringify("Sin conexión. Revisa tu internet.")},'bot','err'); });
    });
  }
})();`;
}

/** GET /demo → la página de chat, con la marca del negocio. */
export function demoPage(c: Context<{ Bindings: Env }>) {
  if (!demoEnabled(c.env)) return c.text("Not found", 404);

  const business = esc(c.env.BUSINESS_NAME || "Tu negocio");
  const bot = esc(c.env.BOT_NAME || business);
  const initial = (c.env.BUSINESS_NAME || c.env.BOT_NAME || "•").trim().charAt(0).toUpperCase() || "•";

  return c.html(`<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${bot}</title>
<meta name="theme-color" content="#0e1116">
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  :root{--bg:#0e1116;--panel:#161b22;--line:#232a34;--ink:#e9edf2;--dim:#9aa4b2;
        --me:#2f6df6;--bot:#1c222c;--accent:#FF6A00}
  html,body{height:100%}
  body{background:var(--bg);color:var(--ink);
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       display:flex;flex-direction:column;overscroll-behavior:none}
  header{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--panel);
         border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2;
         padding-top:calc(14px + env(safe-area-inset-top))}
  .avatar{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#ff9a4d);
          display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;color:#111;flex:0 0 auto}
  .who{min-width:0}
  .who b{display:block;font-size:15px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .who span{font-size:12px;color:#3ddc84;display:flex;align-items:center;gap:5px;margin-top:2px}
  .dot{width:7px;height:7px;border-radius:50%;background:#3ddc84;display:inline-block}
  main{flex:1;overflow-y:auto;padding:18px 14px 8px;display:flex;flex-direction:column;gap:10px}
  .row{display:flex;max-width:82%}
  .row.me{align-self:flex-end;justify-content:flex-end}
  .row.bot{align-self:flex-start}
  .bub{padding:11px 14px;border-radius:18px;font-size:15px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}
  .me .bub{background:var(--me);border-bottom-right-radius:5px}
  .bot .bub{background:var(--bot);border:1px solid var(--line);border-bottom-left-radius:5px}
  .typing{display:flex;gap:4px;padding:14px 16px}
  .typing i{width:7px;height:7px;border-radius:50%;background:var(--dim);animation:b 1.3s infinite}
  .typing i:nth-child(2){animation-delay:.18s}.typing i:nth-child(3){animation-delay:.36s}
  @keyframes b{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}
  footer{padding:12px 14px calc(12px + env(safe-area-inset-bottom));background:var(--panel);
         border-top:1px solid var(--line);display:flex;gap:10px;align-items:flex-end}
  textarea{flex:1;resize:none;background:#0e1116;color:var(--ink);border:1px solid var(--line);
           border-radius:20px;padding:11px 15px;font:inherit;font-size:15px;max-height:120px;outline:none}
  textarea:focus{border-color:var(--me)}
  button{background:var(--me);color:#fff;border:none;border-radius:50%;width:42px;height:42px;
         font-size:18px;cursor:pointer;flex:0 0 auto;transition:.15s}
  button:disabled{opacity:.4;cursor:default}
  .note{text-align:center;font-size:11.5px;color:var(--dim);padding:8px 16px 14px}
  .err{background:#3a1d1d;border:1px solid #66302f;color:#ffb3ae}
</style></head>
<body>
  <header>
    <div class="avatar">${esc(initial)}</div>
    <div class="who"><b>${bot}</b><span><i class="dot"></i>En línea</span></div>
  </header>
  <main id="chat">
    <div class="row bot"><div class="bub">¡Hola! Soy el asistente de ${business}. ¿En qué te puedo ayudar?</div></div>
  </main>
  <footer>
    <textarea id="t" rows="1" placeholder="Escribe tu mensaje…" autocomplete="off"></textarea>
    <button id="s" aria-label="Enviar">➤</button>
  </footer>
  <div class="note">Demo de ${business} · atendido por IA</div>
<script>
${demoClientScript()}
</script>
</body></html>`);
}
