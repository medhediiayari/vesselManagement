-- Publication directe sans approbation (27/10/2026) : certains utilisateurs (Super Admin, CSO, CSO adjoint)
-- publient leurs certificats / documents CSO sans passer par le circuit de validation.
-- La décision reste tracée (décision APPROVE par l'auteur, audit metadata.selfApproved = true).
INSERT INTO "permissions" ("key", "module", "label", "is_sensitive") VALUES
  ('certificates.self_approve', 'certificates', 'Publication directe sans approbation (ses propres demandes)', true),
  ('cso.self_approve', 'cso', 'Publication directe sans approbation (ses propres versions)', true)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT r."id", 'cso.self_approve' FROM "roles" r WHERE r."key" = 'CSO_OFFICER'
ON CONFLICT DO NOTHING;
