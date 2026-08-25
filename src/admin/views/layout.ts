// Dashboard shell: a fixed 248px sidebar (grouped navigation) + a live-status
// topbar, wrapping each tab's server-rendered body. Retro-terminal dark theme
// ("Forja admin"): Space Grotesk + JetBrains Mono, brutalist buttons, scan
// lines. Design tokens are exposed both as CSS custom properties (for inline
// styles) and mapped to Tailwind color names (for utility classes) — see
// docs/design-system.md, the contract every view follows.
//
// The layout() API is unchanged: views keep their own activeTab id; the group,
// breadcrumb and page title are derived here.

import type { Env } from "../../env";
import { isPro, PRO_ONLY_TABS } from "../../config";
import { getNiche } from "../../niches";
import type { NichePack } from "../../niches";
import { temaClaro } from "./temaClaro";

const UPGRADE_URL = "/admin/upgrade";

interface Item {
  id: string;
  label: string;
  href: string;
  icon: string; // lucide icon name
}

interface Section {
  label: string;
  items: Item[];
}

// Navigation model. The item ids + hrefs are load-bearing (views and tests
// depend on them) — do not rename them. Icons are lucide names.
const NAV: Section[] = [
  {
    label: "Inicio",
    items: [{ id: "overview", label: "Resumen", href: "/admin/overview", icon: "layout-dashboard" }],
  },
  {
    label: "Bandeja",
    items: [
      { id: "conversations", label: "Conversaciones", href: "/admin/conversations", icon: "messages-square" },
      { id: "leads", label: "Leads", href: "/admin/leads", icon: "user-plus" },
      { id: "tickets", label: "Tickets", href: "/admin/tickets", icon: "life-buoy" },
      { id: "campanas", label: "Campañas", href: "/admin/campanas", icon: "megaphone" },
    ],
  },
  {
    label: "Mi Agente",
    items: [
      { id: "agente", label: "Flujo", href: "/admin/agente", icon: "workflow" },
      { id: "kb", label: "Conocimiento", href: "/admin/kb", icon: "book-open" },
      { id: "mejoras", label: "Mejoras", href: "/admin/mejoras", icon: "sparkles" },
      { id: "conexiones", label: "Conexiones", href: "/admin/conexiones", icon: "plug-zap" },
      { id: "config", label: "Configuración", href: "/admin/config", icon: "sliders-horizontal" },
    ],
  },
  {
    label: "Análisis",
    items: [
      { id: "insights", label: "Insights", href: "/admin/insights", icon: "scan-eye" },
      { id: "stats", label: "Estadísticas", href: "/admin/stats", icon: "bar-chart-3" },
      { id: "costs", label: "Costos", href: "/admin/costs", icon: "receipt" },
    ],
  },
];

// <head> assets: fonts, Tailwind CDN + token config, lucide, htmx.
const HEAD_ASSETS = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            bg: "#141009",
            panel: "#1d1710",
            panel2: "#241c13",
            raise: "#2b2116",
            line: "#352a1d",
            linelit: "#4c3a26",
            accent: { DEFAULT: "#f07a3f", soft: "rgba(240,122,63,.14)" },
            accent2: "#f5a623",
            cream: "#efe7da",
            muted: "#a1907b",
            dim: "#726555",
            ok: "#7fb77e",
            info: "#7aa2d6",
            bad: "#d97a6a",
            violet: "#b99bd6",
          },
          fontFamily: {
            display: ["'Space Grotesk'", "ui-sans-serif", "system-ui", "sans-serif"],
            mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
          },
        },
      },
    };
  </script>
  <script src="https://unpkg.com/lucide@latest"></script>`;

// Global stylesheet: design tokens, base type/scroll, the reusable component
// classes from the mockups (buttons, rows, cards, chips, canvas nodes), the
// modal/toast/range classes existing views already depend on, and the scanline
// overlay. All motion collapses under prefers-reduced-motion.
const GLOBAL_STYLE = `
<style>
  :root{
    --bg:#141009; --panel:#1d1710; --panel2:#241c13; --raise:#2b2116;
    --line:#352a1d; --linelit:#4c3a26;
    --accent:#f07a3f; --accent-2:#f5a623; --accent-soft:rgba(240,122,63,.14);
    --cream:#efe7da; --muted:#a1907b; --dim:#726555;
    --ok:#7fb77e; --info:#7aa2d6; --bad:#d97a6a; --violet:#b99bd6;
    /* legacy aliases kept so mockup-derived snippets keep working */
    --border:#352a1d; --border-lit:#4c3a26; --green:#7fb77e; --blue:#7aa2d6; --red:#d97a6a;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--cream);
    font-family:'JetBrains Mono',ui-monospace,monospace;-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}
  a:hover{color:var(--accent-2)}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-track{background:var(--bg)}
  ::-webkit-scrollbar-thumb{background:var(--linelit);border-radius:0}
  ::-webkit-scrollbar-thumb:hover{background:var(--accent)}
  input,textarea,select{font-family:inherit}
  input::placeholder,textarea::placeholder{color:var(--dim)}
  input[type="range"]{accent-color:var(--accent);height:4px}

  /* keyframes */
  @keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.82)}}
  @keyframes ring{0%{box-shadow:0 0 0 0 rgba(127,183,126,.5)}100%{box-shadow:0 0 0 8px rgba(127,183,126,0)}}
  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes popIn{from{opacity:0;transform:scale(.94) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}
  @keyframes toastIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  @keyframes toastOut{to{opacity:0;transform:translateY(8px);visibility:hidden}}

  /* scanline overlay (applied to <body>) */
  .scanlines::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:200;
    background:repeating-linear-gradient(to bottom,rgba(0,0,0,0) 0,rgba(0,0,0,0) 2px,rgba(0,0,0,.12) 3px,rgba(0,0,0,0) 4px);
    opacity:.5;mix-blend-mode:multiply}

  /* sidebar nav */
  .navlink:hover{background:var(--panel2);color:var(--cream)}
  .navlink:hover [data-lucide]{color:var(--accent)}

  /* entrance + brutalist buttons */
  .card{animation:rise .4s cubic-bezier(.16,1,.3,1) both}
  .bigbtn{transition:transform .12s ease,box-shadow .12s ease}
  .bigbtn:hover{transform:translate(-2px,-2px);box-shadow:6px 6px 0 var(--linelit)}
  .bigbtn:active{transform:translate(0,0);box-shadow:2px 2px 0 var(--linelit)}
  .ghostbtn:hover{border-color:var(--accent);color:var(--cream);background:var(--accent-soft)}
  .glow{text-shadow:0 0 22px var(--accent-soft),0 0 40px rgba(240,122,63,.1)}

  /* list / table rows + interactive bits reused across views */
  .convrow:hover{background:var(--panel2)}
  .convrow:hover .arr{opacity:1;transform:translateX(0)}
  .leadrow:hover{background:var(--panel2)}
  .datarow:hover{background:var(--panel2)}
  .kbrow:hover{background:var(--panel2)}
  .kbrow:hover .kbedit{border-color:var(--accent);color:var(--accent)}
  .tkcard{transition:transform .12s ease,border-color .12s ease}
  .tkcard:hover{border-color:var(--linelit);transform:translateY(-1px)}
  .subtab{transition:all .12s ease;cursor:pointer}
  .subtab:hover{color:var(--cream)}
  .chip:hover{border-color:var(--accent);color:var(--accent)}
  .cfgcard{transition:all .12s ease;cursor:pointer}
  .cfgcard:hover{border-color:var(--linelit)}
  .bar{transition:transform .5s cubic-bezier(.16,1,.3,1)}
  .bargrp:hover .bar{background:var(--accent) !important}

  /* flow-canvas node (mockup ".node") + the existing views' ".node-card" */
  .node{transition:transform .14s ease,border-color .14s ease,box-shadow .14s ease;cursor:pointer}
  .node:hover{transform:translateY(-2px);border-color:var(--accent);box-shadow:4px 4px 0 var(--linelit)}
  .node-card{transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease}
  .node-card:hover{transform:translateY(-2px);border-color:var(--accent);box-shadow:4px 4px 0 var(--linelit)}

  /* modal + toast (class names kept from prior layout for existing views) */
  .modal-backdrop{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;
    padding:1rem;background:rgba(10,8,4,.6);animation:fadeIn .15s ease-out}
  .modal-card{background:var(--panel);border:1px solid var(--linelit);box-shadow:8px 8px 0 rgba(0,0,0,.4);
    animation:popIn .18s cubic-bezier(.16,1,.3,1);transform-origin:center}
  .toast{background:var(--panel);border:1px solid var(--linelit);color:var(--cream);box-shadow:4px 4px 0 var(--linelit);
    animation:toastIn .25s cubic-bezier(.16,1,.3,1),toastOut .3s ease-in 2.4s forwards}

  /* app shell */
  .shell{min-height:100vh;display:grid;grid-template-columns:248px 1fr;background:var(--bg)}
  .sb{border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
  .sb-nav{padding:14px 12px;display:flex;flex-direction:column;gap:2px;flex:1;overflow-y:auto}
  .sb-sec{font-size:9.5px;letter-spacing:.24em;text-transform:uppercase;padding:14px 10px 6px}
  .live-pill{display:flex;align-items:center;gap:9px;background:var(--panel);border:1px solid var(--line);padding:8px 13px}

  @media (max-width:767px){
    .shell{grid-template-columns:1fr}
    .sb{position:sticky;top:0;height:auto;flex-direction:row;align-items:center;border-right:none;border-bottom:1px solid var(--line);overflow-x:auto}
    .sb-brand{flex:none;border-bottom:none !important;border-right:1px solid var(--line)}
    .sb-nav{flex-direction:row;align-items:center;gap:4px;padding:8px 10px;overflow-y:visible;overflow-x:auto}
    .sb-sec{display:none}
    .sb-foot{display:none}
    .navlink{border-left:none !important;white-space:nowrap;border-bottom:2px solid transparent}
  }

  @media (prefers-reduced-motion:reduce){
    .card,.toast,.modal-backdrop,.modal-card{animation:none}
    .bigbtn,.ghostbtn,.convrow,.leadrow,.datarow,.kbrow,.tkcard,.subtab,.chip,.cfgcard,.node,.node-card,.bar,.navlink{transition:none}
    .bigbtn:hover,.node:hover,.node-card:hover,.tkcard:hover{transform:none}
    .animate-pulse,[style*="animation"]{animation:none !important}
  }
</style>`;

// Re-run lucide after every htmx swap (fragments bring fresh icons) and close
// any open modal with Escape.
const GLOBAL_SCRIPT = `
<script>
  function drawIcons(){ if (window.lucide) window.lucide.createIcons(); }
  document.addEventListener("DOMContentLoaded", drawIcons);
  // lucide's unpkg script may resolve after DOMContentLoaded — retry briefly.
  (function(){ var n=0; var t=setInterval(function(){ if(window.lucide){drawIcons();clearInterval(t);} if(++n>25) clearInterval(t); },120); })();
  document.body.addEventListener("htmx:afterSwap", drawIcons);
  document.body.addEventListener("htmx:oobAfterSwap", drawIcons);
  // Pausa del polling: no refresques el inbox mientras el usuario lee (o si la
  // pestaña está en segundo plano). htmx evalúa este filtro en cada tick de
  // 'every Ns[...]' y solo dispara la petición si devuelve true. En el hilo
  // (contenedor flex column-reverse) "al día" = scroll pegado al final, donde
  // scrollTop ≈ 0; leer historial lo aleja (positivo en Chrome, negativo en
  // Firefox), de ahí el Math.abs. Al volver al final, el siguiente tick se pone
  // al día solo.
  window.puedeRefrescar = function(id){
    if (document.hidden) return false;
    var el = document.getElementById(id);
    if (!el) return true;
    return Math.abs(el.scrollTop) < 40;
  };
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape") {
      var root = document.getElementById("modal-root");
      if (root) root.innerHTML = "";
    }
  });
</script>`;

function navItem(item: Item, active: boolean): string {
  const base =
    "display:flex;align-items:center;gap:11px;padding:9px 10px;font-size:13px;";
  const style = active
    ? base + "color:var(--cream);background:var(--accent-soft);border-left:2px solid var(--accent);font-weight:600"
    : base + "color:var(--muted);border-left:2px solid transparent";
  const iconColor = active ? "var(--accent)" : "var(--dim)";
  return `<a href="${item.href}" class="navlink" style="${style}">
    <i data-lucide="${item.icon}" width="17" height="17" style="color:${iconColor}"></i> ${item.label}
  </a>`;
}

// Tier free: los tabs Pro se muestran bloqueados (candado + tag PRO) y llevan a
// la página de upgrade en vez de a la vista real. Se ven, pero invitan a subir.
function navItemLocked(item: Item): string {
  const base =
    "display:flex;align-items:center;gap:11px;padding:9px 10px;font-size:13px;color:var(--dim);border-left:2px solid transparent";
  return `<a href="${UPGRADE_URL}" class="navlink" style="${base}" title="Disponible en Pro">
    <i data-lucide="lock" width="15" height="15" style="color:var(--dim)"></i> ${item.label}
    <span style="margin-left:auto;font-size:8.5px;letter-spacing:.14em;color:var(--accent2);border:1px solid var(--line);padding:1px 5px">PRO</span>
  </a>`;
}

// El pack de nicho re-etiqueta el item "leads" (ej. "Leads" → "Reservaciones").
// El id y el href NO cambian (son load-bearing); solo la etiqueta y el ícono.
function applyNiche(item: Item, niche: NichePack | null): Item {
  if (!niche || niche.id === "generico" || item.id !== "leads") return item;
  return { ...item, label: niche.navLabel, icon: niche.navIcon };
}

function sidebar(activeTab: string, pro: boolean, niche: NichePack | null): string {
  const locked = (id: string) => !pro && (PRO_ONLY_TABS as readonly string[]).includes(id);
  const sections = NAV.map((sec) => {
    const hasActive = sec.items.some((i) => i.id === activeTab);
    const labelColor = hasActive ? "var(--accent)" : "var(--dim)";
    const items = sec.items
      .map((raw) => {
        const i = applyNiche(raw, niche);
        return locked(i.id) ? navItemLocked(i) : navItem(i, i.id === activeTab);
      })
      .join("");
    return `<div class="sb-sec" style="color:${labelColor}">${sec.label}</div>${items}`;
  }).join("");

  return `<aside class="sb">
    <div class="sb-brand" style="padding:20px 18px 16px;border-bottom:1px solid var(--line)">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:34px;height:34px;flex:none;border:1.5px solid var(--accent);display:flex;align-items:center;justify-content:center;background:var(--accent-soft);box-shadow:3px 3px 0 var(--linelit)">
          <i data-lucide="terminal" width="18" height="18" style="color:var(--accent)"></i>
        </div>
        <div style="line-height:1.05">
          <div style="font-family:'Space Grotesk';font-weight:700;font-size:15px;letter-spacing:-.02em">Forja</div>
          <div style="font-size:9.5px;letter-spacing:.22em;color:var(--dim);text-transform:uppercase">Panel · ${pro ? "Pro" : "Free"}</div>
        </div>
      </div>
    </div>
    <nav class="sb-nav">${sections}</nav>
    <div class="sb-foot" style="padding:14px;border-top:1px solid var(--line)">
      <div style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line)">
        <div style="width:30px;height:30px;flex:none;background:var(--raise);border:1px solid var(--linelit);display:flex;align-items:center;justify-content:center;color:var(--accent)">
          <i data-lucide="bot" width="16" height="16"></i>
        </div>
        <div style="line-height:1.2;overflow:hidden">
          <div style="font-size:12px;font-weight:600;white-space:nowrap;text-overflow:ellipsis;overflow:hidden">Panel del bot</div>
          <div style="font-size:10px;color:var(--dim)">sesión activa</div>
        </div>
      </div>
    </div>
  </aside>`;
}

export function layout(opts: { title: string; activeTab: string; body: string; env?: Env }): string {
  // Tier: si se pasa env, el nav Pro se bloquea para free. Sin env (ej. notFound)
  // se asume Pro para no ocultar nada por accidente.
  const pro = opts.env ? isPro(opts.env) : true;
  const niche = opts.env ? getNiche(opts.env) : null;
  const section = NAV.find((s) => s.items.some((i) => i.id === opts.activeTab)) ?? NAV[0];
  const item = applyNiche(section.items.find((i) => i.id === opts.activeTab) ?? section.items[0], niche);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.title}</title>
  ${HEAD_ASSETS}
  ${GLOBAL_STYLE}
  ${temaClaro(opts.env)}
</head>
<body class="scanlines">
  <div class="shell">
    ${sidebar(opts.activeTab, pro, niche)}
    <div style="display:flex;flex-direction:column;min-width:0">
      <header style="position:sticky;top:0;z-index:30;background:rgba(20,16,9,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 26px;display:flex;align-items:center;gap:20px">
        <div style="min-width:0">
          <div style="font-size:10px;letter-spacing:.22em;color:var(--dim);text-transform:uppercase">${section.label} / ${item.label}</div>
          <h1 style="font-family:'Space Grotesk';font-weight:700;font-size:22px;margin:2px 0 0;letter-spacing:-.02em">${item.label}</h1>
        </div>
        <div id="proj-switcher" style="margin-left:auto"></div>
        <div class="live-pill">
          <span style="width:8px;height:8px;border-radius:50%;background:var(--ok);animation:pulse 1.8s ease-in-out infinite,ring 2s infinite"></span>
          <span style="font-size:11px;font-weight:600;letter-spacing:.04em">BOT EN LÍNEA</span>
        </div>
      </header>
      <main style="padding:22px 26px;min-width:0">${opts.body}</main>
    </div>
  </div>
  <div id="modal-root"></div>
  <script>
  // Selector de proyectos: si esta instancia declara PEER_BOTS, el header
  // muestra un dropdown para brincar entre bots (cada uno con su panel).
  fetch('/admin/projects').then(function(r){ return r.ok ? r.json() : null }).then(function(d){
    if (!d || !d.peers || d.peers.length === 0) return;
    var el = document.getElementById('proj-switcher');
    if (!el) return;
    var opts = '<option selected>' + d.current.replace(/</g,'&lt;') + '</option>';
    d.peers.forEach(function(p){
      opts += '<option value="' + p.url.replace(/"/g,'&quot;') + '">' + p.name.replace(/</g,'&lt;') + '</option>';
    });
    // Las comillas simples van como &#39;: este bloque vive dentro de un
    // template literal, así que los \' del código fuente NO llegan al navegador
    // y cerraban la cadena JS de golpe (SyntaxError en cada carga del panel).
    // El parser de HTML las decodifica antes de que corran el onchange y el CSS.
    el.innerHTML = '<select onchange="if(this.value.indexOf(&#39;http&#39;)===0)window.location=this.value" ' +
      'style="background:rgba(20,16,9,.9);color:var(--fg,#e8e0cf);border:1px solid var(--line);border-radius:8px;' +
      'padding:6px 10px;font-family:&#39;JetBrains Mono&#39;,monospace;font-size:11px;letter-spacing:.04em;cursor:pointer" ' +
      'title="Cambiar de proyecto">' + opts + '</select>';
  }).catch(function(){});
  </script>
  <div id="toast-root" style="position:fixed;bottom:1rem;right:1rem;z-index:60"></div>
  ${GLOBAL_SCRIPT}
</body>
</html>`;
}

// Página de upgrade: se muestra cuando un panel free intenta abrir un tab Pro
// (o al hacer click en un item bloqueado). Vive dentro del layout para conservar
// el nav. `feature` es el nombre del tab que pidió (para personalizar el copy).
export function renderUpgrade(env: Env, feature?: string): string {
  const perks = [
    ["scan-eye", "Analista IA", "Resúmenes automáticos de cada conversación: qué querían, objeciones y oportunidad de venta."],
    ["bar-chart-3", "Estadísticas", "Métricas de volumen, retención y desempeño de tu bot en el tiempo."],
    ["receipt", "Costos", "Cuánto gasta tu bot en IA, con tope de presupuesto mensual."],
    ["sparkles", "Mejoras", "El bot detecta huecos en su conocimiento y se mejora solo (flywheel)."],
    ["megaphone", "Campañas", "Manda difusiones y seguimientos por WhatsApp a tus segmentos."],
  ]
    .map(
      ([icon, title, desc]) => `<div style="display:flex;gap:12px;padding:14px;border:1px solid var(--line);background:var(--panel)">
        <i data-lucide="${icon}" width="20" height="20" style="color:var(--accent);flex:none;margin-top:2px"></i>
        <div><div style="font-family:'Space Grotesk';font-weight:600;font-size:14px;margin-bottom:3px">${title}</div>
        <div style="font-size:12.5px;color:var(--muted);line-height:1.5">${desc}</div></div>
      </div>`,
    )
    .join("");

  const body = `
    <div class="card" style="max-width:720px">
      <div style="border:1px solid var(--linelit);background:var(--panel);box-shadow:6px 6px 0 var(--linelit);padding:28px">
        <div style="display:inline-flex;align-items:center;gap:8px;border:1px solid var(--accent);color:var(--accent2);font-size:10px;letter-spacing:.16em;padding:4px 10px;text-transform:uppercase">
          <i data-lucide="lock" width="13" height="13"></i> Función Pro
        </div>
        <h2 style="font-family:'Space Grotesk';font-weight:700;font-size:24px;letter-spacing:-.02em;margin:14px 0 6px">
          ${feature ? `“${feature}” es parte de Pro` : "Desbloquea el panel Pro"}
        </h2>
        <p style="font-size:13.5px;color:var(--muted);line-height:1.6;margin:0 0 20px;max-width:560px">
          Tu bot Starter ya atiende clientes, responde con tu conocimiento y captura leads.
          El panel <b style="color:var(--cream)">Pro</b> le suma el cerebro analítico y de crecimiento:
        </p>
        <div style="display:grid;gap:10px;margin-bottom:22px">${perks}</div>
        <a href="https://horizontesia.com" target="_blank" rel="noopener" class="bigbtn"
          style="display:inline-flex;align-items:center;gap:8px;background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:4px 4px 0 var(--linelit);padding:12px 20px;font-family:'Space Grotesk';font-weight:700;font-size:14px">
          <i data-lucide="arrow-up-right" width="17" height="17"></i> Subir a Pro con la comunidad
        </a>
      </div>
    </div>`;
  return layout({ title: "Pro", activeTab: "overview", body, env });
}

export function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login</title>
  ${HEAD_ASSETS}
  ${GLOBAL_STYLE}
</head>
<body class="scanlines" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem">
  <form method="POST" action="/admin/auth/request" style="background:var(--panel);border:1px solid var(--linelit);box-shadow:8px 8px 0 var(--linelit);padding:32px;max-width:360px;width:100%">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
      <div style="width:34px;height:34px;flex:none;border:1.5px solid var(--accent);display:flex;align-items:center;justify-content:center;background:var(--accent-soft);box-shadow:3px 3px 0 var(--linelit)">
        <i data-lucide="terminal" width="18" height="18" style="color:var(--accent)"></i>
      </div>
      <div>
        <h1 style="font-family:'Space Grotesk';font-weight:700;font-size:18px;margin:0;letter-spacing:-.02em">Dashboard del bot</h1>
        <p style="font-size:11px;color:var(--dim);margin:2px 0 0">Te mandamos un link a tu email para entrar.</p>
      </div>
    </div>
    ${error ? `<p style="color:var(--bad);font-size:12px;margin:0 0 12px">${error}</p>` : ""}
    <input name="email" type="email" required placeholder="tu@email.com"
      style="width:100%;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:10px 12px;font-size:13px;outline:none;margin-bottom:14px">
    <button class="bigbtn" type="submit"
      style="width:100%;background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:4px 4px 0 var(--linelit);padding:11px;font-family:'Space Grotesk';font-weight:700;font-size:13px;cursor:pointer">
      Mandar link
    </button>
  </form>
  ${GLOBAL_SCRIPT}
</body>
</html>`;
}
