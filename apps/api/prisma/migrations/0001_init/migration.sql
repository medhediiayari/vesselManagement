-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('PDF', 'EXCEL', 'IMAGE', 'ZIP', 'CSV', 'WORD', 'OTHER');

-- CreateEnum
CREATE TYPE "FileScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "FileContext" AS ENUM ('CERTIFICATE', 'CSO_DOCUMENT', 'VESSEL_PHOTO', 'VESSEL_ATTACHMENT', 'MEMBER_PHOTO', 'MEMBER_DOCUMENT', 'PURCHASING', 'VOYAGE', 'CHARTER_PARTY', 'NOON_REPORT', 'IMPORT_SOURCE', 'EXPORT', 'GENERATED');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV', 'XLSX', 'PDF', 'ZIP');

-- CreateEnum
CREATE TYPE "ImportJobKind" AS ENUM ('MEMBERS', 'CSO_DOCUMENTS');

-- CreateEnum
CREATE TYPE "ImportPhase" AS ENUM ('UPLOADED', 'MAPPING', 'PREVIEW_READY', 'COMMITTING', 'COMMITTED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'VALID', 'INVALID', 'DUPLICATE_SUSPECTED', 'APPLIED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowDecision" AS ENUM ('PENDING', 'CREATE', 'UPDATE', 'IGNORE', 'CORRECT', 'CREATE_INDEPENDENT', 'SUBMIT_NEW_VERSION');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "VesselScopeMode" AS ENUM ('ALL_FLEET', 'SELECTED');

-- CreateEnum
CREATE TYPE "OverrideEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "DepartmentStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "VesselStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'LAID_UP', 'SOLD');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ON_BOARD', 'AVAILABLE', 'ON_LEAVE', 'PLANNED_JOIN', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CrewDepartment" AS ENUM ('DECK', 'ENGINE', 'CATERING', 'OTHER');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN');

-- CreateEnum
CREATE TYPE "CrewAssignmentStatus" AS ENUM ('PLANNED', 'ONBOARD', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CertificateSubjectKind" AS ENUM ('VESSEL', 'MEMBER');

-- CreateEnum
CREATE TYPE "ExpiryKind" AS ENUM ('DATED', 'UNLIMITED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ReminderFrequency" AS ENUM ('AT_THRESHOLDS', 'DAILY', 'WEEKLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PrincipalType" AS ENUM ('USER', 'ROLE', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "RenewalStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "RevisionLifecycle" AS ENUM ('CURRENT', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CertificateRequestKind" AS ENUM ('CREATE', 'RENEWAL', 'CORRECTION', 'ATTACHMENT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'RETURNED', 'REJECTED', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalDecisionKind" AS ENUM ('APPROVE', 'REJECT', 'RETURN');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING_APPROVAL', 'OFFICIAL', 'ARCHIVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CsoLibraryKind" AS ENUM ('CENTRAL', 'VESSEL');

-- CreateEnum
CREATE TYPE "CsoItemStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AclEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "CategoryScope" AS ENUM ('FLEET', 'VESSEL');

-- CreateEnum
CREATE TYPE "ReferenceMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "CsoDocumentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CsoVersionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'RETURNED', 'REJECTED', 'PUBLISHED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PrStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'REVISED', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "PrPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "LineStatus" AS ENUM ('OPEN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PrRevisionKind" AS ENUM ('COUNTER_PR', 'REVISION');

-- CreateEnum
CREATE TYPE "PrRevisionStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'CORRECTION_REQUESTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RevisionLineAction" AS ENUM ('KEEP', 'CHANGE', 'ADD', 'REMOVE');

-- CreateEnum
CREATE TYPE "PurchasingEntityType" AS ENUM ('PR', 'RFQ', 'QUOTATION', 'PURCHASE_ORDER', 'DELIVERY_NOTE', 'GOODS_RECEIPT', 'VARIANCE', 'INVOICE');

-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('DRAFT', 'ISSUED', 'QUOTED', 'EVALUATED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RfqSupplierStatus" AS ENUM ('PENDING', 'SENT', 'SEND_FAILED', 'DECLINED', 'QUOTED');

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('RECEIVED', 'SELECTED', 'PARTIALLY_SELECTED', 'NOT_SELECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('COMPLIANT', 'ALTERNATIVE', 'NON_COMPLIANT');

-- CreateEnum
CREATE TYPE "PoStatus" AS ENUM ('DRAFT', 'APPROVAL_PENDING', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryNoteStatus" AS ENUM ('RECORDED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'VALIDATED');

-- CreateEnum
CREATE TYPE "ItemCondition" AS ENUM ('GOOD', 'DAMAGED', 'WRONG_ITEM');

-- CreateEnum
CREATE TYPE "VarianceType" AS ENUM ('SHORT_SHIPPED', 'SHORT_RECEIVED', 'SURPLUS', 'DAMAGED', 'WRONG_REFERENCE', 'REJECTED');

-- CreateEnum
CREATE TYPE "VarianceStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('RECEIVED', 'UNDER_REVIEW', 'MATCHED', 'DISPUTED', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VoyageStatus" AS ENUM ('DRAFT', 'PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PortCallType" AS ENUM ('LOAD', 'DISCHARGE', 'INTERMEDIATE', 'BUNKERING');

-- CreateEnum
CREATE TYPE "CharterPartyType" AS ENUM ('VOYAGE', 'TIME', 'BAREBOAT', 'COA', 'OTHER');

-- CreateEnum
CREATE TYPE "CpStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CpVersionKind" AS ENUM ('ORIGINAL', 'ADDENDUM', 'REVISION');

-- CreateEnum
CREATE TYPE "InstructionStatus" AS ENUM ('DRAFT', 'ISSUED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NoticeStatus" AS ENUM ('PLANNED', 'DRAFTED', 'VALIDATED', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NoonReportType" AS ENUM ('NOON', 'MIDNIGHT', 'ARRIVAL', 'DEPARTURE');

-- CreateEnum
CREATE TYPE "NoonStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ACKNOWLEDGED', 'CORRECTION_REQUESTED', 'CORRECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConsumptionBasis" AS ENUM ('SINCE_LAST_REPORT', 'DAILY_24H');

-- CreateEnum
CREATE TYPE "LoadingCondition" AS ENUM ('LADEN', 'BALLAST', 'PART_LADEN', 'LOADING', 'DISCHARGING');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "key" VARCHAR(120) NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "bucket" VARCHAR(63) NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "extension" VARCHAR(16) NOT NULL,
    "mime_type" VARCHAR(127) NOT NULL,
    "kind" "FileKind" NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "scan_status" "FileScanStatus" NOT NULL DEFAULT 'PENDING',
    "scan_detail" VARCHAR(500),
    "scanned_at" TIMESTAMPTZ(3),
    "context" "FileContext" NOT NULL,
    "vessel_id" UUID,
    "owner_type" VARCHAR(64),
    "owner_id" UUID,
    "attached_at" TIMESTAMPTZ(3),
    "width" INTEGER,
    "height" INTEGER,
    "page_count" INTEGER,
    "thumbnail_key" VARCHAR(512),
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retention_until" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_label" VARCHAR(200),
    "action" VARCHAR(100) NOT NULL,
    "module" VARCHAR(40) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" VARCHAR(64),
    "vessel_id" UUID,
    "result" "AuditResult" NOT NULL DEFAULT 'SUCCESS',
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(400),
    "session_id" UUID,
    "request_id" VARCHAR(64),

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "user_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "route" VARCHAR(200) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "title" VARCHAR(250) NOT NULL,
    "body" TEXT,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "module" VARCHAR(40) NOT NULL,
    "entity_type" VARCHAR(60),
    "entity_id" UUID,
    "vessel_id" UUID,
    "link" VARCHAR(500),
    "is_mandatory" BOOLEAN NOT NULL DEFAULT false,
    "dedupe_key" VARCHAR(200),
    "read_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID,
    "to_address" VARCHAR(320) NOT NULL,
    "subject" VARCHAR(300) NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "provider_message_id" VARCHAR(300),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_delivery_events" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "event" VARCHAR(40) NOT NULL,
    "detail" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "recipients" JSONB NOT NULL,
    "channels" TEXT[] DEFAULT ARRAY['APP', 'EMAIL']::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "aggregate_type" VARCHAR(60) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" UUID NOT NULL,
    "job_name" VARCHAR(80) NOT NULL,
    "status" "JobStatus" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "detail" JSONB,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "module" VARCHAR(40) NOT NULL,
    "resource" VARCHAR(60) NOT NULL,
    "params" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "file_id" UUID,
    "item_count" INTEGER,
    "excluded_count" INTEGER,
    "error" VARCHAR(1000),
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "kind" "ImportJobKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "phase" "ImportPhase" NOT NULL DEFAULT 'UPLOADED',
    "source_file_id" UUID NOT NULL,
    "metadata_file_id" UUID,
    "vessel_id" UUID,
    "target_folder_id" UUID,
    "options" JSONB NOT NULL DEFAULT '{}',
    "summary" JSONB,
    "error_message" VARCHAR(1000),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "sheet_name" VARCHAR(120) NOT NULL DEFAULT '',
    "row_number" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB,
    "errors" JSONB,
    "warnings" JSONB,
    "duplicate_candidates" JSONB,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "decision" "ImportRowDecision" NOT NULL DEFAULT 'PENDING',
    "decision_target_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "applied_entity_id" UUID,
    "applied_at" TIMESTAMPTZ(3),
    "error_message" VARCHAR(1000),

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "email" VARCHAR(320),
    "email_verified_at" TIMESTAMPTZ(3),
    "display_name" VARCHAR(200) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "password_changed_at" TIMESTAMPTZ(3),
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "vessel_scope" "VesselScopeMode" NOT NULL DEFAULT 'SELECTED',
    "member_id" UUID,
    "job_title" VARCHAR(120),
    "locale" VARCHAR(8) NOT NULL DEFAULT 'fr',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deactivated_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "device_label" VARCHAR(200),
    "user_agent" VARCHAR(400),
    "ip" VARCHAR(64),
    "fingerprint" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,
    "revoked_reason" VARCHAR(200),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" VARCHAR(80) NOT NULL,
    "module" VARCHAR(40) NOT NULL,
    "label" VARCHAR(250) NOT NULL,
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_key" VARCHAR(80) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "permission_overrides" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permission_key" VARCHAR(80) NOT NULL,
    "effect" "OverrideEffect" NOT NULL,
    "reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_vessel_access" (
    "user_id" UUID NOT NULL,
    "vessel_id" UUID NOT NULL,
    "granted_by_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_vessel_access_pkey" PRIMARY KEY ("user_id","vessel_id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "DepartmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "primary_manager_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_memberships" (
    "user_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_memberships_pkey" PRIMARY KEY ("user_id","department_id")
);

-- CreateTable
CREATE TABLE "department_deputies" (
    "department_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "department_deputies_pkey" PRIMARY KEY ("department_id","user_id")
);

-- CreateTable
CREATE TABLE "vessels" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "imo_number" VARCHAR(7),
    "mmsi" VARCHAR(9),
    "call_sign" VARCHAR(16),
    "flag" VARCHAR(2),
    "port_of_registry" VARCHAR(120),
    "vessel_type" VARCHAR(80),
    "status" "VesselStatus" NOT NULL DEFAULT 'ACTIVE',
    "manager_name" VARCHAR(200),
    "owner_name" VARCHAR(200),
    "class_society" VARCHAR(120),
    "year_built" INTEGER,
    "builder" VARCHAR(200),
    "gross_tonnage" DECIMAL(12,2),
    "net_tonnage" DECIMAL(12,2),
    "deadweight" DECIMAL(12,2),
    "length_overall" DECIMAL(8,2),
    "beam" DECIMAL(8,2),
    "summer_draft" DECIMAL(6,2),
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "contact_email" VARCHAR(320),
    "contact_phone" VARCHAR(64),
    "photo_file_id" UUID,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vessels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vessel_attachments" (
    "id" UUID NOT NULL,
    "vessel_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "vessel_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranks" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "crew_department" "CrewDepartment" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ranks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "amc_ref" VARCHAR(32),
    "first_name" VARCHAR(120) NOT NULL,
    "last_name" VARCHAR(120) NOT NULL,
    "birth_date" DATE,
    "birth_place" VARCHAR(120),
    "nationality" VARCHAR(2),
    "gender" VARCHAR(16),
    "email" VARCHAR(320),
    "phone" VARCHAR(64),
    "address" VARCHAR(500),
    "emergency_contact_name" VARCHAR(200),
    "emergency_contact_phone" VARCHAR(64),
    "passport_number" VARCHAR(32),
    "passport_country" VARCHAR(2),
    "passport_expiry" DATE,
    "seaman_book_number" VARCHAR(32),
    "seaman_book_expiry" DATE,
    "rank" VARCHAR(120),
    "crew_department" "CrewDepartment",
    "status" "MemberStatus" NOT NULL DEFAULT 'AVAILABLE',
    "department_id" UUID,
    "photo_file_id" UUID,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_documents" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "member_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_field_sections" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_field_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_field_definitions" (
    "id" UUID NOT NULL,
    "section_id" UUID,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "view_permission" VARCHAR(80),
    "edit_permission" VARCHAR(80),
    "self_editable" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_field_values" (
    "member_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "member_field_values_pkey" PRIMARY KEY ("member_id","field_id")
);

-- CreateTable
CREATE TABLE "crew_assignments" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "vessel_id" UUID NOT NULL,
    "rank" VARCHAR(120) NOT NULL,
    "position" VARCHAR(120),
    "status" "CrewAssignmentStatus" NOT NULL DEFAULT 'PLANNED',
    "planned_join_date" DATE,
    "actual_join_date" DATE,
    "planned_sign_off_date" DATE,
    "actual_sign_off_date" DATE,
    "join_port" VARCHAR(120),
    "sign_off_port" VARCHAR(120),
    "voyage_id" UUID,
    "relieves_assignment_id" UUID,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crew_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_policies" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "thresholds_days" INTEGER[],
    "frequency" "ReminderFrequency" NOT NULL DEFAULT 'AT_THRESHOLDS',
    "custom_interval_days" INTEGER,
    "post_expiry_interval_days" INTEGER,
    "post_expiry_max_reminders" INTEGER,
    "unknown_expiry_interval_days" INTEGER,
    "missing_document_interval_days" INTEGER,
    "approval_overdue_hours" INTEGER,
    "escalation_role_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reminder_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_policy_recipients" (
    "id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "principal_type" "PrincipalType" NOT NULL,
    "principal_id" UUID NOT NULL,

    CONSTRAINT "reminder_policy_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_types" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "subject_kind" "CertificateSubjectKind" NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "description" TEXT,
    "default_validity_months" INTEGER,
    "requires_document" BOOLEAN NOT NULL DEFAULT true,
    "allow_multiple" BOOLEAN NOT NULL DEFAULT false,
    "reminder_policy_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "certificate_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_type_validators" (
    "id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "principal_type" "PrincipalType" NOT NULL,
    "principal_id" UUID NOT NULL,

    CONSTRAINT "certificate_type_validators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" UUID NOT NULL,
    "subject_kind" "CertificateSubjectKind" NOT NULL,
    "vessel_id" UUID,
    "member_id" UUID,
    "type_id" UUID NOT NULL,
    "current_revision_id" UUID,
    "current_number" VARCHAR(120),
    "current_expiry_kind" "ExpiryKind",
    "current_expiry_on" DATE,
    "document_missing" BOOLEAN NOT NULL DEFAULT true,
    "renewal_status" "RenewalStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "renewal_owner_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_id" UUID,
    "archive_reason" VARCHAR(500),

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_revisions" (
    "id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "certificate_number" VARCHAR(120),
    "issuer" VARCHAR(200),
    "authority" VARCHAR(200),
    "country" VARCHAR(2),
    "place_of_issue" VARCHAR(120),
    "issued_on" DATE,
    "valid_from" DATE,
    "expiry_kind" "ExpiryKind" NOT NULL,
    "expiry_on" DATE,
    "remarks" TEXT,
    "lifecycle" "RevisionLifecycle" NOT NULL DEFAULT 'CURRENT',
    "approved_request_id" UUID NOT NULL,
    "approved_by_id" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_approval_requests" (
    "id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "kind" "CertificateRequestKind" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "requested_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_comment" TEXT,
    "cancel_reason" TEXT,
    "duplicated_from_id" UUID,
    "attachment_id" UUID,
    "last_reminder_at" TIMESTAMPTZ(3),
    "escalated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "certificate_approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_request_versions" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "certificate_number" VARCHAR(120),
    "issuer" VARCHAR(200),
    "authority" VARCHAR(200),
    "country" VARCHAR(2),
    "place_of_issue" VARCHAR(120),
    "issued_on" DATE,
    "valid_from" DATE,
    "expiry_kind" "ExpiryKind" NOT NULL,
    "expiry_on" DATE,
    "remarks" TEXT,
    "file_id" UUID,
    "change_note" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_request_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_approval_decisions" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "decider_id" UUID NOT NULL,
    "decision" "ApprovalDecisionKind" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_approval_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_attachments" (
    "id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "revision_id" UUID,
    "file_id" UUID NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "uploaded_by_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "certificate_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_renewal_tasks" (
    "id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "owner_id" UUID,
    "status" "RenewalStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "due_on" DATE,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "certificate_renewal_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_comments" (
    "id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_libraries" (
    "id" UUID NOT NULL,
    "kind" "CsoLibraryKind" NOT NULL,
    "vessel_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cso_libraries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_folders" (
    "id" UUID NOT NULL,
    "library_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "path" VARCHAR(4000) NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "inherit_acl" BOOLEAN NOT NULL DEFAULT true,
    "status" "CsoItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cso_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_acl_entries" (
    "id" UUID NOT NULL,
    "folder_id" UUID,
    "document_id" UUID,
    "principal_type" "PrincipalType" NOT NULL,
    "principal_id" UUID NOT NULL,
    "actions" TEXT[],
    "effect" "AclEffect" NOT NULL DEFAULT 'ALLOW',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cso_acl_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_folder_validators" (
    "id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "principal_type" "PrincipalType" NOT NULL,
    "principal_id" UUID NOT NULL,

    CONSTRAINT "cso_folder_validators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_categories" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "scope" "CategoryScope" NOT NULL DEFAULT 'FLEET',
    "vessel_id" UUID,
    "reference_mode" "ReferenceMode" NOT NULL DEFAULT 'AUTO',
    "reference_format" VARCHAR(120),
    "required_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cso_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_field_definitions" (
    "id" UUID NOT NULL,
    "category_id" UUID,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "is_confidential" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cso_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_field_acl" (
    "id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "principal_type" "PrincipalType" NOT NULL,
    "principal_id" UUID NOT NULL,
    "can_view" BOOLEAN NOT NULL DEFAULT true,
    "can_edit" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "cso_field_acl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_field_values" (
    "document_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cso_field_values_pkey" PRIMARY KEY ("document_id","field_id")
);

-- CreateTable
CREATE TABLE "cso_documents" (
    "id" UUID NOT NULL,
    "library_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "vessel_id" UUID,
    "category_id" UUID,
    "reference" VARCHAR(120),
    "title" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "author_id" UUID NOT NULL,
    "status" "CsoDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version_id" UUID,
    "next_review_on" DATE,
    "expiry_on" DATE,
    "inherit_acl" BOOLEAN NOT NULL DEFAULT true,
    "copied_from_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    -- Colonne FTS générée (non représentable dans Prisma : déclarée Unsupported("tsvector"))
    "search_tsv" tsvector GENERATED ALWAYS AS (
        to_tsvector('simple'::regconfig,
            coalesce("reference", '') || ' ' || coalesce("title", '') || ' ' || coalesce("description", ''))
    ) STORED,

    CONSTRAINT "cso_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_versions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "file_id" UUID NOT NULL,
    "status" "CsoVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "change_note" VARCHAR(1000),
    "is_restoration" BOOLEAN NOT NULL DEFAULT false,
    "lock_version" INTEGER NOT NULL DEFAULT 1,
    "submitted_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_comment" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cso_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_reference_change_requests" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "old_reference" VARCHAR(120),
    "new_reference" VARCHAR(120) NOT NULL,
    "reason" VARCHAR(500),
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cso_reference_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cso_shares" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "shared_by_id" UUID NOT NULL,
    "recipient_user_id" UUID,
    "recipient_department_id" UUID,
    "message" VARCHAR(1000),
    "allow_download" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,

    CONSTRAINT "cso_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "legal_name" VARCHAR(250),
    "email" VARCHAR(320),
    "phone" VARCHAR(64),
    "address" VARCHAR(500),
    "country" VARCHAR(2),
    "currency" CHAR(3),
    "payment_terms" VARCHAR(250),
    "tax_id" VARCHAR(64),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_contacts" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(320),
    "phone" VARCHAR(64),
    "role" VARCHAR(120),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "supplier_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requests" (
    "id" UUID NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "vessel_id" UUID NOT NULL,
    "department_id" UUID,
    "requester_id" UUID NOT NULL,
    "request_date" DATE NOT NULL,
    "category" VARCHAR(120) NOT NULL,
    "priority" "PrPriority" NOT NULL DEFAULT 'NORMAL',
    "needed_by" DATE,
    "subject" VARCHAR(300) NOT NULL,
    "comment" TEXT,
    "form_ref" VARCHAR(80),
    "status" "PrStatus" NOT NULL DEFAULT 'DRAFT',
    "review_circuit" JSONB,
    "current_revision_no" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "lock_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_lines" (
    "id" UUID NOT NULL,
    "pr_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "designation" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(200),
    "quantity_requested" DECIMAL(18,3) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "rob" VARCHAR(64),
    "remarks" VARCHAR(1000),
    "catalog_item_id" UUID,
    "added_by_revision_id" UUID,
    "quantity_approved" DECIMAL(18,3),
    "quantity_cancelled" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "status" "LineStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_revisions" (
    "id" UUID NOT NULL,
    "pr_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "kind" "PrRevisionKind" NOT NULL DEFAULT 'COUNTER_PR',
    "status" "PrRevisionStatus" NOT NULL DEFAULT 'PROPOSED',
    "justification" TEXT,
    "proposed_by_id" UUID NOT NULL,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_comment" TEXT,

    CONSTRAINT "pr_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_revision_lines" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "pr_line_id" UUID,
    "action" "RevisionLineAction" NOT NULL,
    "designation" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(200),
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "remarks" VARCHAR(1000),

    CONSTRAINT "pr_revision_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_comments" (
    "id" UUID NOT NULL,
    "pr_id" UUID NOT NULL,
    "revision_id" UUID,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchasing_attachments" (
    "id" UUID NOT NULL,
    "entity_type" "PurchasingEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "vessel_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "title" VARCHAR(200),
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchasing_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfqs" (
    "id" UUID NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "vessel_id" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "status" "RfqStatus" NOT NULL DEFAULT 'DRAFT',
    "deadline" TIMESTAMPTZ(3),
    "delivery_port" VARCHAR(120),
    "delivery_terms" VARCHAR(500),
    "notes" TEXT,
    "issued_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_lines" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "pr_line_id" UUID,
    "line_no" INTEGER NOT NULL,
    "designation" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(200),
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "remarks" VARCHAR(1000),

    CONSTRAINT "rfq_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_suppliers" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "status" "RfqSupplierStatus" NOT NULL DEFAULT 'PENDING',
    "sent_to" VARCHAR(320),
    "sent_at" TIMESTAMPTZ(3),
    "send_error" VARCHAR(1000),

    CONSTRAINT "rfq_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "reference" VARCHAR(120),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" CHAR(3) NOT NULL,
    "valid_until" DATE,
    "lead_time_days" INTEGER,
    "incoterm" VARCHAR(16),
    "delivery_terms" VARCHAR(500),
    "payment_terms" VARCHAR(250),
    "freight_amount" DECIMAL(18,2),
    "tax_amount" DECIMAL(18,2),
    "discount_amount" DECIMAL(18,2),
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "comments" TEXT,
    "file_id" UUID,
    "status" "QuotationStatus" NOT NULL DEFAULT 'RECEIVED',
    "evaluation_note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "rfq_line_id" UUID NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "quantity_offered" DECIMAL(18,3),
    "unit" VARCHAR(32),
    "unit_price" DECIMAL(18,4),
    "line_total" DECIMAL(18,2),
    "lead_time_days" INTEGER,
    "compliance" "ComplianceStatus" NOT NULL DEFAULT 'COMPLIANT',
    "remarks" VARCHAR(1000),

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_selections" (
    "id" UUID NOT NULL,
    "quotation_line_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "justification" TEXT,
    "selected_by_id" UUID NOT NULL,
    "selected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(3),

    CONSTRAINT "quotation_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_thresholds" (
    "id" UUID NOT NULL,
    "scope" VARCHAR(40) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "requires_second_approval" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "vessel_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "quotation_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "status" "PoStatus" NOT NULL DEFAULT 'DRAFT',
    "order_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_delivery_date" DATE,
    "delivery_port" VARCHAR(120),
    "delivery_terms" VARCHAR(500),
    "payment_terms" VARCHAR(250),
    "notes" TEXT,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "freight_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "revision_no" INTEGER NOT NULL DEFAULT 0,
    "requires_second_approval" BOOLEAN NOT NULL DEFAULT false,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "second_approved_by_id" UUID,
    "second_approved_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "sent_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "pdf_file_id" UUID,
    "lock_version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_lines" (
    "id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "designation" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(200),
    "quantity_ordered" DECIMAL(18,3) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "quotation_line_id" UUID,
    "quantity_cancelled" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "status" "LineStatus" NOT NULL DEFAULT 'OPEN',
    "remarks" VARCHAR(1000),

    CONSTRAINT "po_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_line_allocations" (
    "id" UUID NOT NULL,
    "po_line_id" UUID NOT NULL,
    "pr_line_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "over_allocation_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_line_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_revisions" (
    "id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "pdf_file_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_dispatches" (
    "id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "recipient" VARCHAR(320) NOT NULL,
    "recipient_kind" VARCHAR(32) NOT NULL,
    "channel" VARCHAR(16) NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'PENDING',
    "file_id" UUID,
    "error" VARCHAR(1000),
    "sent_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_notes" (
    "id" UUID NOT NULL,
    "number" VARCHAR(80) NOT NULL,
    "supplier_id" UUID NOT NULL,
    "vessel_id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "delivery_date" DATE NOT NULL,
    "file_id" UUID,
    "status" "DeliveryNoteStatus" NOT NULL DEFAULT 'RECORDED',
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_note_lines" (
    "id" UUID NOT NULL,
    "delivery_note_id" UUID NOT NULL,
    "po_line_id" UUID NOT NULL,
    "quantity_on_note" DECIMAL(18,3) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,

    CONSTRAINT "delivery_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "vessel_id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "delivery_note_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "received_by_id" UUID NOT NULL,
    "responsible_name" VARCHAR(200),
    "status" "ReceiptStatus" NOT NULL DEFAULT 'CONFIRMED',
    "validated_by_id" UUID,
    "validated_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_lines" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "po_line_id" UUID NOT NULL,
    "delivery_note_line_id" UUID,
    "qty_received" DECIMAL(18,3) NOT NULL,
    "qty_accepted" DECIMAL(18,3) NOT NULL,
    "qty_rejected" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "condition" "ItemCondition" NOT NULL DEFAULT 'GOOD',
    "remarks" VARCHAR(1000),

    CONSTRAINT "receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variances" (
    "id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "po_line_id" UUID NOT NULL,
    "receipt_id" UUID,
    "type" "VarianceType" NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "description" TEXT,
    "status" "VarianceStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_to_id" UUID,
    "resolution" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "vessel_id" UUID,
    "number" VARCHAR(80) NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "tax_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "file_id" UUID,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'RECEIVED',
    "review_notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_order_links" (
    "invoice_id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "amount" DECIMAL(18,2),

    CONSTRAINT "invoice_order_links_pkey" PRIMARY KEY ("invoice_id","po_id")
);

-- CreateTable
CREATE TABLE "voyages" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(40) NOT NULL,
    "vessel_id" UUID NOT NULL,
    "status" "VoyageStatus" NOT NULL DEFAULT 'DRAFT',
    "charterer" VARCHAR(200),
    "broker" VARCHAR(200),
    "charter_party_id" UUID,
    "description" TEXT,
    "laycan_from" DATE,
    "laycan_to" DATE,
    "etd" TIMESTAMPTZ(3),
    "eta" TIMESTAMPTZ(3),
    "atd" TIMESTAMPTZ(3),
    "ata" TIMESTAMPTZ(3),
    "notes" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "voyages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyage_agents" (
    "id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "role" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "city" VARCHAR(120),
    "email" VARCHAR(320),
    "phone" VARCHAR(64),
    "address" VARCHAR(500),
    "notes" TEXT,

    CONSTRAINT "voyage_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyage_ports" (
    "id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "PortCallType" NOT NULL,
    "port_name" VARCHAR(120) NOT NULL,
    "country" VARCHAR(2),
    "unlocode" VARCHAR(5),
    "berth" VARCHAR(120),
    "agent_id" UUID,
    "eta" TIMESTAMPTZ(3),
    "ata" TIMESTAMPTZ(3),
    "etd" TIMESTAMPTZ(3),
    "atd" TIMESTAMPTZ(3),
    "cargo_operations" TEXT,
    "notes" TEXT,

    CONSTRAINT "voyage_ports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cargos" (
    "id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "commodity" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "qty_min_mt" DECIMAL(14,3),
    "qty_max_mt" DECIMAL(14,3),
    "qty_actual_mt" DECIMAL(14,3),
    "unit" VARCHAR(16) NOT NULL DEFAULT 'MT',
    "quantity_option" VARCHAR(120),
    "stowage_factor" DECIMAL(10,3),
    "stowage_factor_unit" VARCHAR(32),
    "is_dangerous" BOOLEAN NOT NULL DEFAULT false,
    "documentation" TEXT,
    "notes" TEXT,

    CONSTRAINT "cargos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charter_parties" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(80) NOT NULL,
    "cp_type" "CharterPartyType" NOT NULL,
    "cp_date" DATE,
    "vessel_id" UUID,
    "charterer" VARCHAR(200),
    "owner" VARCHAR(200),
    "broker" VARCHAR(200),
    "signatories" VARCHAR(500),
    "laycan_from" DATE,
    "laycan_to" DATE,
    "load_ports" VARCHAR(500),
    "discharge_ports" VARCHAR(500),
    "cargo_description" TEXT,
    "nor_clause" TEXT,
    "laytime_clause" TEXT,
    "freight_terms" TEXT,
    "demurrage_terms" TEXT,
    "other_clauses" TEXT,
    "status" "CpStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "charter_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cp_versions" (
    "id" UUID NOT NULL,
    "charter_party_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "kind" "CpVersionKind" NOT NULL DEFAULT 'ORIGINAL',
    "file_id" UUID,
    "summary" TEXT,
    "clauses" JSONB,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "submitted_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_comment" TEXT,
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "cp_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cp_acknowledgements" (
    "id" UUID NOT NULL,
    "cp_version_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cp_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyage_instructions" (
    "id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "file_id" UUID,
    "fields" JSONB,
    "notices" TEXT,
    "status" "InstructionStatus" NOT NULL DEFAULT 'DRAFT',
    "issued_by_id" UUID,
    "issued_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voyage_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyage_instruction_acks" (
    "id" UUID NOT NULL,
    "instruction_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ack_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voyage_instruction_acks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyage_tasks" (
    "id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "port_id" UUID,
    "title" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(40) NOT NULL DEFAULT 'CHECKLIST',
    "assignee_id" UUID,
    "due_at" TIMESTAMPTZ(3),
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "evidence_file_id" UUID,
    "comment" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voyage_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyage_notices" (
    "id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "port_id" UUID,
    "kind" VARCHAR(40) NOT NULL,
    "schedule_label" VARCHAR(120),
    "due_at" TIMESTAMPTZ(3),
    "recipients" VARCHAR(1000),
    "draft_body" TEXT,
    "status" "NoticeStatus" NOT NULL DEFAULT 'PLANNED',
    "validated_by_id" UUID,
    "validated_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "sent_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voyage_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nor_records" (
    "id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "port_id" UUID NOT NULL,
    "tendered_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by" VARCHAR(200),
    "remarks" TEXT,
    "file_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nor_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyage_files" (
    "id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voyage_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "noon_reports" (
    "id" UUID NOT NULL,
    "vessel_id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "report_type" "NoonReportType" NOT NULL DEFAULT 'NOON',
    "report_date_utc" TIMESTAMPTZ(3) NOT NULL,
    "utc_offset_minutes" INTEGER NOT NULL DEFAULT 0,
    "reference" VARCHAR(80),
    "master_name" VARCHAR(200),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "wind_direction" VARCHAR(16),
    "wind_force_beaufort" INTEGER,
    "wind_speed_knots" DECIMAL(5,1),
    "weather_conditions" VARCHAR(200),
    "sea_state" VARCHAR(60),
    "swell_direction" VARCHAR(16),
    "swell_height_m" DECIMAL(4,1),
    "visibility" VARCHAR(60),
    "course_deg" DECIMAL(5,1),
    "speed_knots" DECIMAL(5,2),
    "distance_since_last_nm" DECIMAL(8,2),
    "distance_remaining_nm" DECIMAL(8,2),
    "next_port" VARCHAR(120),
    "eta_next_port" TIMESTAMPTZ(3),
    "consumption_basis" "ConsumptionBasis" NOT NULL DEFAULT 'SINCE_LAST_REPORT',
    "me_rpm" DECIMAL(6,1),
    "fo_consumption_mt" DECIMAL(10,3),
    "do_consumption_mt" DECIMAL(10,3),
    "lube_oil_consumption_l" DECIMAL(10,2),
    "running_hours" DECIMAL(5,2),
    "fo_rob_mt" DECIMAL(10,3),
    "do_rob_mt" DECIMAL(10,3),
    "lo_rob_l" DECIMAL(10,2),
    "ballast_water_m3" DECIMAL(10,2),
    "loading_condition" "LoadingCondition",
    "cargo_type" VARCHAR(200),
    "cargo_quantity_mt" DECIMAL(14,3),
    "incidents" TEXT,
    "remarks" TEXT,
    "maintenance_done" TEXT,
    "maintenance_planned" TEXT,
    "deviations" TEXT,
    "additional_notes" TEXT,
    "status" "NoonStatus" NOT NULL DEFAULT 'DRAFT',
    "current_revision_no" INTEGER NOT NULL DEFAULT 0,
    "submitted_by_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "acknowledged_by_id" UUID,
    "acknowledged_at" TIMESTAMPTZ(3),
    "correction_request" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "noon_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "noon_report_revisions" (
    "id" UUID NOT NULL,
    "noon_report_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "reason" VARCHAR(1000),
    "pdf_file_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "noon_report_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "noon_report_attachments" (
    "id" UUID NOT NULL,
    "noon_report_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "noon_report_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_code_key" ON "companies"("code");

-- CreateIndex
CREATE INDEX "files_sha256_idx" ON "files"("sha256");

-- CreateIndex
CREATE INDEX "files_owner_type_owner_id_idx" ON "files"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "files_scan_status_idx" ON "files"("scan_status");

-- CreateIndex
CREATE INDEX "files_uploaded_by_id_created_at_idx" ON "files"("uploaded_by_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_module_occurred_at_idx" ON "audit_events"("module", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_events_vessel_id_occurred_at_idx" ON "audit_events"("vessel_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_actor_id_occurred_at_idx" ON "audit_events"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "email_deliveries_status_created_at_idx" ON "email_deliveries"("status", "created_at");

-- CreateIndex
CREATE INDEX "email_delivery_events_delivery_id_idx" ON "email_delivery_events"("delivery_id");

-- CreateIndex
CREATE INDEX "notification_rules_event_type_is_active_idx" ON "notification_rules"("event_type", "is_active");

-- CreateIndex
CREATE INDEX "outbox_events_processed_at_created_at_idx" ON "outbox_events"("processed_at", "created_at");

-- CreateIndex
CREATE INDEX "job_runs_job_name_started_at_idx" ON "job_runs"("job_name", "started_at" DESC);

-- CreateIndex
CREATE INDEX "export_jobs_requested_by_id_created_at_idx" ON "export_jobs"("requested_by_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_jobs_kind_created_at_idx" ON "import_jobs"("kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_rows_job_id_status_idx" ON "import_rows"("job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_job_id_sheet_name_row_number_key" ON "import_rows"("job_id", "sheet_name", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_member_id_key" ON "users"("member_id");

-- CreateIndex
CREATE INDEX "users_company_id_status_idx" ON "users"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "permission_overrides_user_id_permission_key_key" ON "permission_overrides"("user_id", "permission_key");

-- CreateIndex
CREATE INDEX "user_vessel_access_vessel_id_idx" ON "user_vessel_access"("vessel_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE INDEX "department_memberships_department_id_idx" ON "department_memberships"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "vessels_code_key" ON "vessels"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vessels_imo_number_key" ON "vessels"("imo_number");

-- CreateIndex
CREATE UNIQUE INDEX "vessels_mmsi_key" ON "vessels"("mmsi");

-- CreateIndex
CREATE UNIQUE INDEX "vessels_photo_file_id_key" ON "vessels"("photo_file_id");

-- CreateIndex
CREATE INDEX "vessels_company_id_status_idx" ON "vessels"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vessel_attachments_file_id_key" ON "vessel_attachments"("file_id");

-- CreateIndex
CREATE INDEX "vessel_attachments_vessel_id_archived_at_idx" ON "vessel_attachments"("vessel_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "ranks_code_key" ON "ranks"("code");

-- CreateIndex
CREATE UNIQUE INDEX "members_amc_ref_key" ON "members"("amc_ref");

-- CreateIndex
CREATE UNIQUE INDEX "members_photo_file_id_key" ON "members"("photo_file_id");

-- CreateIndex
CREATE INDEX "members_last_name_first_name_birth_date_idx" ON "members"("last_name", "first_name", "birth_date");

-- CreateIndex
CREATE INDEX "members_passport_number_idx" ON "members"("passport_number");

-- CreateIndex
CREATE INDEX "members_seaman_book_number_idx" ON "members"("seaman_book_number");

-- CreateIndex
CREATE INDEX "members_status_idx" ON "members"("status");

-- CreateIndex
CREATE UNIQUE INDEX "member_documents_file_id_key" ON "member_documents"("file_id");

-- CreateIndex
CREATE INDEX "member_documents_member_id_idx" ON "member_documents"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_field_definitions_key_key" ON "member_field_definitions"("key");

-- CreateIndex
CREATE INDEX "crew_assignments_vessel_id_status_idx" ON "crew_assignments"("vessel_id", "status");

-- CreateIndex
CREATE INDEX "crew_assignments_member_id_status_idx" ON "crew_assignments"("member_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_policies_name_key" ON "reminder_policies"("name");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_policy_recipients_policy_id_principal_type_princip_key" ON "reminder_policy_recipients"("policy_id", "principal_type", "principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_types_code_key" ON "certificate_types"("code");

-- CreateIndex
CREATE INDEX "certificate_types_subject_kind_is_active_idx" ON "certificate_types"("subject_kind", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_type_validators_type_id_principal_type_principa_key" ON "certificate_type_validators"("type_id", "principal_type", "principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_current_revision_id_key" ON "certificates"("current_revision_id");

-- CreateIndex
CREATE INDEX "certificates_vessel_id_type_id_idx" ON "certificates"("vessel_id", "type_id");

-- CreateIndex
CREATE INDEX "certificates_member_id_type_id_idx" ON "certificates"("member_id", "type_id");

-- CreateIndex
CREATE INDEX "certificates_current_expiry_kind_current_expiry_on_idx" ON "certificates"("current_expiry_kind", "current_expiry_on");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_revisions_approved_request_id_key" ON "certificate_revisions"("approved_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_revisions_certificate_id_revision_no_key" ON "certificate_revisions"("certificate_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_approval_requests_attachment_id_key" ON "certificate_approval_requests"("attachment_id");

-- CreateIndex
CREATE INDEX "certificate_approval_requests_status_submitted_at_idx" ON "certificate_approval_requests"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "certificate_approval_requests_certificate_id_status_idx" ON "certificate_approval_requests"("certificate_id", "status");

-- CreateIndex
CREATE INDEX "certificate_approval_requests_requested_by_id_idx" ON "certificate_approval_requests"("requested_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_request_versions_request_id_version_no_key" ON "certificate_request_versions"("request_id", "version_no");

-- CreateIndex
CREATE INDEX "certificate_approval_decisions_request_id_idx" ON "certificate_approval_decisions"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_attachments_file_id_key" ON "certificate_attachments"("file_id");

-- CreateIndex
CREATE INDEX "certificate_attachments_certificate_id_status_idx" ON "certificate_attachments"("certificate_id", "status");

-- CreateIndex
CREATE INDEX "certificate_renewal_tasks_certificate_id_status_idx" ON "certificate_renewal_tasks"("certificate_id", "status");

-- CreateIndex
CREATE INDEX "certificate_comments_certificate_id_created_at_idx" ON "certificate_comments"("certificate_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "cso_libraries_vessel_id_key" ON "cso_libraries"("vessel_id");

-- CreateIndex
CREATE INDEX "cso_folders_library_id_parent_id_idx" ON "cso_folders"("library_id", "parent_id");

-- CreateIndex
CREATE INDEX "cso_folders_path_idx" ON "cso_folders"("path");

-- CreateIndex
CREATE INDEX "cso_acl_entries_folder_id_idx" ON "cso_acl_entries"("folder_id");

-- CreateIndex
CREATE INDEX "cso_acl_entries_document_id_idx" ON "cso_acl_entries"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "cso_folder_validators_folder_id_principal_type_principal_id_key" ON "cso_folder_validators"("folder_id", "principal_type", "principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "cso_categories_code_key" ON "cso_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "cso_field_definitions_category_id_key_key" ON "cso_field_definitions"("category_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "cso_field_acl_field_id_principal_type_principal_id_key" ON "cso_field_acl"("field_id", "principal_type", "principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "cso_documents_reference_key" ON "cso_documents"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "cso_documents_current_version_id_key" ON "cso_documents"("current_version_id");

-- CreateIndex
CREATE INDEX "cso_documents_folder_id_status_idx" ON "cso_documents"("folder_id", "status");

-- CreateIndex
CREATE INDEX "cso_documents_vessel_id_status_idx" ON "cso_documents"("vessel_id", "status");

-- CreateIndex
CREATE INDEX "cso_documents_search_tsv_idx" ON "cso_documents" USING GIN ("search_tsv");

-- CreateIndex
CREATE UNIQUE INDEX "cso_versions_file_id_key" ON "cso_versions"("file_id");

-- CreateIndex
CREATE INDEX "cso_versions_status_submitted_at_idx" ON "cso_versions"("status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "cso_versions_document_id_version_no_key" ON "cso_versions"("document_id", "version_no");

-- CreateIndex
CREATE INDEX "cso_reference_change_requests_document_id_status_idx" ON "cso_reference_change_requests"("document_id", "status");

-- CreateIndex
CREATE INDEX "cso_shares_recipient_user_id_revoked_at_idx" ON "cso_shares"("recipient_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "cso_shares_recipient_department_id_revoked_at_idx" ON "cso_shares"("recipient_department_id", "revoked_at");

-- CreateIndex
CREATE INDEX "cso_shares_document_id_idx" ON "cso_shares"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- CreateIndex
CREATE INDEX "suppliers_name_idx" ON "suppliers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requests_number_key" ON "purchase_requests"("number");

-- CreateIndex
CREATE INDEX "purchase_requests_vessel_id_status_created_at_idx" ON "purchase_requests"("vessel_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "purchase_requests_requester_id_idx" ON "purchase_requests"("requester_id");

-- CreateIndex
CREATE UNIQUE INDEX "pr_lines_pr_id_line_no_key" ON "pr_lines"("pr_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "pr_revisions_pr_id_revision_no_key" ON "pr_revisions"("pr_id", "revision_no");

-- CreateIndex
CREATE INDEX "pr_comments_pr_id_created_at_idx" ON "pr_comments"("pr_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "purchasing_attachments_file_id_key" ON "purchasing_attachments"("file_id");

-- CreateIndex
CREATE INDEX "purchasing_attachments_entity_type_entity_id_idx" ON "purchasing_attachments"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_number_key" ON "rfqs"("number");

-- CreateIndex
CREATE INDEX "rfqs_vessel_id_status_idx" ON "rfqs"("vessel_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_lines_rfq_id_line_no_key" ON "rfq_lines"("rfq_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_suppliers_rfq_id_supplier_id_key" ON "rfq_suppliers"("rfq_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_file_id_key" ON "quotations"("file_id");

-- CreateIndex
CREATE INDEX "quotations_rfq_id_idx" ON "quotations"("rfq_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_lines_quotation_id_rfq_line_id_key" ON "quotation_lines"("quotation_id", "rfq_line_id");

-- CreateIndex
CREATE INDEX "quotation_selections_quotation_line_id_idx" ON "quotation_selections"("quotation_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_thresholds_scope_currency_key" ON "approval_thresholds"("scope", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_number_key" ON "purchase_orders"("number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_pdf_file_id_key" ON "purchase_orders"("pdf_file_id");

-- CreateIndex
CREATE INDEX "purchase_orders_vessel_id_status_idx" ON "purchase_orders"("vessel_id", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_supplier_id_idx" ON "purchase_orders"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "po_lines_po_id_line_no_key" ON "po_lines"("po_id", "line_no");

-- CreateIndex
CREATE INDEX "po_line_allocations_pr_line_id_idx" ON "po_line_allocations"("pr_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "po_line_allocations_po_line_id_pr_line_id_key" ON "po_line_allocations"("po_line_id", "pr_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "po_revisions_po_id_revision_no_key" ON "po_revisions"("po_id", "revision_no");

-- CreateIndex
CREATE INDEX "po_dispatches_po_id_idx" ON "po_dispatches"("po_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_notes_file_id_key" ON "delivery_notes"("file_id");

-- CreateIndex
CREATE INDEX "delivery_notes_po_id_idx" ON "delivery_notes"("po_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_notes_supplier_id_number_key" ON "delivery_notes"("supplier_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_note_lines_delivery_note_id_po_line_id_key" ON "delivery_note_lines"("delivery_note_id", "po_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_number_key" ON "goods_receipts"("number");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_idempotency_key_key" ON "goods_receipts"("idempotency_key");

-- CreateIndex
CREATE INDEX "goods_receipts_po_id_idx" ON "goods_receipts"("po_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_lines_receipt_id_po_line_id_key" ON "receipt_lines"("receipt_id", "po_line_id");

-- CreateIndex
CREATE INDEX "variances_po_id_status_idx" ON "variances"("po_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_file_id_key" ON "invoices"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_supplier_id_number_key" ON "invoices"("supplier_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "voyages_reference_key" ON "voyages"("reference");

-- CreateIndex
CREATE INDEX "voyages_vessel_id_status_idx" ON "voyages"("vessel_id", "status");

-- CreateIndex
CREATE INDEX "voyage_agents_voyage_id_idx" ON "voyage_agents"("voyage_id");

-- CreateIndex
CREATE UNIQUE INDEX "voyage_ports_voyage_id_sequence_key" ON "voyage_ports"("voyage_id", "sequence");

-- CreateIndex
CREATE INDEX "cargos_voyage_id_idx" ON "cargos"("voyage_id");

-- CreateIndex
CREATE UNIQUE INDEX "charter_parties_reference_key" ON "charter_parties"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "charter_parties_current_version_id_key" ON "charter_parties"("current_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "cp_versions_file_id_key" ON "cp_versions"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "cp_versions_charter_party_id_version_no_key" ON "cp_versions"("charter_party_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "cp_acknowledgements_cp_version_id_user_id_key" ON "cp_acknowledgements"("cp_version_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "voyage_instructions_file_id_key" ON "voyage_instructions"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "voyage_instructions_voyage_id_version_no_key" ON "voyage_instructions"("voyage_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "voyage_instruction_acks_instruction_id_user_id_key" ON "voyage_instruction_acks"("instruction_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "voyage_tasks_evidence_file_id_key" ON "voyage_tasks"("evidence_file_id");

-- CreateIndex
CREATE INDEX "voyage_tasks_voyage_id_status_idx" ON "voyage_tasks"("voyage_id", "status");

-- CreateIndex
CREATE INDEX "voyage_notices_voyage_id_status_due_at_idx" ON "voyage_notices"("voyage_id", "status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "nor_records_file_id_key" ON "nor_records"("file_id");

-- CreateIndex
CREATE INDEX "nor_records_voyage_id_idx" ON "nor_records"("voyage_id");

-- CreateIndex
CREATE UNIQUE INDEX "voyage_files_file_id_key" ON "voyage_files"("file_id");

-- CreateIndex
CREATE INDEX "voyage_files_voyage_id_idx" ON "voyage_files"("voyage_id");

-- CreateIndex
CREATE INDEX "noon_reports_vessel_id_report_date_utc_idx" ON "noon_reports"("vessel_id", "report_date_utc" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "noon_reports_voyage_id_report_type_report_date_utc_key" ON "noon_reports"("voyage_id", "report_type", "report_date_utc");

-- CreateIndex
CREATE UNIQUE INDEX "noon_report_revisions_pdf_file_id_key" ON "noon_report_revisions"("pdf_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "noon_report_revisions_noon_report_id_revision_no_key" ON "noon_report_revisions"("noon_report_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "noon_report_attachments_file_id_key" ON "noon_report_attachments"("file_id");

-- CreateIndex
CREATE INDEX "noon_report_attachments_noon_report_id_idx" ON "noon_report_attachments"("noon_report_id");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_delivery_events" ADD CONSTRAINT "email_delivery_events_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "email_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_vessel_access" ADD CONSTRAINT "user_vessel_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_vessel_access" ADD CONSTRAINT "user_vessel_access_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_primary_manager_id_fkey" FOREIGN KEY ("primary_manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_deputies" ADD CONSTRAINT "department_deputies_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_deputies" ADD CONSTRAINT "department_deputies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vessels" ADD CONSTRAINT "vessels_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vessel_attachments" ADD CONSTRAINT "vessel_attachments_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_documents" ADD CONSTRAINT "member_documents_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_field_definitions" ADD CONSTRAINT "member_field_definitions_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "member_field_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_field_values" ADD CONSTRAINT "member_field_values_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_field_values" ADD CONSTRAINT "member_field_values_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "member_field_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_policy_recipients" ADD CONSTRAINT "reminder_policy_recipients_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "reminder_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_types" ADD CONSTRAINT "certificate_types_reminder_policy_id_fkey" FOREIGN KEY ("reminder_policy_id") REFERENCES "reminder_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_type_validators" ADD CONSTRAINT "certificate_type_validators_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "certificate_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "certificate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "certificate_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_revisions" ADD CONSTRAINT "certificate_revisions_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_revisions" ADD CONSTRAINT "certificate_revisions_approved_request_id_fkey" FOREIGN KEY ("approved_request_id") REFERENCES "certificate_approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_approval_requests" ADD CONSTRAINT "certificate_approval_requests_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_approval_requests" ADD CONSTRAINT "certificate_approval_requests_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "certificate_attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_approval_requests" ADD CONSTRAINT "certificate_approval_requests_duplicated_from_id_fkey" FOREIGN KEY ("duplicated_from_id") REFERENCES "certificate_approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_request_versions" ADD CONSTRAINT "certificate_request_versions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "certificate_approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_approval_decisions" ADD CONSTRAINT "certificate_approval_decisions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "certificate_approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_attachments" ADD CONSTRAINT "certificate_attachments_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_attachments" ADD CONSTRAINT "certificate_attachments_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "certificate_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_renewal_tasks" ADD CONSTRAINT "certificate_renewal_tasks_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_comments" ADD CONSTRAINT "certificate_comments_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_libraries" ADD CONSTRAINT "cso_libraries_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_folders" ADD CONSTRAINT "cso_folders_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "cso_libraries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_folders" ADD CONSTRAINT "cso_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "cso_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_acl_entries" ADD CONSTRAINT "cso_acl_entries_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "cso_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_acl_entries" ADD CONSTRAINT "cso_acl_entries_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "cso_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_folder_validators" ADD CONSTRAINT "cso_folder_validators_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "cso_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_field_definitions" ADD CONSTRAINT "cso_field_definitions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "cso_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_field_acl" ADD CONSTRAINT "cso_field_acl_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "cso_field_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_field_values" ADD CONSTRAINT "cso_field_values_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "cso_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_field_values" ADD CONSTRAINT "cso_field_values_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "cso_field_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_documents" ADD CONSTRAINT "cso_documents_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "cso_libraries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_documents" ADD CONSTRAINT "cso_documents_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "cso_folders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_documents" ADD CONSTRAINT "cso_documents_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "cso_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_documents" ADD CONSTRAINT "cso_documents_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "cso_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_documents" ADD CONSTRAINT "cso_documents_copied_from_id_fkey" FOREIGN KEY ("copied_from_id") REFERENCES "cso_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_versions" ADD CONSTRAINT "cso_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "cso_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_reference_change_requests" ADD CONSTRAINT "cso_reference_change_requests_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "cso_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cso_shares" ADD CONSTRAINT "cso_shares_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "cso_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_lines" ADD CONSTRAINT "pr_lines_pr_id_fkey" FOREIGN KEY ("pr_id") REFERENCES "purchase_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_revisions" ADD CONSTRAINT "pr_revisions_pr_id_fkey" FOREIGN KEY ("pr_id") REFERENCES "purchase_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_revision_lines" ADD CONSTRAINT "pr_revision_lines_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "pr_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_comments" ADD CONSTRAINT "pr_comments_pr_id_fkey" FOREIGN KEY ("pr_id") REFERENCES "purchase_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_pr_line_id_fkey" FOREIGN KEY ("pr_line_id") REFERENCES "pr_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_rfq_line_id_fkey" FOREIGN KEY ("rfq_line_id") REFERENCES "rfq_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_selections" ADD CONSTRAINT "quotation_selections_quotation_line_id_fkey" FOREIGN KEY ("quotation_line_id") REFERENCES "quotation_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_line_allocations" ADD CONSTRAINT "po_line_allocations_po_line_id_fkey" FOREIGN KEY ("po_line_id") REFERENCES "po_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_line_allocations" ADD CONSTRAINT "po_line_allocations_pr_line_id_fkey" FOREIGN KEY ("pr_line_id") REFERENCES "pr_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_revisions" ADD CONSTRAINT "po_revisions_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_dispatches" ADD CONSTRAINT "po_dispatches_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_delivery_note_id_fkey" FOREIGN KEY ("delivery_note_id") REFERENCES "delivery_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_po_line_id_fkey" FOREIGN KEY ("po_line_id") REFERENCES "po_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_delivery_note_id_fkey" FOREIGN KEY ("delivery_note_id") REFERENCES "delivery_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_po_line_id_fkey" FOREIGN KEY ("po_line_id") REFERENCES "po_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_delivery_note_line_id_fkey" FOREIGN KEY ("delivery_note_line_id") REFERENCES "delivery_note_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variances" ADD CONSTRAINT "variances_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variances" ADD CONSTRAINT "variances_po_line_id_fkey" FOREIGN KEY ("po_line_id") REFERENCES "po_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variances" ADD CONSTRAINT "variances_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_order_links" ADD CONSTRAINT "invoice_order_links_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_order_links" ADD CONSTRAINT "invoice_order_links_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_charter_party_id_fkey" FOREIGN KEY ("charter_party_id") REFERENCES "charter_parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_agents" ADD CONSTRAINT "voyage_agents_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_ports" ADD CONSTRAINT "voyage_ports_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_ports" ADD CONSTRAINT "voyage_ports_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "voyage_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargos" ADD CONSTRAINT "cargos_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charter_parties" ADD CONSTRAINT "charter_parties_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charter_parties" ADD CONSTRAINT "charter_parties_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "cp_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cp_versions" ADD CONSTRAINT "cp_versions_charter_party_id_fkey" FOREIGN KEY ("charter_party_id") REFERENCES "charter_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cp_acknowledgements" ADD CONSTRAINT "cp_acknowledgements_cp_version_id_fkey" FOREIGN KEY ("cp_version_id") REFERENCES "cp_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_instructions" ADD CONSTRAINT "voyage_instructions_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_instruction_acks" ADD CONSTRAINT "voyage_instruction_acks_instruction_id_fkey" FOREIGN KEY ("instruction_id") REFERENCES "voyage_instructions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_tasks" ADD CONSTRAINT "voyage_tasks_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_tasks" ADD CONSTRAINT "voyage_tasks_port_id_fkey" FOREIGN KEY ("port_id") REFERENCES "voyage_ports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_notices" ADD CONSTRAINT "voyage_notices_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_notices" ADD CONSTRAINT "voyage_notices_port_id_fkey" FOREIGN KEY ("port_id") REFERENCES "voyage_ports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nor_records" ADD CONSTRAINT "nor_records_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nor_records" ADD CONSTRAINT "nor_records_port_id_fkey" FOREIGN KEY ("port_id") REFERENCES "voyage_ports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_files" ADD CONSTRAINT "voyage_files_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "noon_reports" ADD CONSTRAINT "noon_reports_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "noon_reports" ADD CONSTRAINT "noon_reports_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "noon_report_revisions" ADD CONSTRAINT "noon_report_revisions_noon_report_id_fkey" FOREIGN KEY ("noon_report_id") REFERENCES "noon_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "noon_report_attachments" ADD CONSTRAINT "noon_report_attachments_noon_report_id_fkey" FOREIGN KEY ("noon_report_id") REFERENCES "noon_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
