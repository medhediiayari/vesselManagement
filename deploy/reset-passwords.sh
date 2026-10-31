#!/usr/bin/env bash
# À lancer UNE FOIS sur le serveur, juste après le transfert des données et AVANT d'ouvrir l'accès aux utilisateurs.
# Remplace le mot de passe de chaque compte actif par un mot de passe temporaire aléatoire (changement imposé à la
# première connexion) : la base vient du poste de développement, où tous les comptes avaient un mot de passe d'exemple
# public (.env.example). Sessions révoquées, événement d'audit système.
# Sortie : « identifiant;mot de passe temporaire » sur la sortie standard, à transmettre à chaque personne puis effacer.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod run --rm -T --no-deps api node -e '
const argon2 = require("argon2");
const { randomBytes, randomUUID } = require("crypto");
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
// Mêmes paramètres que PasswordService (Argon2id, OWASP)
const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
// 16 caractères sans caractères ambigus, au moins une majuscule, une minuscule, un chiffre
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const temp = () => { for (;;) { const b = randomBytes(16); const p = [...b].map((x) => ALPHA[x % ALPHA.length]).join("");
  if (/[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p)) return p; } };
(async () => {
  const users = await db.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, username: true }, orderBy: { username: "asc" } });
  const out = [];
  for (const u of users) {
    const p = temp();
    await db.$transaction([
      db.user.update({ where: { id: u.id }, data: { passwordHash: await argon2.hash(p, OPTS), mustChangePassword: true, passwordChangedAt: new Date() } }),
      db.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "PASSWORD_RESET_BY_ADMIN" } }),
    ]);
    out.push(`${u.username};${p}`);
  }
  await db.auditEvent.create({ data: { id: randomUUID(), action: "platform.passwords_reset_for_production", module: "platform", entityType: "platform",
    actorLabel: "Système (mise en production)", result: "SUCCESS", metadata: { accounts: users.length } } });
  console.log(out.join("\n"));
  await db.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
'
