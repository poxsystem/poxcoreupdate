import { useEffect, useRef, useState } from 'react';
import { api, Game } from '../api';

type Share = Awaited<ReturnType<typeof api.gameShare>>;

/** Tarjeta MVP vertical (720×1280) — canvas, con foto del jugador si tiene. */
function drawMvpCard(cv: HTMLCanvasElement, g: Game, mvp: NonNullable<Share['mvp']>, photoUrl?: string | null): Promise<void> {
  return new Promise((resolve) => {
    const W = 720, H = 1280;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d')!;
    const teamColor = g.homeTeam?.color ?? '#0d3b66';
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, teamColor); grad.addColorStop(1, '#08131f');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    const finish = () => {
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '26px system-ui';
      ctx.textAlign = 'center'; ctx.fillText('Generado en PoxScore · Alexis Lara · 2026', W / 2, H - 40);
      resolve();
    };
    const paint = () => {
      // textos
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = 'bold 34px system-ui';
      ctx.fillText('⭐ JUGADOR MÁS VALIOSO ⭐', W / 2, 110);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 62px system-ui';
      const words = mvp.name.replace(/^#\d+\s*/, '').split(' ');
      if (mvp.name.length > 16 && words.length > 1) {
        ctx.fillText(words[0], W / 2, 560); ctx.fillText(words.slice(1).join(' '), W / 2, 635);
      } else ctx.fillText(mvp.name, W / 2, 590);
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = 'bold 40px system-ui';
      ctx.fillText(mvp.line, W / 2, 700);
      ctx.font = '30px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(`${g.awayTeam?.name ?? 'Vis'} @ ${g.homeTeam?.name ?? 'Loc'}`, W / 2, 770);
      finish();
    };
    if (photoUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        // círculo con foto
        ctx.save();
        ctx.beginPath(); ctx.arc(W / 2, 330, 170, 0, Math.PI * 2); ctx.clip();
        const s = Math.max(340 / img.width, 340 / img.height);
        ctx.drawImage(img, W / 2 - img.width * s / 2, 330 - img.height * s / 2, img.width * s, img.height * s);
        ctx.restore();
        ctx.strokeStyle = '#f5a623'; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.arc(W / 2, 330, 170, 0, Math.PI * 2); ctx.stroke();
        paint();
      };
      img.onerror = paint;
      img.src = photoUrl;
    } else {
      // iniciales en círculo
      ctx.beginPath(); ctx.arc(W / 2, 330, 170, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
      ctx.strokeStyle = '#f5a623'; ctx.lineWidth = 8; ctx.stroke();
      const ini = mvp.name.replace(/^#\d+\s*/, '').split(' ').map((w) => w[0]).slice(0, 2).join('');
      ctx.fillStyle = '#fff'; ctx.font = 'bold 120px system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ini, W / 2, 330); ctx.textBaseline = 'alphabetic';
      paint();
    }
  });
}

export default function ShareModal({ game, onClose }: { game: Game; onClose: () => void }) {
  const [data, setData] = useState<Share | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  useEffect(() => {
    api.gameShare(game.id).then(async (d) => {
      setData(d);
      if (d.mvp) {
        try {
          const p = await api.playerFull(d.mvp.id).catch(() => null);
          if (p?.player.photo) setPhoto(p.player.photo);
        } catch { /* sin foto */ }
      }
    }).catch((e) => setErr((e as Error).message));
  }, [game.id]);

  useEffect(() => {
    if (!data?.mvp || !cvRef.current) return;
    void drawMvpCard(cvRef.current, game, data.mvp, photo);
  }, [data, game, photo]);

  const copy = (txt: string, tag: string) =>
    navigator.clipboard?.writeText(txt).then(() => { setCopied(tag); setTimeout(() => setCopied(''), 1500); }).catch(() => {});

  const shareNative = async () => {
    if (!data) return;
    if ('share' in navigator) {
      try { await navigator.share({ title: 'Resultado del juego', text: data.whatsapp }); } catch { /* cancelado */ }
    } else copy(data.whatsapp, 'native');
  };

  const downloadCard = () => {
    cvRef.current?.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `mvp-${game.id}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h2>📣 Compartir resultado</h2>
        {err && <p style={{ color: 'var(--red)' }}>{err}</p>}
        {!data ? <p className="muted">Generando resumen…</p> : (
          <>
            {data.mvp && (
              <div className="row" style={{ gap: '0.8rem', alignItems: 'flex-start' }}>
                <canvas ref={cvRef} style={{ width: 160, borderRadius: 10, border: '1px solid var(--line)' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800 }}>⭐ MVP: {data.mvp.name}</div>
                  <div className="muted">{data.mvp.line}</div>
                  <button className="secondary sm" style={{ marginTop: '0.5rem' }} onClick={downloadCard}>
                    ⬇ Tarjeta MVP (PNG vertical)
                  </button>
                </div>
              </div>
            )}
            <div style={{ marginTop: '0.8rem' }}>
              <div className="muted" style={{ fontSize: '0.78rem', fontWeight: 700 }}>RESUMEN</div>
              <p style={{ whiteSpace: 'pre-line', fontSize: '0.9rem', margin: '0.3rem 0' }}>{data.summary}</p>
            </div>
            {!!data.headlines.length && (
              <div>
                <div className="muted" style={{ fontSize: '0.78rem', fontWeight: 700 }}>TITULARES</div>
                {data.headlines.map((h, i) => <div key={i} style={{ fontSize: '0.85rem' }}>• {h}</div>)}
              </div>
            )}
            <div style={{ marginTop: '0.8rem' }}>
              <div className="muted" style={{ fontSize: '0.78rem', fontWeight: 700 }}>TEXTO WHATSAPP</div>
              <pre className="share-text">{data.whatsapp}</pre>
            </div>
            <div className="row" style={{ gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
              <button onClick={shareNative}>{'share' in navigator ? '📤 Compartir…' : '📋 Copiar'}</button>
              <a className="button-like secondary" target="_blank" rel="noreferrer"
                href={`https://wa.me/?text=${encodeURIComponent(data.whatsapp)}`}>🟢 WhatsApp</a>
              <button className="secondary" onClick={() => copy(data.facebook, 'fb')}>
                {copied === 'fb' ? '✓ Copiado' : '🔵 Copiar p/ Facebook'}
              </button>
            </div>
            {copied === 'native' && <p className="muted">✓ Texto copiado</p>}
            {!data.ai && <p className="muted" style={{ fontSize: '0.72rem' }}>Sin OPENAI_API_KEY — resumen generado localmente.</p>}
          </>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.8rem' }}>
          <button className="secondary" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
