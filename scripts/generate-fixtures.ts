#!/usr/bin/env tsx
/**
 * generate-fixtures.ts
 *
 * Walks the member knowledge base (`member/kb/`) and produces a flat
 * `scripts/kb-fixtures.json` snapshot of every source document. This snapshot
 * is the deterministic input that:
 *   - `pnpm kb:reindex` feeds into the Vectorize reindex RPC, and
 *   - eval / unit tests consume so they never have to hit the real filesystem
 *     or a live embedding model.
 *
 * Design goals:
 *   - Pure, side-effect-light: only reads `member/kb/` and writes one JSON file.
 *   - Crash-free on an (almost) empty KB. A fresh clone ships `member/kb/` with
 *     just a `.gitkeep`, so the script must succeed and emit `[]` rather than
 *     throwing. CI and `kb:reindex` depend on this.
 *
 * Supported source extensions: .md, .mdx, .txt, .json
 *   - text files  -> one chunk per file (whole file as `content`)
 *   - .json files -> if the file is an array of {id?, title?, content|text|body},
 *                    each entry becomes its own chunk; otherwise the raw JSON
 *                    string is stored as a single chunk.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const KB_DIR = resolve(ROOT, "member/kb");
const OUT_FILE = resolve(HERE, "kb-fixtures.json");

const TEXT_EXT = new Set([".md", ".mdx", ".txt"]);
const SUPPORTED_EXT = new Set([...TEXT_EXT, ".json"]);

export interface KbFixture {
  /** Stable id derived from source path (+ index for multi-chunk JSON). */
  id: string;
  /** POSIX-style path relative to member/kb (for traceability). */
  source: string;
  /** Human title if available, else falls back to the source path. */
  title: string;
  /** Raw text that will be embedded / matched. */
  content: string;
}

/** Recursively collect supported files under `dir`. Returns [] if dir absent. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue; // skip .gitkeep, dotfiles
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (st.isFile() && SUPPORTED_EXT.has(extname(entry).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[^./]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "doc";
}

function firstHeadingOrName(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

interface RawJsonEntry {
  id?: string;
  title?: string;
  content?: string;
  text?: string;
  body?: string;
}

function fixturesFromJson(file: string, rel: string): KbFixture[] {
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON: store verbatim so reindex/tests still see *something*.
    return [{ id: slug(rel), source: rel, title: rel, content: raw }];
  }
  if (Array.isArray(parsed)) {
    const items = parsed as RawJsonEntry[];
    return items.map((it, i) => {
      const content = it.content ?? it.text ?? it.body ?? JSON.stringify(it);
      return {
        id: it.id ?? `${slug(rel)}-${i}`,
        source: rel,
        title: it.title ?? `${rel}#${i}`,
        content,
      };
    });
  }
  return [{ id: slug(rel), source: rel, title: rel, content: raw }];
}

function fixturesFromText(file: string, rel: string): KbFixture[] {
  const content = readFileSync(file, "utf8").trim();
  if (!content) return [];
  return [{ id: slug(rel), source: rel, title: firstHeadingOrName(content, rel), content }];
}

export function buildFixtures(kbDir: string = KB_DIR): KbFixture[] {
  const files = walk(kbDir).sort();
  const fixtures: KbFixture[] = [];
  for (const file of files) {
    const rel = toPosix(relative(kbDir, file));
    const ext = extname(file).toLowerCase();
    if (ext === ".json") {
      fixtures.push(...fixturesFromJson(file, rel));
    } else {
      fixtures.push(...fixturesFromText(file, rel));
    }
  }
  return fixtures;
}

function main(): void {
  const fixtures = buildFixtures();
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(fixtures, null, 2) + "\n", "utf8");
  console.log(
    `✅ generate-fixtures: ${fixtures.length} chunk(s) from ${toPosix(relative(ROOT, KB_DIR))} -> ${toPosix(relative(ROOT, OUT_FILE))}`,
  );
  if (fixtures.length === 0) {
    console.log("ℹ️  KB is empty. Drop .md / .json docs into member/kb/ then re-run.");
  }
  console.log(
    "ℹ️  Manifest regenerated. Trigger the real Vectorize reindex AFTER deploy:\n" +
      "    1. pnpm deploy\n" +
      "    2. wrangler secret put KB_REINDEX_TOKEN     (después del deploy)\n" +
      '    3. curl -X POST https://<worker>/kb/reindex -H "X-Reindex-Token: $KB_REINDEX_TOKEN"\n' +
      "\n" +
      "    Si el paso 3 devuelve {\"ok\":false,\"error\":\"unauthorized\"}, esperá unos\n" +
      "    segundos y reintentá: el secret tarda en propagarse. No es tu token.",
  );
}

// Run only when invoked directly (tsx scripts/generate-fixtures.ts), not on import.
const INVOKED_DIRECTLY =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_DIRECTLY) {
  main();
}
