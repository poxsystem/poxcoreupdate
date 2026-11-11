import { parseBoxFile, bestMatches, fileNameParts } from './src/import/boxfile.js';
import fs from 'node:fs';
const r = parseBoxFile(fs.readFileSync('test-game.box.txt', 'utf8'), '10-10-26 TIGRES at AGUILAS.box.txt');
console.log(JSON.stringify({ date: r?.dateIso, away: r?.away, home: r?.home, score: [r?.scoreAway, r?.scoreHome], inn: r?.innings, wp: r?.wp, lp: r?.lp, warns: r?.warnings }));
for (const row of r?.rows ?? []) console.log(row.section.padEnd(3), '|', row.team, '|', row.name, '|', row.pos ?? '', '|', row.dec ?? '', '|', JSON.stringify(row.stats));
console.log('--- match ---');
console.log('LARA, Pedro →', JSON.stringify(fileNameParts('LARA, Pedro')));
console.log('match vs {Pedro Lara}:', JSON.stringify(bestMatches('LARA, Pedro', [{ id: '1', firstName: 'Pedro', lastName: 'Lara' }])));
console.log('match vs {Pedro Lara Vargas}:', JSON.stringify(bestMatches('Lara, P.', [{ id: '1', firstName: 'Pedro', lastName: 'Lara Vargas' }])));
