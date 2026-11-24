import { mount } from 'svelte';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });

// Entwicklung: jede Code-Änderung lädt die Seite vollständig neu. Ein Hot-Update des Chart-Controllers
// ließ sonst alte Instanzen und Zustände stehen (beobachtet: Anzeige „bs 0.0 px", nur Kerzen).
if (import.meta.hot) import.meta.hot.on('vite:beforeUpdate', () => location.reload());
