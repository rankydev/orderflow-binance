/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Basis-URL der API (leer = gleicher Ursprung; in der Entwicklung bedient die Fixture-Middleware /api/v1). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
