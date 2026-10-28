-- Exécuté une seule fois à la création du volume PostgreSQL.
-- Base "shadow" utilisée par `prisma migrate diff` pour générer les migrations.
CREATE DATABASE amc_shadow;

-- Extensions utiles (recherche approchée sur métadonnées)
\connect amc
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

\connect amc_shadow
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
