// Die Tests importieren Prüfungen des Web-Clients (apps/web/src/lib); dessen Vite-Typ für
// import.meta.env fehlt außerhalb von Vite. Nur für die Typprüfung dieses Pakets.
interface ImportMeta {
  readonly env: { readonly VITE_API_BASE?: string };
}
// DOM-Typ aus apps/web/src/lib/request-queue.ts; Node-Typen (ohne lib "dom") kennen ihn nicht.
type RequestCache =
  'default' | 'force-cache' | 'no-cache' | 'no-store' | 'only-if-cached' | 'reload';
