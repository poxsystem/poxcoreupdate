import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Reset + seed de prueba: borra TODO y crea una liga de 6 equipos
 * con rosters de 12 jugadores (9 titulares + 3 banca).
 * Uso: npx tsx src/reset-seed.ts
 */

const TEAMS = [
  ['Tigres', 'TIG'], ['Leones', 'LEO'], ['Águilas', 'AGU'],
  ['Cardenales', 'CAR'], ['Cometas', 'COM'], ['Tiburones', 'TIB'],
] as const;

const NOMBRES = [
  'Carlos', 'José', 'Luis', 'Pedro', 'Miguel', 'Andrés', 'Jesús', 'Daniel', 'Rafael', 'Omar',
  'Kevin', 'Ángel', 'Víctor', 'Mario', 'Jorge', 'Eduardo', 'Héctor', 'Wilson', 'Óscar', 'Franklin',
  'Ramón', 'César', 'David', 'Julio', 'Fernando', 'Ricardo', 'Gabriel', 'Antonio', 'Marcos', 'Javier',
];
const APELLIDOS = [
  'Pérez', 'Martínez', 'González', 'Ramírez', 'Torres', 'Flores', 'Rojas', 'Mora', 'Díaz', 'Vargas',
  'Soto', 'Reyes', 'Hernández', 'Castillo', 'Peña', 'Núñez', 'Cruz', 'Mendoza', 'Salazar', 'Ortiz',
  'Guerrero', 'Luna', 'Campos', 'Vega', 'López', 'Silva', 'Fuentes', 'Rivas', 'Acosta', 'Medina',
];
// 9 titulares + 3 banca
const POS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'EH', 'C', 'P'];

async function main() {
  // limpieza total (orden por FK)
  await prisma.gameEvent.deleteMany();
  await prisma.lineupEntry.deleteMany();
  await prisma.game.deleteMany();
  await prisma.series.deleteMany();
  await prisma.playerSeasonStat.deleteMany();
  await prisma.player.deleteMany();
  await prisma.team.deleteMany();
  await prisma.league.deleteMany();
  console.log('🧹 Base limpia');

  const league = await prisma.league.create({
    data: { name: 'Liga Test', year: 2026, sport: 'softball', playoffTeams: 4, playoffRounds: 2 },
  });
  console.log(`🏆 Liga: ${league.name} ${league.year} (${league.sport}) — clasifican 4, 2 rondas`);

  let ni = 0, ai = 0;
  for (const [name, shortName] of TEAMS) {
    const team = await prisma.team.create({ data: { name, shortName, leagueId: league.id } });
    for (let i = 0; i < POS.length; i++) {
      const bt = ['R', 'L', 'S'][i % 3];
      await prisma.player.create({
        data: {
          teamId: team.id,
          firstName: NOMBRES[(ni + i) % NOMBRES.length],
          lastName: `${APELLIDOS[(ai + i) % APELLIDOS.length]} ${shortName}`,
          number: i + 1 + (POS[i] === 'P' ? 30 : 0),
          bats: bt, throws: bt === 'L' ? 'L' : 'R',
          positions: POS[i] === 'EH' ? '2B,3B,EH' : POS[i],
        },
      });
    }
    ni += 5; ai += 7;
    console.log(`  + ${name} (12 jugadores)`);
  }
  console.log(`\n✅ Listo: ${await prisma.team.count()} equipos, ${await prisma.player.count()} jugadores`);
}

main().finally(() => prisma.$disconnect());
