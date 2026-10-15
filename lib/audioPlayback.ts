// Garde-fous de la file de lecture kiosque. Sans plafond, une durée
// Infinity/NaN (MP3 tronqué après decodeAudioData) transforme le
// setTimeout de fin en ~24 jours : l'historique continue de se remplir
// mais plus aucun prénom n'est joué.

export const MAX_PLAYBACK_GUARD_MS = 30_000;
export const UNKNOWN_DURATION_GUARD_MS = 8_000;
export const MIN_PLAYBACK_GUARD_MS = 500;
export const RESUME_TIMEOUT_MS = 300;

export function playbackGuardMs(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return UNKNOWN_DURATION_GUARD_MS;
  }
  return Math.min(
    Math.max(durationSeconds * 1000 + 1000, MIN_PLAYBACK_GUARD_MS),
    MAX_PLAYBACK_GUARD_MS
  );
}

export function resumeWithTimeout(
  resume: () => Promise<void>,
  timeoutMs: number = RESUME_TIMEOUT_MS
): Promise<void> {
  return Promise.race([
    resume().then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]).catch(() => {});
}
