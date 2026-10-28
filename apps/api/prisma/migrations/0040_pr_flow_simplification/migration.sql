-- Refonte simplifiée du flux Purchase Request (22/10/2026) :
--  - PR mère « Divisée » (SPLIT) et sous-PR liées (parent_id), lignes copiées (source_line_id) ;
--  - Counter-PR appliquée directement : modifications d'en-tête tracées (header_changes) ;
--  - BL saisi à bord : articles reçus hors BC (delivery_note_extra_items, information sans alerte) ;
--  - droit pr.view_all : voir toutes les PR du navire (sans lui : uniquement ses propres PR).

-- AlterEnum
ALTER TYPE "PrStatus" ADD VALUE 'SPLIT';

-- AlterTable
ALTER TABLE "pr_lines" ADD COLUMN     "source_line_id" UUID;

-- AlterTable
ALTER TABLE "pr_revisions" ADD COLUMN     "header_changes" JSONB;

-- AlterTable
ALTER TABLE "purchase_requests" ADD COLUMN     "parent_id" UUID;

-- CreateTable
CREATE TABLE "delivery_note_extra_items" (
    "id" UUID NOT NULL,
    "delivery_note_id" UUID NOT NULL,
    "designation" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(200),
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "remarks" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_note_extra_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "delivery_note_extra_items_qty_positive" CHECK ("quantity" > 0)
);

-- CreateIndex
CREATE INDEX "delivery_note_extra_items_delivery_note_id_idx" ON "delivery_note_extra_items"("delivery_note_id");

-- CreateIndex
CREATE INDEX "purchase_requests_parent_id_idx" ON "purchase_requests"("parent_id");

-- AddForeignKey
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "purchase_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_note_extra_items" ADD CONSTRAINT "delivery_note_extra_items_delivery_note_id_fkey" FOREIGN KEY ("delivery_note_id") REFERENCES "delivery_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Une sous-PR ne peut pas être sa propre mère
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_parent_not_self" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- Droit pr.view_all : sans changement pour les rôles existants (tous ceux qui voyaient les PR le reçoivent),
-- SAUF le Chief Engineer qui ne voit plus que ses propres PR (décision AMC du 22/10/2026).
INSERT INTO "permissions" ("key", "module", "label", "is_sensitive")
VALUES ('pr.view_all', 'purchasing', 'Voir toutes les PR du navire (sinon : uniquement ses propres PR et leurs BC / BL)', false)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT rp."role_id", 'pr.view_all'
FROM "role_permissions" rp
JOIN "roles" r ON r."id" = rp."role_id"
WHERE rp."permission_key" = 'pr.view' AND r."key" <> 'CHIEF_ENGINEER'
ON CONFLICT DO NOTHING;
