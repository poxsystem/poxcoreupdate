import { useEffect, useState } from 'react';
import { api, AuthUser, setToken } from '../api';
import { LoginModal } from '../components/AuthBar';

const ROLES = [
  { v: 'admin', label: 'Admin — todo (ligas, usuarios, respaldo, publicar)' },
  { v: 'anotador', label: 'Anotador — anotar y administrar juegos' },
  { v: 'visita', label: 'Visita — solo lectura' },
];

/** Administración de usuarios (rol admin). El primero se crea sin login (bootstrap). */
export default function UsersPage() {
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [me, setMe] = useState<AuthUser | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [err, setErr] = useState('');
  // el primer usuario arranca como admin (es quien administrará); luego default anotador
  const [form, setForm] = useState({ username: '', password: '', role: 'admin' });
  const defaultRole = users?.length ? 'anotador' : 'admin';
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ password: '', role: 'anotador', active: true });

  const load = () => {
    api.authStatus().then((s) => { setEnabled(s.enabled); setMe(s.user); }).catch(() => {});
    api.users().then(setUsers).catch((e) => { setErr(e.message); setUsers([]); });
  };
  useEffect(load, []);

  const create = async () => {
    try {
      const r = await api.createUser(form);
      if (r.token) setToken(r.token); // bootstrap: queda logueado de una vez
      setForm({ username: '', password: '', role: defaultRole });
      setErr(''); load();
    } catch (e) { setErr((e as Error).message); }
  };

  const save = async (id: string) => {
    try {
      await api.updateUser(id, { ...(edit.password ? { password: edit.password } : {}), role: edit.role, active: edit.active });
      setEditId(null); load();
    } catch (e) { setErr((e as Error).message); }
  };

  const del = async (id: string) => {
    if (!confirm('¿Eliminar este usuario?')) return;
    try { await api.deleteUser(id); load(); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div>
      <h1>👥 Usuarios</h1>
      <p className="muted">
        Sin usuarios la suite queda en <b>modo abierto</b> — entra directo, sin login, y las
        acciones de administrador piden la clave admin. Crea el primer usuario solo si quieres
        activar roles y login: <b>admin</b> hace todo, <b>anotador</b> solo anota juegos,{' '}
        <b>visita</b> solo lee. La lectura nunca pide clave.
      </p>
      {err && <p style={{ color: '#f88' }}>{err}</p>}

      {/* hay usuarios pero no estás logueado como admin — antes esto mostraba
          "crear el primer usuario" y parecía que el admin se había borrado */}
      {enabled && me?.role !== 'admin' ? (
        <div className="card">
          <h3>🔐 Hay usuarios registrados</h3>
          <p className="muted">
            El sistema tiene cuentas creadas{me ? ` — estás como «${me.username}» (${me.role})` : ' — no has iniciado sesión'}.
            Para administrar usuarios entra como <b>admin</b>.
          </p>
          <button onClick={() => setLoginOpen(true)}>👤 Entrar</button>
        </div>
      ) : (
      <div className="card">
        <h3>{users?.length ? 'Nuevo usuario' : '🔐 Crear el primer usuario (admin)'}</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input placeholder="Usuario" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input placeholder="Contraseña" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
          </select>
          <button onClick={create} disabled={!form.username || !form.password}>Crear</button>
        </div>
        {!users?.length && <p className="muted">El primer usuario debería ser <b>admin</b> para poder administrar.</p>}
      </div>
      )}
      {loginOpen && <LoginModal onDone={() => { setLoginOpen(false); load(); }} />}

      {users && users.length > 0 && (
        <table>
          <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {users.map((u) => editId === u.id ? (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>
                  <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
                    {ROLES.map((r) => <option key={r.v} value={r.v}>{r.v}</option>)}
                  </select>
                </td>
                <td>
                  <label><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> activo</label>
                  <input placeholder="Nueva contraseña (vacío = igual)" style={{ marginLeft: 8 }}
                    value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
                </td>
                <td className="row"><button className="sm" onClick={() => save(u.id)}>💾</button><button className="sm secondary" onClick={() => setEditId(null)}>✕</button></td>
              </tr>
            ) : (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td><span className="pill">{u.role}</span></td>
                <td>{u.active ? '✓ activo' : '⛔ inactivo'}</td>
                <td className="row">
                  <button className="sm secondary" onClick={() => { setEditId(u.id); setEdit({ password: '', role: u.role, active: u.active }); }}>✏️</button>
                  <button className="sm secondary" onClick={() => del(u.id)}>🗑</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!enabled && users?.length === 0 && <p className="muted">Sin usuarios — la suite está en modo abierto.</p>}
    </div>
  );
}
