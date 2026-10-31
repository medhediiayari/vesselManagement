-- Arborescence Certificats (28/10/2026) : dossiers hiérarchiques de classement et référentiel des catégories,
-- gérés depuis l'explorateur ; renouvellement sans approbation (permission dédiée).

-- Dossiers
CREATE TABLE "certificate_folders" (
    "id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "certificate_folders_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "certificate_folders_parent_id_idx" ON "certificate_folders"("parent_id");
ALTER TABLE "certificate_folders" ADD CONSTRAINT "certificate_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "certificate_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "certificates" ADD COLUMN "folder_id" UUID;
CREATE INDEX "certificates_folder_id_idx" ON "certificates"("folder_id");
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "certificate_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Catégories : reprise des catégories déjà portées par les types
CREATE TABLE "certificate_categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "certificate_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "certificate_categories_name_key" ON "certificate_categories"("name");

INSERT INTO "certificate_categories" ("id", "name", "updated_at")
SELECT gen_random_uuid(), t."category", CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "category" FROM "certificate_types") t
ON CONFLICT ("name") DO NOTHING;

-- Permissions (Super Admin les détient d'office ; à accorder aux autres rôles via l'administration des rôles)
INSERT INTO "permissions" ("key", "module", "label", "is_sensitive") VALUES
  ('certificates.renewal.self_approve', 'certificates', 'Renouveler sans approbation (le nouveau certificat devient courant immédiatement)', true),
  ('certificates.folders.manage', 'certificates', 'Créer / renommer / supprimer les dossiers de l''arborescence et y classer les certificats', false),
  ('certificates.categories.manage', 'certificates', 'Créer / renommer / supprimer les catégories de l''arborescence', true)
ON CONFLICT ("key") DO NOTHING;
