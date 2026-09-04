/**
 * Convierte el markdown ligero que el modelo genera (negritas **, cursiva
 * *_o_*, subrayado __) a HTML válido para el `parse_mode: "HTML"` de la
 * Bot API de Telegram.
 *
 * Sin esto, `sendMessage` manda el texto tal cual y Telegram lo muestra
 * literal — el alumno ve los asteriscos en vez de negritas. Reportado
 * 2026-08-27: el modelo escribía `**bold**` correctamente, pero nadie lo
 * traducía a algo que Telegram supiera renderizar.
 *
 * Solo cubre lo que el prompt de este bot realmente usa (negrita, cursiva,
 * subrayado, y sus combinaciones *** / ___) — no es un parser de markdown
 * completo.
 *
 * DISEÑO — una sola pasada, no 4 reemplazos encadenados. Revisión de Opus
 * 2026-09-03 encontró que 4 `.replace()` secuenciales (negrita, luego
 * subrayado, luego cursiva ×2) se estorban entre sí: "**x**" seguido de un
 * tercer asterisco ("***x***", que el prompt SÍ produce cuando pide "muy
 * importante") deja un asterisco suelto que la pasada de cursiva empareja
 * con el CIERRE de una etiqueta ya insertada, generando HTML mal anidado
 * (`<b><i>x</b></i>`) — Telegram responde 400 y el mensaje se pierde
 * COMPLETO y en silencio. Una sola regex con alternancia (probada en orden,
 * la más específica primero) evita que un paso reprocese lo que insertó
 * otro. Los límites `(?=\S)…(?<=\S)` (estilo CommonMark: nada de espacio
 * pegado al marcador) evitan que viñetas ("* Punto uno") o aritmética
 * ("2*4") se lean como énfasis.
 */
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

const MARK_RE =
  /\*\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*\*|___(?=\S)([^_\n]+?)(?<=\S)___|\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*|__(?=\S)([^_\n]+?)(?<=\S)__|\*(?=\S)([^*\n]+?)(?<=\S)\*|(?<![\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w])/g;

export function toTelegramHtml(text: string): string {
  // 1) Escapa entidades HTML del texto ORIGINAL antes de insertar las
  //    etiquetas propias — así un "<" o "&" que escriba el alumno/modelo no
  //    rompe el parser de Telegram ni se confunde con nuestras tags reales.
  const escaped = text.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);

  // 2) Una sola pasada: cada alternativa se prueba en orden en cada
  //    posición, así "***x***" se resuelve como negrita+cursiva ANTES de
  //    que la alternativa de "**" tenga oportunidad de partirlo a medias.
  //    Un marcador sin pareja (viñeta, aritmética, markdown cruzado tipo
  //    "**a _b** c_") simplemente no matchea y queda como texto literal —
  //    nunca produce una tag sin cerrar.
  return escaped.replace(
    MARK_RE,
    (_m, boldItalic, underlineItalic, bold, underline, italicStar, italicUnderscore) => {
      if (boldItalic !== undefined) return `<b><i>${boldItalic}</i></b>`;
      if (underlineItalic !== undefined) return `<u><i>${underlineItalic}</i></u>`;
      if (bold !== undefined) return `<b>${bold}</b>`;
      if (underline !== undefined) return `<u>${underline}</u>`;
      if (italicStar !== undefined) return `<i>${italicStar}</i>`;
      return `<i>${italicUnderscore}</i>`;
    },
  );
}

/**
 * Verifica que el HTML que vamos a mandarle a Telegram tenga las tags b/i/u
 * balanceadas y bien anidadas (sin cruces tipo "<b>x<i>y</b>z</i>"). Es un
 * chequeo barato — no valida HTML en general, solo las 3 tags que nosotros
 * mismos insertamos — pero es la red de seguridad antes de mandar: si algo
 * se nos escapó (markdown que no anticipamos), lo detectamos ANTES de que
 * Telegram lo rechace con un 400 silencioso, y channels/telegram.ts cae a
 * texto plano en vez de perder el mensaje.
 */
export function hasBalancedTags(html: string): boolean {
  const stack: string[] = [];
  const tagRe = /<(\/?)([biu])>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const [, closing, tag] = m;
    if (!closing) {
      stack.push(tag);
    } else if (stack.pop() !== tag) {
      return false;
    }
  }
  return stack.length === 0;
}
