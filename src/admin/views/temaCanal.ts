// Cada chat se ve como la app de la que viene.
//
// POR QUÉ (sale de atender clientes con el panel abierto todo el día): cuando se conecte WhatsApp, el número
// deja de funcionar en la app normal y el equipo tiene que atender desde este
// panel. Sus secretarias llevan años en WhatsApp; si el chat se ve como una
// terminal, el cambio se siente brusco y se cometen errores. Que cada
// conversación se parezca a su app de origen (colores, burbujas, tipografía)
// hace que el traslado sea casi invisible.
//
// Alcance deliberado: SOLO el hilo de conversación. El resto del panel —la
// lista, los filtros, las tarjetas— conserva su identidad, porque es la
// herramienta de trabajo, no el chat.
//
// Sobre las tipografías: WhatsApp, Telegram e Instagram usan la fuente del
// SISTEMA en Android/iOS (Roboto y San Francisco). Aquí se pide exactamente esa
// pila, que es lo que hace que "se sienta" como la app. No se descarga ninguna
// fuente externa: sería más lento, y las propias de esas marcas no son libres.

export type CanalTema = {
  /** Nombre de la app, para el encabezado del hilo. */
  nombre: string;
  /** Fondo del área de mensajes. */
  fondo: string;
  /** Fondo de la barra superior del chat y del cajón de respuesta. */
  barra: string;
  /** Burbuja de lo que enviamos nosotros (bot o equipo). */
  propia: string;
  /** Burbuja de lo que escribe el cliente. */
  ajena: string;
  /** Color del texto dentro de las burbujas. */
  texto: string;
  /** Color secundario (hora, metadatos). */
  suave: string;
  /** Color de marca, para detalles. */
  marca: string;
  /** Pila tipográfica de la app. */
  fuente: string;
  /** Radio de las esquinas de la burbuja. */
  radio: string;
};

/** La fuente que usan de verdad estas apps en el teléfono: la del sistema. */
// ⚠️ COMILLAS SIMPLES a propósito. Esta cadena termina dentro de un atributo
// HTML `style="…"`; con comillas dobles el navegador corta el atributo ahí
// mismo y la fuente NUNCA se aplica (pasó en la primera versión, 28/07/2026).
const FUENTE_SISTEMA =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/** Tema del panel (el de siempre) — para canales sin app propia. */
const GENERICO: CanalTema = {
  nombre: "Chat",
  fondo: "var(--bg)",
  barra: "var(--panel)",
  propia: "var(--accent-soft)",
  ajena: "var(--panel2)",
  texto: "var(--cream)",
  suave: "var(--dim)",
  marca: "var(--accent)",
  fuente: "inherit",
  radio: "0",
};

// Los valores salen de las apps en MODO OSCURO, que es el modo del panel.
const TEMAS: Record<string, CanalTema> = {
  whatsapp: {
    nombre: "WhatsApp",
    fondo: "#0b141a",
    barra: "#1f2c34",
    propia: "#005c4b", // el verde de los mensajes propios
    ajena: "#202c33",
    texto: "#e9edef",
    suave: "#8696a0",
    marca: "#00a884",
    fuente: FUENTE_SISTEMA,
    radio: "7px",
  },
  telegram: {
    nombre: "Telegram",
    fondo: "#0e1621",
    barra: "#17212b",
    propia: "#2b5278", // el azul de los mensajes propios
    ajena: "#182533",
    texto: "#ffffff",
    suave: "#7d8e98",
    marca: "#5288c1",
    fuente: FUENTE_SISTEMA,
    radio: "12px",
  },
  instagram: {
    nombre: "Instagram",
    fondo: "#000000",
    barra: "#121212",
    propia: "#3797f0", // el azul de los DM propios
    ajena: "#262626",
    texto: "#fafafa",
    suave: "#a8a8a8",
    marca: "#e1306c",
    fuente: FUENTE_SISTEMA,
    radio: "18px", // los DM de Instagram son muy redondeados
  },
  messenger: {
    nombre: "Messenger",
    fondo: "#000000",
    barra: "#1c1e21",
    propia: "#0084ff",
    ajena: "#303030",
    texto: "#e4e6eb",
    suave: "#b0b3b8",
    marca: "#0084ff",
    fuente: FUENTE_SISTEMA,
    radio: "18px",
  },
};

/** Twilio, ManyChat, Kapso y YCloud son transportes, no apps: se muestran como
 *  lo que llevan. Para el equipo lo que importa es por dónde escribió el
 *  cliente, no qué proveedor usamos por dentro. */
const EQUIVALENCIAS: Record<string, string> = {
  twilio: "whatsapp",
  kapso: "whatsapp",
  ycloud: "whatsapp",
  meta: "messenger",
  manychat: "instagram", // ManyChat entra por los DM de Instagram
};

/**
 * El tema que corresponde a un canal. Nunca falla: cae al del panel.
 *
 * `plataformaReal` es para ZERNIO, que es un puente multiplataforma: una misma
 * conexión trae WhatsApp, Instagram o Telegram. Sin esto, todos sus chats se
 * veían con el tema genérico de terminal — que es justo lo que este módulo
 * existe para evitar (se notó con el primer WhatsApp que
 * entró por Zernio: "aún parece un chat que no es de WhatsApp").
 */
export function temaDelCanal(
  canal: string | null | undefined,
  plataformaReal?: string | null,
): CanalTema {
  const bruto = (canal ?? "").trim().toLowerCase();
  const id =
    bruto === "zernio" && plataformaReal ? plataformaReal.trim().toLowerCase() : bruto;
  return TEMAS[id] ?? TEMAS[EQUIVALENCIAS[id] ?? ""] ?? GENERICO;
}

/**
 * El COLOR DE MARCA del canal, para la etiqueta de la lista de conversaciones:
 * el verde de WhatsApp, el azul de Telegram, el rosa de Instagram… Antes todas
 * las etiquetas eran del mismo par de colores del panel y no se distinguía de
 * un vistazo por dónde escribió cada persona (sale de atender clientes con el panel abierto todo el día).
 *
 * Los tonos son los mismos que ya usa el tema del hilo, así que la etiqueta y
 * el chat que abre debajo hablan el mismo idioma visual.
 */
export function colorDeMarca(
  canal: string | null | undefined,
  plataformaReal?: string | null,
): string {
  const t = temaDelCanal(canal, plataformaReal);
  return t === GENERICO ? "var(--accent-2)" : t.marca;
}

/**
 * Variables CSS del tema, para ponerlas en el `style` del contenedor del hilo.
 * Todo lo de dentro (barra, burbujas, cajón) se dibuja con estas variables.
 */
export function estiloDelTema(t: CanalTema): string {
  return [
    `--ch-fondo:${t.fondo}`,
    `--ch-barra:${t.barra}`,
    `--ch-propia:${t.propia}`,
    `--ch-ajena:${t.ajena}`,
    `--ch-texto:${t.texto}`,
    `--ch-suave:${t.suave}`,
    `--ch-marca:${t.marca}`,
    `--ch-radio:${t.radio}`,
    `font-family:${t.fuente}`,
  ].join(";");
}
