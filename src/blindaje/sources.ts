/**
 * Fuentes que el Blindaje acepta como respaldo de un dato.
 *
 * Desde 1.0.77 searchKb pide returnMetadata:"all" y el verificador compara la
 * respuesta contra el texto de la KB. Un dato que el dueño escribió solo en
 * custom_instructions (o que devolvió una tool en este turno) no está en esos
 * pasajes. En modo "negaciones" la negación dispara la verificación y ese dato
 * se marca "sin respaldo", aunque sea cierto.
 *
 * El corpus de abajo es la lista cerrada de fuentes del turno. No incluye el
 * system prompt entero: ahí hay reglas de estilo ("cambia CÓMO atiendes") que
 * no son hechos del negocio y que hacían que el juez ignorara la promo escrita
 * en las instrucciones.
 */

export interface ToolResultSource {
  tool: string;
  output: string;
}

export interface KbPassageSource {
  title?: string;
  content: string;
}

export interface SourceInput {
  kbPassages?: KbPassageSource[];
  businessContext?: string;
  /** Texto crudo del setting custom_instructions (también si hay prompt manual). */
  customInstructions?: string;
  /** System prompt activo: se extrae solo el bloque <custom_instructions>. */
  systemPrompt?: string;
  toolResults?: ToolResultSource[];
}

/** Misma familia que DENIAL_PATTERN en verify.ts, más verbos de servicio que
 *  el ejemplo del ticket usa ("no damos / no atendemos a domicilio"). */
export const DENIAL_CLAUSE =
  /\bno\s+(?:lo\s+|la\s+|los\s+|las\s+|te\s+|se\s+)?(?:vend|ofrec|manej|trabaj|distribu|fabric|surt|damos|atend|entreg|tenemos|contamos|disponemos|hacemos)|no\s+(?:contamos|trabajamos|disponemos)\s+con|we\s+do\s?n[’']?t\s+(?:sell|offer|carry|stock|do|make|handle|have)|n[ãa]o\s+(?:vendemos|temos|oferecemos|trabalhamos|fazemos)/i;

const FACT_HINT =
  /\d|promo|regal|inclu|cuesta|precio|gratis|descuent|env[ií]o|bono|horario|disponib|stock|\bpesos?\b|d[oó]lar|\$|€|£|%/i;

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractCustomInstructions(systemPrompt: string | undefined): string {
  if (!systemPrompt) return "";
  const blocks: string[] = [];
  const re = /<custom_instructions>([\s\S]*?)<\/custom_instructions>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(systemPrompt))) blocks.push(m[1]);
  return blocks.join("\n");
}

export function sourceCorpus(input: SourceInput): string {
  const parts: string[] = [];
  const push = (s: string | undefined) => {
    const t = s?.trim();
    if (t) parts.push(t);
  };
  push(input.businessContext);
  push(input.customInstructions);
  push(extractCustomInstructions(input.systemPrompt));
  for (const p of input.kbPassages ?? []) {
    push([p.title, p.content].filter(Boolean).join(" — "));
  }
  for (const t of input.toolResults ?? []) {
    push(t.output);
  }
  return parts.join("\n");
}

/** Corta en oraciones. No parte miles ("1,500") ni decimales. */
export function splitClauses(text: string): string[] {
  return text
    .split(/[.;!?\n]+|,(?!\d)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isDenialClause(clause: string): boolean {
  return DENIAL_CLAUSE.test(clause);
}

/** Una cláusula afirma un dato del negocio (precio, promo, incluye, etc.). */
export function isPositiveFactClause(clause: string): boolean {
  if (isDenialClause(clause)) return false;
  const t = clause.trim();
  if (t.length < 8) return false;
  return FACT_HINT.test(t);
}

function numbersOf(normalized: string): string[] {
  return normalized.match(/\d+(?:\s\d{3})*/g) ?? [];
}

/**
 * El dato está en el corpus si la frase aparece (normalizada) o si cada
 * palabra de contenido y cada número de la cláusula están en las fuentes.
 * Un número que no está (el corte a $80 cuando la fuente dice $150) no pasa.
 */
export function clauseGrounded(clause: string, corpus: string): boolean {
  const c = normalizeForMatch(clause);
  const src = normalizeForMatch(corpus);
  if (!c || !src) return false;
  if (src.includes(c)) return true;
  const nums = numbersOf(c);
  if (nums.some((n) => !src.includes(n))) return false;
  const tokens = c.split(" ").filter((t) => t.length >= 4);
  if (tokens.length === 0) return false;
  return tokens.every((t) => src.includes(t));
}

export type NegacionesDecision = "deliver" | "block" | "ask";

/**
 * Modo negaciones, una vez que la respuesta ya trae una negación:
 *  - deliver: cada dato positivo está en las fuentes (instrucciones, KB,
 *    contexto o tool del turno). La negación disparó el chequeo pero no hay
 *    un dato inventado que tapar.
 *  - block: hay un dato positivo que no está en ninguna fuente.
 *  - ask: la respuesta solo niega; el modelo decide si esa negación tiene
 *    respaldo explícito (el caso "no vendemos repuestos").
 */
export function decideNegaciones(reply: string, corpus: string): NegacionesDecision {
  const positives = splitClauses(reply).filter(isPositiveFactClause);
  if (positives.length === 0) return "ask";
  if (positives.every((c) => clauseGrounded(c, corpus))) return "deliver";
  return "block";
}

export function firstUngroundedFact(reply: string, corpus: string): string | undefined {
  return splitClauses(reply)
    .filter(isPositiveFactClause)
    .find((c) => !clauseGrounded(c, corpus));
}
