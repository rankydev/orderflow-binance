// Die Tests importieren Prüfungen des Web-Clients (apps/web/src/lib); dessen Vite-Typ für
// import.meta.env fehlt außerhalb von Vite. Nur für die Typprüfung dieses Pakets.
interface ImportMeta {
  readonly env: { readonly VITE_API_BASE?: string };
}
