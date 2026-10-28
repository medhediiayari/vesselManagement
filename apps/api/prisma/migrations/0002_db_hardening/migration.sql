-- =============================================================================
-- 0002 — Durcissement base de données (invariants CDC §10.2 / §12 / §13.2)
-- Éléments non exprimables dans schema.prisma : triggers, index partiels,
-- contraintes CHECK, index trigrammes, vues de rapprochement.
-- IMPORTANT : ne pas utiliser `prisma migrate dev` (il tenterait de supprimer ces objets).
-- Générer les migrations suivantes avec `npm run prisma:diff` puis relire le SQL.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Journaux et versions immuables
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION amc_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % en écriture seule (append-only) : % interdit', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Audit Log append-only (ADM-011, CDC §10.2)
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION amc_forbid_mutation();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION amc_forbid_mutation();

-- Versions de demande de certificat : immuables (ADM-058)
CREATE TRIGGER certificate_request_versions_immutable
  BEFORE UPDATE OR DELETE ON certificate_request_versions
  FOR EACH ROW EXECUTE FUNCTION amc_forbid_mutation();

-- Décisions d'approbation : immuables
CREATE TRIGGER certificate_approval_decisions_immutable
  BEFORE UPDATE OR DELETE ON certificate_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION amc_forbid_mutation();

-- Révision officielle de certificat : seuls lifecycle / archived_at évoluent
CREATE OR REPLACE FUNCTION amc_guard_certificate_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'certificate_revisions : suppression interdite (archivage uniquement)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.certificate_id, NEW.revision_no, NEW.certificate_number, NEW.issuer, NEW.authority,
      NEW.country, NEW.place_of_issue, NEW.issued_on, NEW.valid_from, NEW.expiry_kind,
      NEW.expiry_on, NEW.remarks, NEW.approved_request_id, NEW.approved_by_id, NEW.approved_at)
     IS DISTINCT FROM
     (OLD.certificate_id, OLD.revision_no, OLD.certificate_number, OLD.issuer, OLD.authority,
      OLD.country, OLD.place_of_issue, OLD.issued_on, OLD.valid_from, OLD.expiry_kind,
      OLD.expiry_on, OLD.remarks, OLD.approved_request_id, OLD.approved_by_id, OLD.approved_at) THEN
    RAISE EXCEPTION 'certificate_revisions : révision officielle immuable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER certificate_revisions_guard
  BEFORE UPDATE OR DELETE ON certificate_revisions
  FOR EACH ROW EXECUTE FUNCTION amc_guard_certificate_revision();

-- Versions CSO : le blob, le document et le numéro sont figés
CREATE OR REPLACE FUNCTION amc_guard_cso_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cso_versions : suppression interdite' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.document_id, NEW.version_no, NEW.file_id) IS DISTINCT FROM (OLD.document_id, OLD.version_no, OLD.file_id) THEN
    RAISE EXCEPTION 'cso_versions : version documentaire immuable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cso_versions_guard
  BEFORE UPDATE OR DELETE ON cso_versions
  FOR EACH ROW EXECUTE FUNCTION amc_guard_cso_version();

-- Révisions Noon Report figées (seul le PDF généré peut être rattaché a posteriori)
CREATE OR REPLACE FUNCTION amc_guard_noon_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'noon_report_revisions : suppression interdite' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.noon_report_id, NEW.revision_no, NEW.data, NEW.reason, NEW.created_by_id, NEW.created_at)
     IS DISTINCT FROM (OLD.noon_report_id, OLD.revision_no, OLD.data, OLD.reason, OLD.created_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'noon_report_revisions : révision figée' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER noon_report_revisions_guard
  BEFORE UPDATE OR DELETE ON noon_report_revisions
  FOR EACH ROW EXECUTE FUNCTION amc_guard_noon_revision();

-- Blobs : l'identité du contenu ne change jamais (seul le bucket évolue : quarantaine -> officiel)
CREATE OR REPLACE FUNCTION amc_guard_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'files : suppression physique interdite (deleted_at / rétention)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.object_key, NEW.sha256, NEW.size_bytes, NEW.mime_type) IS DISTINCT FROM
     (OLD.object_key, OLD.sha256, OLD.size_bytes, OLD.mime_type) THEN
    RAISE EXCEPTION 'files : contenu immuable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.owner_id IS NOT NULL AND (NEW.owner_type, NEW.owner_id) IS DISTINCT FROM (OLD.owner_type, OLD.owner_id) THEN
    RAISE EXCEPTION 'files : propriétaire déjà défini' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER files_guard
  BEFORE UPDATE OR DELETE ON files
  FOR EACH ROW EXECUTE FUNCTION amc_guard_file();

-- -----------------------------------------------------------------------------
-- 2. Index partiels uniques (invariants "un seul courant")
-- -----------------------------------------------------------------------------
-- Une seule révision officielle courante par certificat (CERT-04)
CREATE UNIQUE INDEX certificate_revisions_one_current
  ON certificate_revisions (certificate_id) WHERE lifecycle = 'CURRENT';
-- Une seule pièce officielle par révision
CREATE UNIQUE INDEX certificate_attachments_one_official
  ON certificate_attachments (revision_id) WHERE status = 'OFFICIAL';
-- Une seule demande de données en cours par certificat (création / renouvellement / correction)
CREATE UNIQUE INDEX certificate_requests_one_open_data
  ON certificate_approval_requests (certificate_id)
  WHERE status IN ('DRAFT', 'PENDING_APPROVAL', 'RETURNED') AND kind <> 'ATTACHMENT';
-- Une seule demande de pièce jointe en cours par certificat
CREATE UNIQUE INDEX certificate_requests_one_open_attachment
  ON certificate_approval_requests (certificate_id)
  WHERE status IN ('DRAFT', 'PENDING_APPROVAL', 'RETURNED') AND kind = 'ATTACHMENT';
-- Un seul suivi de renouvellement actif
CREATE UNIQUE INDEX certificate_renewal_tasks_one_active
  ON certificate_renewal_tasks (certificate_id) WHERE status <> 'COMPLETED';

-- Un seul département principal par utilisateur (ADM-024)
CREATE UNIQUE INDEX department_memberships_one_primary
  ON department_memberships (user_id) WHERE is_primary;

-- CSO : une seule version publiée et une seule version en cours par document (CSO-007)
CREATE UNIQUE INDEX cso_versions_one_published
  ON cso_versions (document_id) WHERE status = 'PUBLISHED';
CREATE UNIQUE INDEX cso_versions_one_in_flight
  ON cso_versions (document_id) WHERE status IN ('DRAFT', 'PENDING_APPROVAL', 'RETURNED');
-- Noms de dossiers uniques parmi les dossiers actifs d'un même parent
CREATE UNIQUE INDEX cso_folders_unique_active_name
  ON cso_folders (library_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX cso_reference_changes_one_pending
  ON cso_reference_change_requests (document_id) WHERE status = 'PENDING_APPROVAL';

-- Un marin ne peut être embarqué que sur un seul navire à la fois
CREATE UNIQUE INDEX crew_assignments_one_onboard
  ON crew_assignments (member_id) WHERE status = 'ONBOARD';

-- Charter Party : une seule version opposable ; instructions : une seule émise
CREATE UNIQUE INDEX cp_versions_one_current
  ON cp_versions (charter_party_id) WHERE status = 'APPROVED' AND superseded_at IS NULL;
CREATE UNIQUE INDEX voyage_instructions_one_issued
  ON voyage_instructions (voyage_id) WHERE status = 'ISSUED';

-- -----------------------------------------------------------------------------
-- 3. Contraintes CHECK (la base fait autorité, CDC §0.1)
-- -----------------------------------------------------------------------------
ALTER TABLE users
  ADD CONSTRAINT users_username_normalized CHECK (username = lower(username) AND length(username) >= 3),
  ADD CONSTRAINT users_email_normalized CHECK (email IS NULL OR email = lower(email)),
  ADD CONSTRAINT users_failed_logins_positive CHECK (failed_logins >= 0);

ALTER TABLE files
  ADD CONSTRAINT files_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT files_size_positive CHECK (size_bytes >= 0);

ALTER TABLE vessels
  ADD CONSTRAINT vessels_imo_format CHECK (imo_number IS NULL OR imo_number ~ '^[0-9]{7}$'),
  ADD CONSTRAINT vessels_mmsi_format CHECK (mmsi IS NULL OR mmsi ~ '^[0-9]{9}$'),
  ADD CONSTRAINT vessels_flag_format CHECK (flag IS NULL OR flag ~ '^[A-Z]{2}$');

ALTER TABLE members
  ADD CONSTRAINT members_nationality_format CHECK (nationality IS NULL OR nationality ~ '^[A-Z]{2}$');

ALTER TABLE certificates
  ADD CONSTRAINT certificates_subject_consistency CHECK (
    (subject_kind = 'VESSEL' AND vessel_id IS NOT NULL AND member_id IS NULL) OR
    (subject_kind = 'MEMBER' AND member_id IS NOT NULL AND vessel_id IS NULL));

-- UNKNOWN ≠ UNLIMITED ≠ DATED (ADM-061/062)
ALTER TABLE certificate_revisions
  ADD CONSTRAINT certificate_revisions_expiry_consistency CHECK (
    (expiry_kind = 'DATED' AND expiry_on IS NOT NULL) OR (expiry_kind <> 'DATED' AND expiry_on IS NULL));
ALTER TABLE certificate_request_versions
  ADD CONSTRAINT certificate_request_versions_expiry_consistency CHECK (
    (expiry_kind = 'DATED' AND expiry_on IS NOT NULL) OR (expiry_kind <> 'DATED' AND expiry_on IS NULL));

ALTER TABLE reminder_policies
  ADD CONSTRAINT reminder_policies_thresholds_positive CHECK (0 < ALL (thresholds_days));

ALTER TABLE cso_acl_entries
  ADD CONSTRAINT cso_acl_entries_single_target CHECK (num_nonnulls(folder_id, document_id) = 1);
ALTER TABLE cso_shares
  ADD CONSTRAINT cso_shares_single_recipient CHECK (num_nonnulls(recipient_user_id, recipient_department_id) = 1);

ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_currency_iso CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
ALTER TABLE quotations
  ADD CONSTRAINT quotations_currency_iso CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT purchase_orders_amounts_positive CHECK (subtotal >= 0 AND total_amount >= 0);
ALTER TABLE invoices
  ADD CONSTRAINT invoices_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT invoices_amount_positive CHECK (amount >= 0 AND tax_amount >= 0);

ALTER TABLE pr_lines
  ADD CONSTRAINT pr_lines_qty_positive CHECK (quantity_requested > 0 AND quantity_cancelled >= 0),
  ADD CONSTRAINT pr_lines_qty_approved_positive CHECK (quantity_approved IS NULL OR quantity_approved >= 0);
ALTER TABLE pr_revision_lines
  ADD CONSTRAINT pr_revision_lines_qty_positive CHECK (quantity >= 0);
ALTER TABLE rfq_lines
  ADD CONSTRAINT rfq_lines_qty_positive CHECK (quantity > 0);
ALTER TABLE quotation_lines
  ADD CONSTRAINT quotation_lines_values_positive CHECK (
    (unit_price IS NULL OR unit_price >= 0) AND (quantity_offered IS NULL OR quantity_offered >= 0));
ALTER TABLE po_lines
  ADD CONSTRAINT po_lines_qty_positive CHECK (quantity_ordered > 0 AND quantity_cancelled >= 0 AND unit_price >= 0);
ALTER TABLE po_line_allocations
  ADD CONSTRAINT po_line_allocations_qty_positive CHECK (quantity > 0);
ALTER TABLE delivery_note_lines
  ADD CONSTRAINT delivery_note_lines_qty_positive CHECK (quantity_on_note >= 0);
-- Reçu physique = accepté + rejeté ; jamais négatif
ALTER TABLE receipt_lines
  ADD CONSTRAINT receipt_lines_qty_consistency CHECK (
    qty_received >= 0 AND qty_accepted >= 0 AND qty_rejected >= 0 AND qty_accepted + qty_rejected = qty_received);
ALTER TABLE variances
  ADD CONSTRAINT variances_qty_positive CHECK (quantity > 0);

ALTER TABLE voyages
  ADD CONSTRAINT voyages_laycan_order CHECK (laycan_from IS NULL OR laycan_to IS NULL OR laycan_from <= laycan_to);
ALTER TABLE cargos
  ADD CONSTRAINT cargos_qty_order CHECK (qty_min_mt IS NULL OR qty_max_mt IS NULL OR qty_min_mt <= qty_max_mt),
  ADD CONSTRAINT cargos_qty_positive CHECK (
    (qty_min_mt IS NULL OR qty_min_mt >= 0) AND (qty_max_mt IS NULL OR qty_max_mt >= 0) AND
    (qty_actual_mt IS NULL OR qty_actual_mt >= 0));

-- Noon Report : lat [-90;90], long [-180;180], valeurs non négatives (CDC §8.3)
ALTER TABLE noon_reports
  ADD CONSTRAINT noon_reports_latitude_range CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT noon_reports_longitude_range CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  ADD CONSTRAINT noon_reports_course_range CHECK (course_deg IS NULL OR (course_deg >= 0 AND course_deg < 360)),
  ADD CONSTRAINT noon_reports_beaufort_range CHECK (wind_force_beaufort IS NULL OR wind_force_beaufort BETWEEN 0 AND 12),
  ADD CONSTRAINT noon_reports_utc_offset_range CHECK (utc_offset_minutes BETWEEN -720 AND 840),
  ADD CONSTRAINT noon_reports_non_negative CHECK (
    coalesce(speed_knots, 0) >= 0 AND coalesce(distance_since_last_nm, 0) >= 0 AND
    coalesce(distance_remaining_nm, 0) >= 0 AND coalesce(me_rpm, 0) >= 0 AND
    coalesce(fo_consumption_mt, 0) >= 0 AND coalesce(do_consumption_mt, 0) >= 0 AND
    coalesce(lube_oil_consumption_l, 0) >= 0 AND coalesce(running_hours, 0) BETWEEN 0 AND 48 AND
    coalesce(fo_rob_mt, 0) >= 0 AND coalesce(do_rob_mt, 0) >= 0 AND coalesce(lo_rob_l, 0) >= 0 AND
    coalesce(ballast_water_m3, 0) >= 0 AND coalesce(cargo_quantity_mt, 0) >= 0 AND
    coalesce(wind_speed_knots, 0) >= 0 AND coalesce(swell_height_m, 0) >= 0);

-- -----------------------------------------------------------------------------
-- 4. Recherche approchée (pg_trgm) sur métadonnées — filtrage ACL appliqué côté API
-- -----------------------------------------------------------------------------
CREATE INDEX members_fullname_trgm ON members USING gin ((lower(last_name || ' ' || first_name)) gin_trgm_ops);
CREATE INDEX vessels_name_trgm ON vessels USING gin (lower(name) gin_trgm_ops);
CREATE INDEX suppliers_name_trgm ON suppliers USING gin (lower(name) gin_trgm_ops);
CREATE INDEX cso_documents_title_trgm ON cso_documents USING gin (lower(title) gin_trgm_ops);
CREATE INDEX pr_lines_designation_trgm ON pr_lines USING gin (lower(designation) gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- 5. Vue de rapprochement BC / BL / reçu physique (CDC §6.7 — PUR-04)
--    qty_remaining = max(0, ordered - cancelled - accepted)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_po_line_balance AS
SELECT
  pl.id                                   AS po_line_id,
  pl.po_id,
  pl.line_no,
  pl.designation,
  pl.unit,
  pl.quantity_ordered,
  pl.quantity_cancelled,
  coalesce(dn.qty_on_notes, 0)            AS qty_on_delivery_notes,
  coalesce(rc.qty_received, 0)            AS qty_physically_received,
  coalesce(rc.qty_accepted, 0)            AS qty_accepted,
  coalesce(rc.qty_rejected, 0)            AS qty_rejected,
  greatest(0, pl.quantity_ordered - pl.quantity_cancelled - coalesce(rc.qty_accepted, 0)) AS qty_remaining,
  coalesce(dn.qty_on_notes, 0) - coalesce(rc.qty_received, 0) AS delta_note_vs_received,
  pl.quantity_ordered - coalesce(dn.qty_on_notes, 0)          AS delta_ordered_vs_note
FROM po_lines pl
LEFT JOIN (
  SELECT dnl.po_line_id, sum(dnl.quantity_on_note) AS qty_on_notes
  FROM delivery_note_lines dnl
  JOIN delivery_notes d ON d.id = dnl.delivery_note_id AND d.status <> 'CANCELLED'
  GROUP BY dnl.po_line_id
) dn ON dn.po_line_id = pl.id
LEFT JOIN (
  SELECT rl.po_line_id, sum(rl.qty_received) AS qty_received, sum(rl.qty_accepted) AS qty_accepted,
         sum(rl.qty_rejected) AS qty_rejected
  FROM receipt_lines rl
  JOIN goods_receipts g ON g.id = rl.receipt_id AND g.status <> 'DRAFT'
  GROUP BY rl.po_line_id
) rc ON rc.po_line_id = pl.id;

COMMENT ON VIEW v_po_line_balance IS
  'Rapprochement par ligne de BC : Ordered (BC) / Delivery Note (BL) / Physically Received — un BL n''est pas une preuve de réception';
COMMENT ON TABLE audit_events IS 'Journal d''audit append-only (trigger). Lecture filtrée par permission audit.view.<module> et scope navire.';
COMMENT ON TABLE files IS 'Métadonnées des blobs MinIO (buckets privés). Aucune URL publique : accès via URL signée courte après contrôle de droits.';
