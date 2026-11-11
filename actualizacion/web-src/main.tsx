import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// Auto-reset de la PWA: si el server ya sirve un build NUEVO y el service
// worker nos entregó uno viejo (index-XXX.js distinto), borrar SW + cachés
// y recargar UNA vez — el flag evita un bucle si el server sigue viejo.
// Banner si el cliente Prisma quedó viejo tras actualizar sin `generate`
// (server lo reporta en health.staleClient) — sin él los writes revientan.
const showStaleBanner = () => {
  if (document.getElementById('stale-banner')) return;
  const d = document.createElement('div');
  d.id = 'stale-banner';
  d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;padding:8px 12px;font:600 13px/1.4 system-ui;text-align:center';
  d.textContent = '⚠ Actualización incompleta — corre "npx prisma generate" en server\\ y reinicia PoxScore. Anotar puede fallar hasta hacerlo.';
  document.body.prepend(d);
};
const checkStale = () => fetch('/api/health').then((r) => r.json())
  .then((h) => { if (h?.staleClient) showStaleBanner(); }).catch(() => {});
checkStale();
setTimeout(checkStale, 8000); // el sondeo del server corre ~3s tras arrancar

fetch('/api/health').then((r) => r.json()).then((h) => {
  const own = document.querySelector('script[src*="/assets/"]')
    ?.getAttribute('src')?.match(/index-[^/]+\.js/)?.[0];
  if (!h?.build || !own) return;
  if (h.build === own) { sessionStorage.removeItem('pox-rebuilt'); return; }
  if (sessionStorage.getItem('pox-rebuilt')) return;
  sessionStorage.setItem('pox-rebuilt', '1');
  void navigator.serviceWorker?.getRegistrations()
    .then((rs) => Promise.all(rs.map((r) => r.unregister())))
    .then(() => caches.keys())
    .then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
    .finally(() => location.reload());
}).catch(() => { /* offline: sin chequeo, el SW sigue sirviendo */ });
