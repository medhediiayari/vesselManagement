/** Files de jobs (Redis + BullMQ). Workers dans le même process si WORKERS_ENABLED=true. */
export const QUEUES = {
  EMAIL: 'email',
  FILES: 'files',
  SCHEDULER: 'scheduler',
  IMPORTS: 'imports',
  EXPORTS: 'exports',
} as const;

export const SCHEDULED_JOBS = {
  CERTIFICATE_REMINDERS: 'certificate-reminders',
  CSO_REMINDERS: 'cso-reminders',
  PURCHASING_FOLLOWUP: 'purchasing-followup',
  VOYAGE_NOTICES: 'voyage-notices',
  ORPHAN_FILES_CLEANUP: 'orphan-files-cleanup',
} as const;

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};
