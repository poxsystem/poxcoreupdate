/**
 * Cliente OpenAI liviano (fetch — sin dependencia SDK).
 * Lee OPENAI_API_KEY de env; sin clave → null y cada módulo usa su respaldo
 * determinístico (reglas propias), así la app funciona igual sin IA.
 */
export async function aiChat(system: string, user: string): Promise<unknown | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!r.ok) { console.error(`OpenAI chat ${r.status}:`, (await r.text()).slice(0, 300)); return null; }
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const txt = j.choices?.[0]?.message?.content ?? '';
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

export const aiEnabled = () => !!process.env.OPENAI_API_KEY;

/** Verifica que la clave funcione de verdad contra la API (modelos → 401/429/…). */
export async function aiCheck(): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, error: 'sin clave' };
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    return { ok: false, error: `OpenAI ${r.status}: ${j.error?.message ?? r.statusText}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Audio → texto (Whisper). Devuelve el texto o el error real de OpenAI. */
export async function aiTranscribe(audioB64: string, mime: string): Promise<{ text?: string; error?: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { error: 'sin clave OpenAI — configúrala en 🎤 → ⚙️' };
  try {
    const buf = Buffer.from(audioB64, 'base64');
    const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'wav';
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);
    fd.append('model', 'whisper-1');
    fd.append('language', 'es');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
      return { error: `OpenAI ${r.status}: ${j.error?.message ?? r.statusText}` };
    }
    return { text: ((await r.json()) as { text?: string }).text ?? '' };
  } catch (e) { return { error: (e as Error).message }; }
}

/** Diccionario de slang dominicano de pelota (incluido en los prompts) */
export const DOMINICAN_GLOSSARY = `
Diccionario dominicano de pelota:
- "rolling"/"roling"/"rolín" = rodado (ground out, ej. "rolling por segunda" = 4-3)
- "tablazo"/"batazo"/"bombazo" = hit / jonrón según contexto ("se fue" = HR)
- "línea"/"liña" = line drive (L7/L8/L9)
- "elevado"/"fly"/"flai" = fly out (F7/F8/F9)
- "ponche"/"chocolate"/"se lo cantaron"/"tirándole" = K (strikeout)
- "base por bola"/"boleto"/"pasaporte"/"cuatro malas" = BB
- "pelotazo"/"bolazo"/"lo golpearon" = HBP
- "se la tiró el derecho/left/center" = hit a RF/LF/CF
- "se embasó por error"/"el antesalista la botó" = E5 etc.
- "doble play"/"dobleplei"/"dos por uno" = DP
- "anotó una"/"pisó el plato"/"entró en carrera" = carrera
- "robo"/"se estafó"/"llegó callao" = SB
- "wild pitch"/"descontrol" = WP ; "pasbola" = PB
- "sacrificio"/"toque"/"toquito" = SAC/SH ; "fly de sacrificio" = SF
- "hit por el right/left/center" = hit al jardín derecho/izquierdo/central
- "abierto por ..." = hit a la banda contraria
`;
