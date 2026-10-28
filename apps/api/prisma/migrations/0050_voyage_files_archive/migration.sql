-- 0050 — Archivage logique des fichiers de voyage (remplace l'état dérivé du journal d'audit).
ALTER TABLE "voyage_files"
  ADD COLUMN "archived_at" TIMESTAMPTZ(3),
  ADD COLUMN "archived_by_id" UUID;

-- Reprise de l'existant : dernier événement d'archivage / désarchivage de chaque fichier
UPDATE "voyage_files" vf
SET "archived_at" = e.occurred_at,
    "archived_by_id" = e.actor_id
FROM (
  SELECT DISTINCT ON (entity_id) entity_id, action, occurred_at, actor_id
  FROM audit_events
  WHERE entity_type = 'voyage_file'
    AND action IN ('voyage.file_archived', 'voyage.file_unarchived')
    AND result = 'SUCCESS'
  ORDER BY entity_id, occurred_at DESC
) e
WHERE vf.id::text = e.entity_id
  AND e.action = 'voyage.file_archived';
