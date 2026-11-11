# Empaquetar `actualizacion/` (paquete incremental)

`actualizacion/` es una **foto del código compilado + fuentes** que se copia a la PC
destino; dentro lleva `ACTUALIZAR.bat`, que es quien instala (detiene el launcher,
copia archivos, corre `prisma db push` + `generate`, siembra `ADMIN_KEY`, resetea auth).

## Vía rápida

```
Empaquetar-Actualizacion.bat     ← raíz del repo: build + sync + verificación
```

O a mano (lo que el bat hace exactamente):

## 1. Build primero — siempre

```bash
npm run build        # shared → server (esbuild dist/index.js) → web (vite dist/)
```

Sin esto el paquete lleva `dist` viejos y la actualización "no pega".

## 2. Carpetas espejo (robocopy /MIR — borra lo que ya no existe)

| Origen | Destino | Notas |
|---|---|---|
| `web/dist` | `actualizacion/web/dist` | lo que ACTUALIZAR.bat instala |
| `web/dist/assets` | `actualizacion/web/assets` | duplicado suelto que el paquete lleva en raíz |
| `server/dist` | `actualizacion/server/dist` | |
| `server/src` | `actualizacion/server/src` | |
| `server/scripts` | `actualizacion/server/scripts` | `reset-auth.mjs` lo llama el instalador |
| `server/prisma` | `actualizacion/server/prisma` | schema → `db push` en destino |
| `shared/src` | `actualizacion/shared-src` | motor (nombre distinto a propósito) |
| `web/src` | `actualizacion/web-src` | fuentes para arreglos en campo |
| `docs` | `actualizacion/docs` | |
| `launcher` | `actualizacion/launcher` | **excluir** `node_modules`, `*.log`, `*.pid`, `*.backup.*` |

## 3. Archivos sueltos

- `actualizacion/web/`: `index.html`, `sw.js`, `workbox-*.js`, `manifest.webmanifest`, `registerSW.js` (de `web/dist` — copias raíz históricas del paquete).
- `actualizacion/server/`: `tsconfig.json`, `selftest.cjs`, `test-*.*` (y borrar los `test-*` que ya no existan en `server/`).
- `actualizacion/AGENTS.md` ← `AGENTS.md`.
- **NO tocar**: `ACTUALIZAR.bat`, `LEEME.txt`, `Convertir-Liga.bat` (son del paquete, no del build).

## 4. Verificar

```bash
diff -rq web/dist actualizacion/web/dist     # igual para cada carpeta espejo
```

## Gotchas

- **Git Bash + robocopy**: `/MIR` se convierte en ruta (`C:/Program Files/Git/MIR`) y `web\dist` se aplana a `webdist`. Desde bash usar slashes y `export MSYS2_ARG_CONV_EXCL='*'` antes de llamar robocopy — o simplemente correr el `.bat`.
- **Códigos robocopy**: 0-7 = éxito (1 copió, 3 copió+depuró); ≥8 = error real.
- **DLL bloqueado**: si `prisma generate` corre en el repo con node/tsx vivo, matar procesos primero (ver AGENTS.md).
- Si el paquete va a una PC con la app corriendo, `ACTUALIZAR.bat` ya se encarga de detener launcher+server antes de copiar.
