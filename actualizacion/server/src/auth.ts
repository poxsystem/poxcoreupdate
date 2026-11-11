import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from './prisma.js';

export type Role = 'visita' | 'anotador' | 'admin';
const RANK: Record<string, number> = { visita: 0, anotador: 1, admin: 2 };
const TOKEN_TTL_MS = 30 * 24 * 3600_000; // 30 días

export function hashPassword(pass: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pass, salt, 64).toString('hex')}`;
}

export function checkPassword(pass: string, stored: string) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const cand = crypto.scryptSync(pass, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return cand.length === real.length && crypto.timingSafeEqual(cand, real);
}

export async function issueToken(userId: string) {
  return prisma.authToken.create({
    data: { token: crypto.randomBytes(24).toString('hex'), userId, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
  });
}

// ─── Opt-in: mientras no haya usuarios, todo queda abierto (instalación local) ─
let cache: { n: number; at: number } | null = null;
export function invalidateAuthCache() { cache = null; }
export async function authEnabled() {
  try {
    if (!cache || Date.now() - cache.at > 10_000) cache = { n: await prisma.user.count(), at: Date.now() };
    return cache.n > 0;
  } catch {
    // fail-closed: si la BD no responde (MySQL todavía arrancando) mejor pedir
    // login que caer al modo abierto — un count() fallido no significa "sin usuarios"
    return cache ? cache.n > 0 : true;
  }
}

/** Ya NO se siembra admin automático: sin usuarios = modo abierto (sin login).
 * Quien quiera usuarios crea el primero en /usuarios; las acciones de admin se
 * protegen con ADMIN_KEY del .env mientras tanto (ver adminOk). */

/**
 * Guarda de escritura: GET/HEAD/OPTIONS siempre pasan; los métodos que mutan
 * requieren un token con rol >= min — solo cuando ya existen usuarios.
 */
/** Quién hace la petición (por token); null si no hay sesión válida. */
export async function reqUser(req: Request) {
  const tok = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  const t = await prisma.authToken.findUnique({ where: { token: tok }, include: { user: true } });
  return t && t.expiresAt > new Date() && t.user.active ? t.user : null;
}

/**
 * Verifica la clave de admin para acciones destructivas (estilo macOS: pide
 * la contraseña aunque ya haya sesión). Coincide con la contraseña de
 * cualquier usuario activo con rol admin, o con ADMIN_KEY del .env si no
 * hay usuarios creados.
 */
export async function adminOk(pass: string | undefined): Promise<{ ok: boolean; error?: string; code?: number }> {
  if (!pass) return { ok: false, error: 'Clave de administrador requerida', code: 401 };
  const admins = await prisma.user.findMany({ where: { role: 'admin', active: true } });
  if (admins.length) {
    return admins.some((u) => checkPassword(pass, u.passHash))
      ? { ok: true }
      : { ok: false, error: 'Clave de administrador incorrecta', code: 401 };
  }
  const envKey = process.env.ADMIN_KEY?.trim();
  if (!envKey) return { ok: false, error: 'No hay clave de admin configurada — crea un usuario admin en 👥 Usuarios', code: 503 };
  return pass === envKey ? { ok: true } : { ok: false, error: 'Clave de administrador incorrecta', code: 401 };
}

export function guard(min: Role) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!(await authEnabled())) return next();
    const tok = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!tok) return res.status(401).json({ error: 'Sesión requerida' });
    const t = await prisma.authToken.findUnique({ where: { token: tok }, include: { user: true } });
    if (!t || t.expiresAt < new Date() || !t.user.active) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    if ((RANK[t.user.role] ?? 0) < RANK[min]) return res.status(403).json({ error: `Requiere rol ${min}` });
    (req as Request & { user?: unknown }).user = t.user;
    next();
  };
}
