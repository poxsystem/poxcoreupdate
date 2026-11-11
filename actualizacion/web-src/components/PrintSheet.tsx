import { useEffect, type ReactNode } from 'react';

/**
 * Hoja imprimible carta vertical (8.5×11) con vista previa tipo papel.
 * Overlay a pantalla completa: el usuario ve cómo quedará la página y
 * «Imprimir / Guardar PDF» abre el diálogo de impresión del navegador.
 * En @media print la hoja pasa a estática y el resto de la app se oculta
 * (mismo truco que .modal-backdrop.report-overlay).
 * Se cierra con ✕, con Esc o tocando el fondo oscuro fuera del papel.
 */
export default function PrintSheet({ title, subtitle, onClose, children }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  return (
    <div className="psheet-overlay" onClick={onClose}>
      <div className="psheet-bar no-print" onClick={(e) => e.stopPropagation()}>
        <strong>{title}</strong>
        <span className="muted">Carta vertical 8.5×11 — en el diálogo elige «Guardar como PDF»</span>
        <span className="spacer" />
        <button onClick={() => window.print()}>🖨️ Imprimir / PDF</button>
        <button className="secondary" onClick={onClose}>✕ Cerrar</button>
      </div>
      <div className="psheet-paper print-report" onClick={(e) => e.stopPropagation()}>
        <div className="report-header">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children}
        <p className="print-sign">PoxScore · Desarrollado por Alexis Lara · 2026</p>
      </div>
    </div>
  );
}
