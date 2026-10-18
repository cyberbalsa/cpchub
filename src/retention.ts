export const DAY_MS = 86_400_000;
export const RETENTION_MS = 14 * DAY_MS;
export const UPLOAD_WINDOW_MS = 3_600_000;
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;
// Queue invocations have a 15-minute wall-time limit. Keep cleanup beyond that
// limit so an interrupted consumer cannot write an object after its deletion.
export const JOB_LEASE_MS = 20 * 60_000;
export const PUBLIC_IMAGE_KEY =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-[a-f0-9]{16}\.webp$/;

export function canRestore(
  deletedAt: string | null,
  time = Date.now(),
): boolean {
  return deletedAt !== null && Date.parse(deletedAt) > time - RETENTION_MS;
}
