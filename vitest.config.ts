import { defineConfig, configDefaults } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Safety net: `agents` / `partyserver` import the virtual `cloudflare:*`
    // modules (only available inside workerd). The worker-entry test mocks the
    // `agents` package so these never load in Node, but if any test transitively
    // pulls them in, these aliases resolve them to local stubs rather than
    // crashing Node's ESM loader. Tests needing real runtime behavior use
    // Miniflare instead.
    alias: {
      "cloudflare:workers": path.resolve(HERE, "test/stubs/cloudflare-workers.ts"),
      "cloudflare:email": path.resolve(HERE, "test/stubs/cloudflare-email.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // macOS mete un archivo AppleDouble (`._algo`) al lado de cada archivo real
    // cuando empaqueta un tar/zip con atributos extendidos. Los que quedan como
    // `._loquesea.test.ts` casan con el `include` de arriba, y Vitest intenta
    // cargarlos como módulos: no son JavaScript, así que se lleva por delante el
    // worker con un "Worker exited unexpectedly" que no dice qué archivo fue.
    //
    // Nada los genera dentro del repo — llegan en el tarball de distribución.
    // Esto es la red de seguridad del lado del consumidor: aunque el paquete
    // venga sucio, la suite corre.
    //
    // `exclude` reemplaza el valor por defecto en vez de sumarse, así que hay que
    // reponerlo con configDefaults o se pierde el filtro de node_modules.
    exclude: [...configDefaults.exclude, "**/._*"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Most tests spin up a real Miniflare (workerd process + full D1 schema)
    // in beforeEach; under machine load that alone can blow the 5s default.
    // These are integration tests — give them real headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
