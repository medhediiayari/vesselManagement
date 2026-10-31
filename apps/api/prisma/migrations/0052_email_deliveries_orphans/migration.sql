-- Audit DAT-01 : 6 envois d'e-mails référençaient des notifications supprimées alors que les déclencheurs
-- étaient désactivés (session_replication_role = replica, purge Achats du 21/10/2026). La contrainte
-- email_deliveries_notification_id_fkey est « validée » mais violée : un pg_restore échoue à la recréer.
-- On applique a posteriori l'effet prévu du ON DELETE SET NULL.
UPDATE "email_deliveries"
SET "notification_id" = NULL
WHERE "notification_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "notifications" n WHERE n."id" = "email_deliveries"."notification_id");
