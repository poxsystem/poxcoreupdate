import { useRef, useState } from 'react';
import type { Player } from '../api';

/**
 * Redimensiona una foto al cargarla: recorte cuadrado centrado + 256px JPEG.
 * El usuario elige cualquier imagen (aunque pese varios MB) y el sistema
 * la procesa sola — devuelve data URL base64 lista para guardar en Player.photo.
 */
export function resizePhoto(file: File, size = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      canvas.getContext('2d')!.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/** Silueta gris "SIN FOTO" — placeholder hasta que se suba la foto */
function Silhouette({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ opacity: 0.35, display: 'block' }}>
      <rect width="100" height="100" fill="#9ca3af" rx="8" />
      <circle cx="50" cy="36" r="17" fill="#e5e7eb" />
      <ellipse cx="50" cy="82" rx="26" ry="20" fill="#e5e7eb" />
      <text x="50" y="97" textAnchor="middle" fontSize="9" fill="#f9fafb" fontFamily="sans-serif">SIN FOTO</text>
    </svg>
  );
}

export default function PlayerAvatar({ player, size = 40 }: { player?: Partial<Player> | null; size?: number }) {
  if (player?.photo) {
    return <img src={player.photo} alt="" width={size} height={size}
      style={{ borderRadius: 8, objectFit: 'cover', display: 'block' }} />;
  }
  return <Silhouette size={size} />;
}

/**
 * Botón 📷 con input de archivo oculto: al elegir imagen la redimensiona
 * y llama onPhoto(dataUrl). onPhoto('') = quitar foto.
 */
export function PhotoPicker({ onPhoto, title = 'Cambiar foto' }: {
  onPhoto: (dataUrl: string) => void;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          try { onPhoto(await resizePhoto(f)); } finally { setBusy(false); }
        }} />
      <button type="button" className="secondary icon" title={title} disabled={busy}
        onClick={() => ref.current?.click()}>
        {busy ? '⏳' : '📷'}
      </button>
    </>
  );
}
