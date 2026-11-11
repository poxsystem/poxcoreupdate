import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';

/**
 * Confirmación destructiva estilo macOS: candado grande + clave de admin.
 * Verifica la contraseña contra el server antes de ejecutar la acción.
 */
export function PassModal({ title, message, onClose, onDone }: {
  title: string;
  message: string;
  onClose: () => void;
  onDone: (password: string) => Promise<void>;
}) {
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const inp = useRef<HTMLInputElement>(null);

  useEffect(() => { inp.current?.focus(); }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);

  const submit = async () => {
    if (!pass || busy) return;
    setBusy(true); setErr('');
    try {
      await api.verifyPass(pass);
      await onDone(pass);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Clave incorrecta');
      setPass('');
      inp.current?.focus();
    } finally { setBusy(false); }
  };

  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card passcard" onClick={(e) => e.stopPropagation()}>
        <div className="passicon">🔒</div>
        <h3 className="passtitle">{title}</h3>
        <p className="passmsg">{message}</p>
        <input
          ref={inp}
          type="password"
          className="passinput"
          placeholder="Clave de administrador"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        />
        {err && <div className="passerr">⚠️ {err}</div>}
        <div className="passrow">
          <button className="secondary" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="danger" onClick={() => void submit()} disabled={busy || !pass}>
            {busy ? 'Verificando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
