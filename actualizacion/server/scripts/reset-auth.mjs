// reset-auth.mjs — borra usuarios y sesiones → modo abierto (sin pantalla
// de login). Las acciones de admin quedan protegidas por ADMIN_KEY del
// .env (admin123 por defecto). Corre con cwd=server\ :  node scripts\reset-auth.mjs
import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
try {
  const t = await p.authToken.deleteMany();
  const u = await p.user.deleteMany();
  console.log(`reset-auth: ${u.count} usuario(s) y ${t.count} sesion(es) borradas — modo abierto`);
} finally {
  await p.$disconnect();
}
