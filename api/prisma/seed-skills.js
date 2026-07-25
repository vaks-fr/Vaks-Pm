// Seed du catalogue de compétences IT, organisé en *packs* modulaires.
// Chaque pack = un fichier JSON dans ./skill-packs/ : { id, label, color, skills: [{name, description}] }
// Standalone (sans ts-node), exécutable dans l'image runtime de l'API.
// Idempotent : upsert sur (organizationId, name) ; ne crée jamais de doublon.
//
// Usage (dans le container API, cwd = /app/api) :
//   export DATABASE_URL=$(cat /run/secrets/database_url)
//   node prisma/seed-skills.js --list            # liste les packs disponibles
//   node prisma/seed-skills.js                    # injecte TOUS les packs
//   node prisma/seed-skills.js azure              # injecte un seul pack
//   node prisma/seed-skills.js cloud devops aws   # injecte plusieurs packs
//   node prisma/seed-skills.js azure --team "Cloud & Infra"  # + bind à une équipe
//
// `--team <nom>` : après l'upsert des skills, les rattache comme compétences
// de l'équipe nommée (TeamSkill). L'équipe doit exister (créée dans l'admin).
// Le `category` de chaque skill est renseigné depuis le `label` du pack —
// c'est ce qui alimente les « dossiers » du picker côté UI.
//
// ORG cible : `seed-org` par défaut, surchargeable via SEED_ORG_ID.
const fs = require('fs');
const path = require('path');
const { createPrismaClient } = require('./_client');

const PACKS_DIR = path.join(__dirname, 'skill-packs');

function loadPacks() {
  const files = fs
    .readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const packs = {};
  for (const f of files) {
    const pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
    const id = pack.id || path.basename(f, '.json');
    packs[id] = { id, label: pack.label || id, color: pack.color, skills: pack.skills || [] };
  }
  return packs;
}

(async () => {
  const args = process.argv.slice(2);
  const packs = loadPacks();

  if (args.includes('--list')) {
    for (const p of Object.values(packs)) {
      console.log(`${p.id.padEnd(18)} ${String(p.skills.length).padStart(3)} skills  — ${p.label}`);
    }
    console.log(`\n${Object.keys(packs).length} packs, ${Object.values(packs).reduce((n, p) => n + p.skills.length, 0)} skills au total.`);
    return;
  }

  // --team <nom> : rattache les skills injectés à une équipe (TeamSkill).
  let teamName = null;
  const teamIdx = args.indexOf('--team');
  if (teamIdx !== -1) teamName = args[teamIdx + 1] || null;

  const requested = args.filter(
    (a, i) => !a.startsWith('--') && !(teamIdx !== -1 && i === teamIdx + 1),
  );
  const selected = requested.length ? requested : Object.keys(packs);

  const unknown = selected.filter((id) => !packs[id]);
  if (unknown.length) {
    console.error(`Pack(s) inconnu(s): ${unknown.join(', ')}. Dispo: ${Object.keys(packs).join(', ')}`);
    process.exit(1);
  }

  const orgId = process.env.SEED_ORG_ID || 'seed-org';
  const prisma = createPrismaClient();
  let created = 0;
  let updated = 0;
  try {
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new Error(`Organisation introuvable: ${orgId}`);

    const seededSkillIds = [];
    for (const id of selected) {
      const pack = packs[id];
      for (const { name, description } of pack.skills) {
        const existing = await prisma.skill.findUnique({
          where: { organizationId_name: { organizationId: orgId, name } },
        });
        const skill = await prisma.skill.upsert({
          where: { organizationId_name: { organizationId: orgId, name } },
          update: {
            description,
            color: pack.color,
            category: pack.label,
            deletedAt: null,
          },
          create: {
            organizationId: orgId,
            name,
            description,
            color: pack.color,
            category: pack.label,
          },
        });
        seededSkillIds.push(skill.id);
        if (existing) updated++;
        else created++;
      }
    }

    let teamBinding;
    if (teamName) {
      const team = await prisma.team.findFirst({
        where: { organizationId: orgId, name: teamName, deletedAt: null },
        select: { id: true },
      });
      if (!team) throw new Error(`Équipe introuvable: "${teamName}"`);
      let linked = 0;
      for (const skillId of seededSkillIds) {
        await prisma.teamSkill.upsert({
          where: { teamId_skillId: { teamId: team.id, skillId } },
          update: {},
          create: { teamId: team.id, skillId },
        });
        linked++;
      }
      teamBinding = { team: teamName, linked };
    }

    console.log(
      JSON.stringify({ orgId, packs: selected, created, updated, teamBinding }),
    );
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
