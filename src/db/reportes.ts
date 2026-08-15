/**
 * BUZÓN DE REPORTES DEL EQUIPO (sale de atender clientes con el panel abierto todo el día).
 *
 * Lo que escriben las personas cuando el bot responde mal o se les ocurre una
 * mejora. No confundir con:
 *   · `tickets` — los abre el BOT cuando necesita a un humano.
 *   · `suggestions` (pestaña Mejoras) — las propone la IA.
 *
 * Ver el comentario de la tabla en schema.sql.
 */
import { Db } from "./client";

export type TipoReporte = "error" | "sugerencia";
export type EstadoReporte = "abierto" | "resuelto";

export interface Reporte {
  id: string;
  tipo: TipoReporte;
  texto: string;
  reportado_por: string | null;
  conversation_id: string | null;
  estado: EstadoReporte;
  respuesta: string | null;
  created_at: number;
  resuelto_at: number | null;
}

export interface NuevoReporte {
  tipo: TipoReporte;
  texto: string;
  reportadoPor?: string | null;
  conversationId?: string | null;
}

/** Lo que se guarda de un texto libre: recortado y con tope, nunca vacío. */
function limpiar(valor: string | null | undefined, tope: number): string {
  return (valor ?? "").trim().slice(0, tope);
}

export class ReportesRepo {
  constructor(private readonly db: Db) {}

  /** Devuelve el id del reporte creado. `texto` vacío no llega hasta aquí. */
  async crear(input: NuevoReporte): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.run(
      `INSERT INTO reportes (id, tipo, texto, reportado_por, conversation_id, estado, created_at)
       VALUES (?, ?, ?, ?, ?, 'abierto', ?)`,
      [
        id,
        input.tipo === "sugerencia" ? "sugerencia" : "error",
        limpiar(input.texto, 2000),
        limpiar(input.reportadoPor, 60) || null,
        input.conversationId || null,
        Date.now(),
      ],
    );
    return id;
  }

  async getById(id: string): Promise<Reporte | null> {
    return this.db.first<Reporte>("SELECT * FROM reportes WHERE id = ?", [id]);
  }

  /**
   * Sin filtro devuelve TODO, pero con los abiertos arriba: lo pendiente es lo
   * que hay que mirar, y lo resuelto queda de historial debajo.
   */
  async listar(estado?: EstadoReporte): Promise<Reporte[]> {
    if (estado) {
      return this.db.all<Reporte>(
        "SELECT * FROM reportes WHERE estado = ? ORDER BY created_at DESC LIMIT 200",
        [estado],
      );
    }
    return this.db.all<Reporte>(
      `SELECT * FROM reportes
       ORDER BY CASE estado WHEN 'abierto' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 200`,
    );
  }

  /** Los de una conversación (para el contador del hilo). */
  async listarDeConversacion(conversationId: string): Promise<Reporte[]> {
    return this.db.all<Reporte>(
      "SELECT * FROM reportes WHERE conversation_id = ? ORDER BY created_at DESC",
      [conversationId],
    );
  }

  async contarAbiertos(): Promise<number> {
    const fila = await this.db.first<{ n: number }>(
      "SELECT COUNT(*) as n FROM reportes WHERE estado = 'abierto'",
    );
    return fila?.n ?? 0;
  }

  /** `respuesta` es opcional: qué se hizo, para que quede escrito. */
  async resolver(id: string, respuesta?: string | null): Promise<void> {
    await this.db.run(
      "UPDATE reportes SET estado = 'resuelto', respuesta = ?, resuelto_at = ? WHERE id = ?",
      [limpiar(respuesta, 1000) || null, Date.now(), id],
    );
  }

  /** Se equivocaron al resolverlo: vuelve a la lista de pendientes. */
  async reabrir(id: string): Promise<void> {
    await this.db.run(
      "UPDATE reportes SET estado = 'abierto', resuelto_at = NULL WHERE id = ?",
      [id],
    );
  }
}
