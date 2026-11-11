import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Rosters de prueba: 12 jugadores por equipo (9 titulares + 3 banca)
const TEAMS: { name: string; shortName: string; players: [string, string, number, string, string][] }[] = [
  {
    name: 'Tigres', shortName: 'TIG',
    players: [
      ['Carlos', 'Pérez', 22, 'R', 'P'], ['José', 'Martínez', 4, 'R', 'C'],
      ['Luis', 'González', 18, 'L', '1B'], ['Pedro', 'Ramírez', 7, 'R', '2B'],
      ['Miguel', 'Torres', 33, 'R', '3B'], ['Andrés', 'Flores', 2, 'R', 'SS'],
      ['Jesús', 'Rojas', 8, 'L', 'LF'], ['Daniel', 'Mora', 24, 'R', 'CF'],
      ['Rafael', 'Díaz', 10, 'L', 'RF'], ['Omar', 'Vargas', 15, 'S', 'UTL'],
      ['Kevin', 'Soto', 27, 'R', 'C'], ['Ángel', 'Reyes', 40, 'R', 'P'],
    ],
  },
  {
    name: 'Leones', shortName: 'LEO',
    players: [
      ['Víctor', 'Hernández', 30, 'R', 'P'], ['Mario', 'Castillo', 12, 'R', 'C'],
      ['Jorge', 'Peña', 45, 'L', '1B'], ['Eduardo', 'Núñez', 5, 'R', '2B'],
      ['Héctor', 'Cruz', 9, 'R', '3B'], ['Wilson', 'Mendoza', 1, 'S', 'SS'],
      ['Óscar', 'Salazar', 21, 'L', 'LF'], ['Franklin', 'Ortiz', 13, 'R', 'CF'],
      ['Ramón', 'Guerrero', 19, 'R', 'RF'], ['César', 'Luna', 26, 'R', 'UTL'],
      ['David', 'Campos', 35, 'L', '1B'], ['Julio', 'Vega', 51, 'L', 'P'],
    ],
  },
  {
    name: 'Águilas', shortName: 'AGU',
    players: [
      ['Fernando', 'López', 34, 'R', 'P'], ['Ricardo', 'Silva', 3, 'R', 'C'],
      ['Gabriel', 'Fuentes', 44, 'L', '1B'], ['Antonio', 'Rivas', 6, 'R', '2B'],
      ['Marcos', 'Acosta', 11, 'R', '3B'], ['Javier', 'Medina', 14, 'S', 'SS'],
      ['Sergio', 'Paredes', 23, 'L', 'LF'], ['Iván', 'Cabrera', 28, 'R', 'CF'],
      ['Nelson', 'Duarte', 16, 'R', 'RF'], ['Tomás', 'Ibarra', 20, 'R', 'UTL'],
      ['Alfredo', 'Suárez', 32, 'R', 'C'], ['Ernesto', 'Velasco', 48, 'L', 'P'],
    ],
  },
  {
    name: 'Cardenales', shortName: 'CAR',
    players: [
      ['Roberto', 'Sandoval', 29, 'R', 'P'], ['Manuel', 'Contreras', 17, 'R', 'C'],
      ['Arturo', 'Domínguez', 41, 'L', '1B'], ['Félix', 'Guerra', 4, 'R', '2B'],
      ['Óliver', 'Mejía', 25, 'R', '3B'], ['Samuel', 'Ponce', 8, 'S', 'SS'],
      ['Adrián', 'Escobar', 31, 'L', 'LF'], ['Hugo', 'Quintero', 36, 'R', 'CF'],
      ['René', 'Barrios', 39, 'R', 'RF'], ['Elías', 'Rosales', 42, 'R', 'UTL'],
      ['Diego', 'Aparicio', 47, 'L', 'C'], ['Martín', 'Zamora', 55, 'R', 'P'],
    ],
  },
];

async function main() {
  for (const t of TEAMS) {
    let team = await prisma.team.findFirst({ where: { name: t.name } });
    if (!team) {
      team = await prisma.team.create({ data: { name: t.name, shortName: t.shortName } });
      console.log(`+ Equipo creado: ${t.name}`);
    } else {
      console.log(`= Equipo existe: ${t.name}`);
    }

    const count = await prisma.player.count({ where: { teamId: team.id } });
    if (count >= t.players.length) {
      console.log(`  roster completo (${count}), omitido`);
      continue;
    }
    const toAdd = t.players.slice(count);
    for (const [firstName, lastName, number, bt, pos] of toAdd) {
      await prisma.player.create({
        data: {
          teamId: team.id, firstName, lastName, number,
          bats: bt, throws: bt === 'S' ? 'R' : bt,
          positions: pos === 'UTL' ? '2B,3B,SS' : pos,
        },
      });
    }
    console.log(`  + ${toAdd.length} jugadores agregados`);
  }
  const total = await prisma.player.count();
  console.log(`\nListo: ${await prisma.team.count()} equipos, ${total} jugadores`);
}

main().finally(() => prisma.$disconnect());
