/**
 * Express 4 NO lleva los rejections de handlers async al error middleware —
 * un throw de Prisma/red deja el socket colgado (el cliente espera eterna).
 * Este parche (equivalente a express-async-errors sin la dependencia)
 * intercepta la asignación `layer.handle = fn` que hace el Router al registrar
 * cada ruta y envuelve los handlers de request (≤3 args — los de error llevan
 * 4 y se respetan) para que una promesa rechazada llame next(err).
 * Se importa PRIMERO en index.ts para que queden cubiertas todas las rutas.
 */
// @ts-ignore — módulo interno de express sin tipos publicados
import Layer from 'express/lib/router/layer.js';

type Next = (e?: unknown) => void;
type Handler = (req: unknown, res: unknown, next: Next) => unknown;
interface LayerProto { handle?: unknown; __handle?: unknown }

const proto = Layer.prototype as LayerProto;
if (!Object.getOwnPropertyDescriptor(proto, 'handle')) {
  Object.defineProperty(proto, 'handle', {
    enumerable: true,
    get(this: LayerProto) { return this.__handle; },
    set(this: LayerProto, fn: unknown) {
      if (typeof fn === 'function' && (fn as Handler).length <= 3) {
        const orig = fn as Handler;
        fn = ((req: unknown, res: unknown, next: Next) => {
          Promise.resolve(orig(req, res, next)).catch(next);
        }) as Handler;
      }
      this.__handle = fn;
    },
  });
}
export {};
