import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, AuthUser, setToken, setAuthRequiredHandler } from '../api';

/** Modal de login — aparece al pulsar "Entrar" o cuando un request devuelve 401. */
export function LoginModal({ onDone }: { onDone: (u: AuthUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.login(username.trim(), password);
      setToken(r.token);
      onDone(r.user);
    } catch { setErr('Usuario o contraseña incorrectos'); }
    finally { setBusy(false); }
  };

  // portal al body: sin esto el modal queda preso dentro del topbar (el
  // backdrop-filter del header crea un containing block para position:fixed
  // y el login aparecía pegado arriba en vez de centrado en la pantalla)
  return createPortal(
    <div className="modal-back" onClick={() => onDone(null as never)}>
      <form className="modal-card" style={{ maxWidth: 340 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head"><b>🔐 Iniciar sesión</b></div>
        <label>Usuario <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>Contraseña <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {err && <p style={{ color: '#f88' }}>{err}</p>}
        <div className="modal-actions">
          <button type="submit" disabled={busy || !username || !password}>{busy ? '…' : 'Entrar'}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}

/** Chip en el topbar: muestra el usuario actual o el botón Entrar. */
export default function AuthBar() {
  const [enabled, setEnabled] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.authStatus().then((s) => {
      setEnabled(s.enabled); setUser(s.user);
      // já existe usuário no sistema e ninguém logou → login flutuante no centro
      if (s.enabled && !s.user) setOpen(true);
    }).catch(() => {});
    setAuthRequiredHandler(() => setOpen(true)); // un 401 abre el login
  }, []);

  return (
    <span className="authbar">
      {!enabled ? (
        // sin usuarios = modo abierto: el botón lleva a crear el primero (admin)
        <a className="secondary sm" href="/usuarios" style={{ textDecoration: 'none' }}
          title="Sin usuarios todavía — crea el primero para activar roles">🔓 Abierto</a>
      ) : user ? (
        <>
          <span className="pill" title={`Rol: ${user.role}`}>👤 {user.username}</span>
          <button className="secondary sm" title="Cerrar sesión" onClick={async () => {
            await api.logout().catch(() => {});
            setToken(''); setUser(null);
          }}>⏻</button>
        </>
      ) : (
        <button className="secondary sm" onClick={() => setOpen(true)}>👤 Entrar</button>
      )}
      {open && <LoginModal onDone={(u) => { setUser(u); setOpen(false); if (u) window.location.reload(); }} />}
    </span>
  );
}
