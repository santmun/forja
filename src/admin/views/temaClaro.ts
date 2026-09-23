/**
 * TEMA CLARO + ESCALA DE LETRA para el panel de Forja.
 *
 * El panel viene en oscuro y con monoespaciada, que se ve muy bien pero cansa
 * cuando lo tienes abierto ocho horas atendiendo clientes. Esto lo pasa a claro,
 * con la tipografía y los colores de TU marca, y sube el tamaño de la letra.
 *
 * DOS PRINCIPIOS, y son los que lo hacen seguro de aplicar:
 *
 *  1. **Es puramente aditivo.** Sin la variable `PANEL_TEMA`, el panel se ve
 *     EXACTAMENTE como siempre. No se toca ni una vista.
 *  2. **Solo cambia color y tipografía.** Ni una regla mueve, quita o reordena
 *     nada de la pantalla. Por eso no puede romper la maquetación.
 *
 * CÓMO SE USA
 *
 *   wrangler.toml → [vars]
 *     PANEL_TEMA  = "claro"
 *     TEMA_FUENTE = "Fira Sans"        # opcional, cualquiera de Google Fonts
 *     TEMA_COLOR  = "#2f7fbf"          # opcional, el color principal de tu marca
 *     TEMA_COLOR2 = "#a2670a"          # opcional, el secundario
 *
 *   layout.ts (o donde armes el <head>):
 *     ${opts.env?.PANEL_TEMA === "claro" ? temaClaro(opts.env) : ""}
 *
 * LO QUE APRENDÍ HACIÉNDOLO (por si te ahorra las mismas vueltas)
 *
 *  · **El fondo no puede ser blanco puro.** Si el fondo y las tarjetas son del
 *    mismo blanco, la pantalla queda como una hoja plana y deslumbra. Fondo con
 *    un tono suave de la familia de tu color, tarjetas en blanco encima: se
 *    separan solas y descansa la vista.
 *  · **Tu color de marca puede no contrastar sobre blanco.** El ámbar que yo
 *    usaba se perdía en los enlaces. Por eso el color secundario se puede pasar
 *    aparte, ya oscurecido, en vez de reusar el de la web tal cual.
 *  · **Los grises del panel están pensados para fondo OSCURO.** Sobre blanco se
 *    lavan y los textos chicos de debajo de cada número hay que acercarse para
 *    leerlos. Van más oscuros.
 *  · **Lo que de verdad quita el aire de terminal** no es el color: es sacar la
 *    monoespaciada y las rayas de monitor viejo.
 *  · **El grosor importa tanto como el tamaño.** Una fuente fina, en tamaño
 *    chico y sobre blanco, se ve aguada — sobre todo en los rótulos en
 *    mayúsculas. Un peso medio los asienta sin engordar el texto corrido.
 *
 * LA ESCALA DE LETRA (lo importante)
 *
 * El panel tiene los tamaños escritos DENTRO de cada vista, en cientos de
 * sitios. Cambiarlos uno por uno es tocar todo y arriesgar la maquetación, así
 * que se re-mapean por CSS: cada tamaño chico sube ~2 px. Los más chiquitos
 * suben más, porque son los que obligan a acercarse a la pantalla.
 *
 * ⚠️ **Esa lista NO se escribe a mano.** La saca `escala-de-letra.py`, que
 * rastrea el código y encuentra los tamaños que se usan DE VERDAD, en las tres
 * formas en que aparecen: `font-size:11px`, `font-size: 11px` (con espacio) y
 * la clase `text-[10.5px]` de Tailwind. Lo intenté de memoria primero y fallé:
 * se me quedaron fuera 8, 8.5, 9.5, 10.5, 11.5 y 12.5, y había textos que no
 * cambiaban de tamaño. Si añades tamaños nuevos, vuelves a correr el script.
 */

export interface EnvTema {
  PANEL_TEMA?: string;
  TEMA_FUENTE?: string;
  TEMA_COLOR?: string;
  TEMA_COLOR2?: string;
}

const POR_DEFECTO = {
  fuente: "Inter",
  color: "#2f7fbf",
  color2: "#a2670a",
};

/** Nombre de fuente -> el trozo que pide Google Fonts. */
function enlaceDeFuente(fuente: string): string {
  const familia = fuente.trim().replace(/\s+/g, "+");
  return `<link href="https://fonts.googleapis.com/css2?family=${familia}:wght@400;500;600;700;800&display=swap" rel="stylesheet">`;
}

/**
 * Escala de tamaños. La generas con `escala-de-letra.py` contra TU copia del
 * panel y pegas aquí el resultado; esta es la que salió en la mía.
 */
const ESCALA = `
    .text-\\\\[8px\\\\]{font-size:13.5px !important}
    [style*="font-size:8.5px"],[style*="font-size: 8.5px"],.text-\\\\[8\\\\.5px\\\\]{font-size:13.5px !important}
    [style*="font-size:9px"],[style*="font-size: 9px"],.text-\\\\[9px\\\\]{font-size:13.5px !important}
    [style*="font-size:9.5px"],[style*="font-size: 9.5px"],.text-\\\\[9\\\\.5px\\\\]{font-size:13.5px !important}
    [style*="font-size:10px"],[style*="font-size: 10px"],.text-\\\\[10px\\\\]{font-size:14px !important}
    [style*="font-size:10.5px"],[style*="font-size: 10.5px"],.text-\\\\[10\\\\.5px\\\\]{font-size:14px !important}
    [style*="font-size:11px"],[style*="font-size: 11px"],.text-\\\\[11px\\\\]{font-size:14.5px !important}
    [style*="font-size:11.5px"],[style*="font-size: 11.5px"],.text-\\\\[11\\\\.5px\\\\]{font-size:14.5px !important}
    [style*="font-size:12px"],[style*="font-size: 12px"],.text-\\\\[12px\\\\]{font-size:15px !important}
    [style*="font-size:12.5px"],[style*="font-size: 12.5px"],.text-\\\\[12\\\\.5px\\\\]{font-size:15px !important}
    [style*="font-size:13px"],[style*="font-size: 13px"],.text-\\\\[13px\\\\]{font-size:15.5px !important}
    [style*="font-size:13.5px"],[style*="font-size: 13.5px"],.text-\\\\[13\\\\.5px\\\\]{font-size:15.5px !important}
    [style*="font-size:14px"],[style*="font-size: 14px"],.text-\\\\[14px\\\\]{font-size:16.5px !important}
    [style*="font-size:14.5px"],[style*="font-size: 14.5px"]{font-size:16.5px !important}
    [style*="font-size:15px"],[style*="font-size: 15px"],.text-\\\\[15px\\\\]{font-size:17px !important}
    .text-xs{font-size:15px !important}
    .sb-sec{font-size:12.5px !important}`;

/** El bloque para el <head>. Cadena vacía si el tema no está encendido. */
export function temaClaro(env?: EnvTema): string {
  if (env?.PANEL_TEMA !== "claro") return "";

  const fuente = env.TEMA_FUENTE?.trim() || POR_DEFECTO.fuente;
  const color = env.TEMA_COLOR?.trim() || POR_DEFECTO.color;
  const color2 = env.TEMA_COLOR2?.trim() || POR_DEFECTO.color2;

  return `
  ${enlaceDeFuente(fuente)}
  <style>
    :root{
      /* Fondo NO blanco puro (ver la nota de arriba) y tarjetas en blanco. */
      --bg:#eef3f3; --panel:#ffffff; --panel2:#f7fafa; --raise:#e7efef;
      --line:#dde6e6; --linelit:#c4d2d2;
      --accent:${color}; --accent-2:${color2};
      --accent-soft:color-mix(in srgb, ${color} 12%, transparent);
      /* Grises oscurecidos: los de origen son para fondo oscuro. */
      --cream:#2b2b2b; --muted:#4a5555; --dim:#616c6b;
      --ok:#2f9e6f; --info:#2f7fbf; --bad:#c8503f; --violet:#7b5ea7;
      --border:#e4eaea; --border-lit:#cbd6d6;
      --green:#2f9e6f; --blue:#2f7fbf; --red:#c8503f;
    }
    /* Fuera la monoespaciada: es lo que más "terminal" se veía. */
    html, body, input, textarea, select, button, .font-mono {
      font-family:'${fuente}',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif !important;
    }
    [style*="Space Grotesk"], .font-display {
      font-family:'${fuente}',sans-serif !important; font-weight:800 !important;
    }
    body { font-size:15px; line-height:1.6; }
    /* Las rayas de monitor viejo. */
    .scanlines::before, .scanlines::after { display:none !important; }
${ESCALA}
    /* GROSOR: en tamaño chico y sobre blanco la letra se ve aguada, sobre todo
       en los rótulos en mayúsculas. Un peso medio los asienta. */
    [style*="letter-spacing"]{font-weight:600 !important}
    th,thead td{font-weight:600 !important}
  </style>`;
}
