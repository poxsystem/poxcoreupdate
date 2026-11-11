import { parseBoxFile } from './src/import/boxfile.js';
import { readFileSync, readdirSync } from 'fs';
const dir = 'C:/tmp-box';
for (const f of readdirSync(dir)) {
  const txt = readFileSync(`${dir}/${f}`, 'utf-8');
  const g = parseBoxFile(txt, f);
  if (!g) { console.log(`${f}: NULL`); continue; }
  console.log(`\n═══ ${f}`);
  console.log(`  ${g.away} ${g.scoreAway} @ ${g.home} ${g.scoreHome} · ${g.dateIso} · ${g.innings} inn · W:${g.wp} L:${g.lp} S:${g.sv}`);
  for (const r of g.rows) {
    const s = r.stats;
    const lbl = r.section === 'bat' ? `AB${s.ab} R${s.r} H${s.h} BI${s.rbi} BB${s.bb} SO${s.k} [${s.po}-${s.a}-${s.e}]${s.doubles ? ' 2B' + s.doubles : ''}${s.hr ? ' HR' + s.hr : ''}${s.sb ? ' SB' + s.sb : ''}${s.sf ? ' SF' + s.sf : ''}`
      : `${Math.floor((s.pOuts ?? 0) / 3)}.${(s.pOuts ?? 0) % 3}IP H${s.pH} R${s.pR} ER${s.pER} BB${s.pBB} SO${s.pK}${s.pPitches ? ' P' + s.pPitches : ''}${s.bf ? ' BF' + s.bf : ''}`;
    console.log(`  [${r.team === g.away ? 'V' : 'L'}] ${r.name} ${r.pos ?? ''} ${r.dec ?? ''} → ${lbl}`);
  }
  if (g.warnings.length) console.log('  ⚠ ' + g.warnings.join(' | '));
}
