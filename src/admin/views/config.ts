// Pro dashboard "Config" tab — a VISUAL CONTROL PANEL for a non-technical owner
// (e.g. a barbershop owner). No raw numbers, no "pick 1-10": every technical
// setting is a group of 2-3 selectable cards (radio + inline SVG icon + short
// label + one-line plain-Spanish description). Text settings are plain inputs /
// textareas with clear labels (no jargon). The form POSTs to /admin/config.
import type { Env } from "../../env";
import { SETTING_KEYS } from "../../db/settings";
import { renderBusinessContext } from "../../businessContext";
import { CURATED_MODELS } from "../../llm/provider";
import {
  CONTROL_LIST,
  valueToLevel,
  type ControlDef,
} from "../control-levels";
import { layout } from "./layout";

/** Escape untrusted text before interpolating it into an HTML attribute/body. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

// Brand accent = orange (Horizontes retro-terminal theme). The selected card
// lights up accent; the hidden radio drives the highlight via Tailwind's `peer`
// utilities so the whole card is clickable (it's a <label>).
const CARD_BASE =
  "peer-checked:border-accent peer-checked:bg-accent-soft " +
  "peer-checked:[&_.card-icon]:text-accent peer-checked:[&_.card-label]:text-accent " +
  "cfgcard flex flex-col gap-1 h-full border border-line bg-panel2 p-4 cursor-pointer";

/** Render one card group (radio cards) for a level-based control. */
function renderCardGroup(control: ControlDef, settings: Record<string, string>): string {
  const currentLevel = valueToLevel(control.key, settings[control.key]);
  const cards = control.options
    .map((opt) => {
      const id = `${control.key}__${opt.value}`;
      const checked = opt.label === currentLevel ? "checked" : "";
      return `
        <div class="relative">
          <input type="radio" id="${esc(id)}" name="${esc(control.key)}" value="${esc(opt.value)}"
                 class="peer sr-only absolute" ${checked}>
          <label for="${esc(id)}" class="${CARD_BASE}">
            <span class="card-icon text-dim">${opt.svg}</span>
            <span class="card-label font-display font-semibold text-[12.5px] text-cream">${esc(opt.label)}</span>
            <span class="text-dim text-[11px] leading-snug">${esc(opt.desc)}</span>
          </label>
        </div>`;
    })
    .join("");
  return `
    <fieldset style="display:flex;flex-direction:column;gap:8px">
      <legend class="font-display font-semibold text-[13.5px] text-cream">${esc(control.title)}</legend>
      <p class="text-muted text-[12px]">${esc(control.help)}</p>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">${cards}</div>
    </fieldset>`;
}

const INPUT_STYLE =
  "background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:10px 12px;font-size:12.5px;outline:none;width:100%";

/** Render a labeled single-line text field. */
function renderTextField(opts: {
  name: string;
  label: string;
  help: string;
  value: string;
  placeholder?: string;
}): string {
  return `
    <div style="display:flex;flex-direction:column;gap:6px">
      <label for="${esc(opts.name)}" class="font-display font-semibold text-[12.5px] text-cream">${esc(opts.label)}</label>
      <p class="text-dim text-[11px]">${esc(opts.help)}</p>
      <input type="text" id="${esc(opts.name)}" name="${esc(opts.name)}"
             value="${esc(opts.value)}" placeholder="${esc(opts.placeholder ?? "")}"
             style="${INPUT_STYLE}">
    </div>`;
}

/** Render a labeled multi-line textarea. */
function renderTextArea(opts: {
  name: string;
  label: string;
  help: string;
  value: string;
  placeholder?: string;
  rows?: number;
}): string {
  return `
    <div style="display:flex;flex-direction:column;gap:6px">
      <label for="${esc(opts.name)}" class="font-display font-semibold text-[12.5px] text-cream">${esc(opts.label)}</label>
      <p class="text-dim text-[11px]">${esc(opts.help)}</p>
      <textarea id="${esc(opts.name)}" name="${esc(opts.name)}" rows="${opts.rows ?? 4}"
                placeholder="${esc(opts.placeholder ?? "")}"
                style="${INPUT_STYLE};resize:vertical">${esc(opts.value)}</textarea>
    </div>`;
}

const SELECT_STYLE =
  "background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:10px 12px;font-size:12.5px;outline:none;width:100%";

/** Sección "Modelo de IA": proveedor + API key propia + modelo concreto. */
function renderLlmSection(settings: Record<string, string>, llmTest?: string): string {
  const provider = settings[SETTING_KEYS.llmProvider] ?? "";
  const model = settings[SETTING_KEYS.llmModel] ?? "";
  const hasKey = (settings[SETTING_KEYS.llmApiKey] ?? "").trim() !== "";
  const keyTail = hasKey ? (settings[SETTING_KEYS.llmApiKey] ?? "").trim().slice(-4) : "";

  const providerOpts = [
    { v: "", l: "Automático (recomendado)" },
    { v: "anthropic", l: "Claude (Anthropic)" },
    { v: "openai", l: "ChatGPT (OpenAI)" },
    { v: "xai", l: "Grok (xAI)" },
  ]
    .map((o) => `<option value="${o.v}" ${provider === o.v ? "selected" : ""}>${o.l}</option>`)
    .join("");

  const anthropicOpts = CURATED_MODELS.filter((m) => m.provider === "anthropic")
    .map((m) => `<option value="${esc(m.id)}" ${model === m.id ? "selected" : ""}>${esc(m.label)}</option>`)
    .join("");
  const openaiOpts = CURATED_MODELS.filter((m) => m.provider === "openai")
    .map((m) => `<option value="${esc(m.id)}" ${model === m.id ? "selected" : ""}>${esc(m.label)}</option>`)
    .join("");
  const xaiOpts = CURATED_MODELS.filter((m) => m.provider === "xai")
    .map((m) => `<option value="${esc(m.id)}" ${model === m.id ? "selected" : ""}>${esc(m.label)}</option>`)
    .join("");

  let testBanner = "";
  if (llmTest?.startsWith("ok:")) {
    testBanner = `<div style="border:1px solid var(--ok);background:rgba(127,183,126,.1);color:var(--ok);padding:9px 12px;font-size:12px;font-weight:600">✓ Conexión exitosa — respondió ${esc(llmTest.slice(3))}</div>`;
  } else if (llmTest?.startsWith("err:")) {
    testBanner = `<div style="border:1px solid var(--danger,#e0654d);background:rgba(224,101,77,.1);color:var(--danger,#e0654d);padding:9px 12px;font-size:12px;font-weight:600">✕ Falló la prueba: ${esc(llmTest.slice(4, 200))}</div>`;
  }

  return `
    <div class="bg-panel border border-line" style="padding:20px;display:flex;flex-direction:column;gap:18px">
      <div style="display:flex;flex-direction:column;gap:2px">
        <h3 class="font-display font-semibold text-[13.5px] text-cream">🧠 Modelo de IA</h3>
        <p class="text-dim text-[12px]">Elige qué inteligencia artificial usa tu bot. Puedes usar tu propia API key para pagar tú el consumo directamente. Si lo dejas en automático, el bot usa la configuración incluida (rápido para lo simple, inteligente para lo difícil).</p>
      </div>
      ${testBanner}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div style="display:flex;flex-direction:column;gap:6px">
          <label class="font-display font-semibold text-[12.5px] text-cream">Proveedor</label>
          <select name="${SETTING_KEYS.llmProvider}" style="${SELECT_STYLE}">${providerOpts}</select>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <label class="font-display font-semibold text-[12.5px] text-cream">Modelo</label>
          <select name="${SETTING_KEYS.llmModel}" style="${SELECT_STYLE}">
            <option value="" ${model === "" ? "selected" : ""}>Automático (rápido ⇄ inteligente)</option>
            <optgroup label="Claude (Anthropic)">${anthropicOpts}</optgroup>
            <optgroup label="ChatGPT (OpenAI)">${openaiOpts}</optgroup>
            <optgroup label="Grok (xAI)">${xaiOpts}</optgroup>
          </select>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <label class="font-display font-semibold text-[12.5px] text-cream">Tu API key (opcional)</label>
        <p class="text-dim text-[11px]">${hasKey ? `Hay una key guardada (termina en …${esc(keyTail)}). Escribe una nueva para reemplazarla, o marca la casilla para quitarla.` : "Pégala aquí para que el consumo se cobre a tu cuenta. Vacío = usar la key incluida del sistema."}</p>
        <input type="password" name="${SETTING_KEYS.llmApiKey}" value="" autocomplete="off"
               placeholder="${hasKey ? "••••••••••••" : "sk-ant-… o sk-…"}" style="${INPUT_STYLE}">
        ${hasKey ? `<label class="text-dim text-[11.5px]" style="display:flex;align-items:center;gap:7px;cursor:pointer"><input type="checkbox" name="llm_api_key_clear" value="1"> Quitar mi API key y volver a la del sistema</label>` : ""}
      </div>
      <a href="/admin/config/llm-test" class="text-[12px] font-display font-semibold"
         style="width:fit-content;border:1px solid var(--line);color:var(--cream);padding:9px 14px;text-decoration:none">⚡ Probar mi configuración (guarda primero)</a>
    </div>`;
}

/**
 * Render the Config tab. Receives the current settings overlay (Record from
 * SettingsRepo.all()). `saved` shows the "Guardado ✓" confirmation banner after
 * a redirect from POST /admin/config?saved=1.
 */
export function renderConfig(
  env: Env,
  settings: Record<string, string>,
  saved = false,
  llmTest?: string,
): string {
  const cardGroups = CONTROL_LIST.map((c) => renderCardGroup(c, settings)).join("");

  // Este campo escribe la MISMA llave que "Prompt del agente" de Mi Agente →
  // Flujo, donde el textarea viene precargado con el prompt efectivo. Aquí llega
  // vacío, así que hay que decir de frente que lo que se escriba sustituye al
  // prompt completo — no se suma a él.
  const hasPromptOverride = (settings[SETTING_KEYS.systemPromptOverride] ?? "").trim() !== "";

  const savedBanner = saved
    ? `<div style="border:1px solid var(--ok);background:rgba(127,183,126,.1);color:var(--ok);padding:10px 14px;font-size:12.5px;font-weight:600">Guardado ✓</div>`
    : "";

  const body = `
    <form method="POST" action="/admin/config" style="display:flex;flex-direction:column;gap:28px">
      ${savedBanner}

      <div style="display:flex;flex-direction:column;gap:2px">
        <h2 class="font-display font-semibold text-[15px] text-cream">Panel de control de ${esc(env.BUSINESS_NAME)}</h2>
        <p class="text-muted text-[12.5px]">Ajuste cómo se comporta su bot. Los cambios se guardan al presionar el botón de abajo.</p>
      </div>

      <!-- Card-based controls (tono, velocidad, estilo, cerebro, estado) -->
      <div class="bg-panel border border-line" style="padding:20px;display:flex;flex-direction:column;gap:22px">
        ${cardGroups}
      </div>

      <!-- Modelo de IA (BYO provider/key/model) -->
      ${renderLlmSection(settings, llmTest)}

      <!-- Free-text settings -->
      <div class="bg-panel border border-line" style="padding:20px;display:flex;flex-direction:column;gap:18px">
        ${renderTextField({
          name: SETTING_KEYS.botName,
          label: "Nombre del bot",
          help: "Cómo se presenta su asistente con los clientes.",
          value: settings[SETTING_KEYS.botName] ?? "",
          placeholder: env.BOT_NAME ?? "Mi asistente",
        })}

        ${renderTextArea({
          name: SETTING_KEYS.businessContext,
          label: "Información del negocio",
          help: "Horarios, servicios, precios, ubicación. El bot responde con esto. Editable en vivo — se aplica al guardar, sin re-desplegar.",
          // Pre-llenado: si el panel aún no tiene override, muestra lo que el
          // onboarding cargó en member/config.local (renderBusinessContext) para
          // que el miembro VEA y edite sus horarios aquí desde el día 1.
          value: settings[SETTING_KEYS.businessContext] || renderBusinessContext(),
          placeholder: "Ej. Abrimos lunes a sábado de 9 a 7. Corte $150, barba $100. Estamos en Av. Reforma 123.",
          rows: 6,
        })}

        ${renderTextArea({
          name: SETTING_KEYS.systemPromptOverride,
          label: "Prompt del agente (avanzado)",
          help: hasPromptOverride
            ? "✍ Modo manual: su bot está usando este texto como prompt completo, en lugar del automático. Para verlo entero o volver al automático: Mi Agente → Flujo → Agente."
            : "⚠️ Lo que escriba aquí REEMPLAZA el prompt completo del bot — incluida la información del negocio de arriba, su base de conocimiento y sus reglas de seguridad. No agrega instrucciones: las sustituye. Déjelo vacío para usar el prompt automático. Para editar sobre el prompt real, vaya a Mi Agente → Flujo → Agente.",
          value: settings[SETTING_KEYS.systemPromptOverride] ?? "",
          placeholder: "Vacío = el bot arma su prompt solo con la información del negocio.",
          rows: 4,
        })}

        ${renderTextField({
          name: SETTING_KEYS.escalationKeywords,
          label: "Palabras que piden un humano",
          help: "Si el cliente escribe alguna, el bot avisa a una persona. Sepárelas con comas.",
          value: settings[SETTING_KEYS.escalationKeywords] ?? "",
          placeholder: "queja, reembolso, hablar con alguien",
        })}
      </div>

      <button type="submit" class="bigbtn font-display font-bold text-[13px] cursor-pointer"
              style="width:fit-content;background:var(--accent);border:1px solid var(--accent);color:#1a1206;box-shadow:4px 4px 0 var(--linelit);padding:13px 24px;display:flex;align-items:center;gap:9px">
        <i data-lucide="check" width="16" height="16"></i> Guardar cambios
      </button>
    </form>`;

  return layout({ title: "Config", activeTab: "config", body, env });
}
