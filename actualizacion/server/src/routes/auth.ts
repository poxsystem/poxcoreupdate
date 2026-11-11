import { Router } from 'express';
import { prisma } from '../prisma.js';
import { checkPassword, hashPassword, issueToken, authEnabled, invalidateAuthCache, guard, reqUser, adminOk } from '../auth.js';

const r = Router();

const pub = (u: { id: string; username: string; role: string; active: boolean }) =>
  ({ id: u.id, username: u.username, role: u.role, active: u.active });

/** Estado del auth: si hay usuarios y quién soy (con token). */
r.get('/status', async (req, res) => {
  const enabled = await authEnabled();
  const tok = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  let user = null;
  if (tok) {
    const t = await prisma.authToken.findUnique({ where: { token: tok }, include: { user: true } });
    if (t && t.expiresAt > new Date() && t.user.active) user = pub(t.user);
  }
  res.json({ enabled, user });
});

r.post('/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  const u = await prisma.user.findUnique({ where: { username } });
  if (!u || !u.active || !checkPassword(password, u.passHash)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  await prisma.authToken.deleteMany({ where: { expiresAt: { lt: new Date() } } }); // limpia vencidos
  const t = await issueToken(u.id);
  res.json({ token: t.token, user: pub(u) });
});

/**
 * Segundo factor estilo macOS: confirma la contraseña del usuario ya logueado
 * antes de una acción destructiva (borrar liga/equipo/jugador/juego).
 */
r.post('/verify', async (req, res) => {
  // adminOk cubre ambos modos: contraseña de cualquier admin activo (si hay
  // usuarios) o ADMIN_KEY del .env (modo abierto, sin pantalla de login)
  const auth = await adminOk(String(req.body?.password ?? ''));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error ?? 'Contraseña incorrecta' });
  res.json({ ok: true });
});

r.post('/logout', async (req, res) => {
  const tok = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (tok) await prisma.authToken.deleteMany({ where: { token: tok } });
  res.json({ ok: true });
});

// ─── Gestión de usuarios (admin). El PRIMER usuario se crea sin token (bootstrap). ─
r.get('/users', async (req, res) => {
  if (!(await authEnabled())) return res.json([]);
  const u = await reqUser(req);
  if (u?.role !== 'admin') return res.status(403).json({ error: 'Requiere rol admin' });
  res.json((await prisma.user.findMany({ orderBy: { username: 'asc' } })).map(pub));
});

r.post('/users', async (req, res) => {
  const { username, password, role } = req.body as { username?: string; password?: string; role?: string };
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  const bootstrap = !(await authEnabled());
  // el PRIMER usuario siempre es admin — si naciera anotador quedarían
  // usuarios sin admin y /admin + gestión de usuarios quedarían inaccesibles
  const roleOk = bootstrap ? 'admin' : role === 'admin' || role === 'visita' ? role : 'anotador';
  if (!bootstrap) {
    const u = await reqUser(req);
    if (u?.role !== 'admin') return res.status(403).json({ error: 'Requiere rol admin' });
  }
  const u = await prisma.user.create({ data: { username: username.trim(), passHash: hashPassword(password), role: roleOk } });
  invalidateAuthCache();
  // bootstrap: devuelve token → queda logueado de una vez; si no, el GET
  // /users siguiente ya exige sesión y la UI muestra "Requiere rol admin"
  res.json({ ...pub(u), ...(bootstrap ? { token: (await issueToken(u.id)).token } : {}) });
});

r.put('/users/:id', guard('admin'), async (req, res) => {
  const { password, role, active } = req.body as { password?: string; role?: string; active?: boolean };
  const u = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      ...(password ? { passHash: hashPassword(password) } : {}),
      ...(role === 'admin' || role === 'anotador' || role === 'visita' ? { role } : {}),
      ...(active !== undefined ? { active: !!active } : {}),
    },
  });
  res.json(pub(u));
});

r.delete('/users/:id', guard('admin'), async (req, res) => {
  // borrar el último usuario = volver al modo abierto (sin login) — válido
  await prisma.user.delete({ where: { id: req.params.id } });
  invalidateAuthCache();
  res.json({ ok: true });
});

export default r;
