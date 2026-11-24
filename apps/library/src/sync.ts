// Keeps the rebuild video on the original's clock. The original leads; the rebuild
// follows. The two recordings use the same script, so equal times show the same step.

/** How far the follower may drift before it is moved, in seconds. Small enough to look locked, large enough not to stutter. */
export const DRIFT_TOLERANCE = 0.08;

/**
 * Where the follower should be for a leader time, clamped to the follower's length.
 * A follower shorter than the leader holds its last frame until the leader loops.
 */
export function followerTime(leaderTime: number, followerDuration: number): number {
  if (!Number.isFinite(followerDuration) || followerDuration <= 0) return leaderTime;
  return Math.min(Math.max(leaderTime, 0), Math.max(followerDuration - 0.001, 0));
}

/** True when the follower is far enough from where it should be to need a seek. */
export function needsSeek(leaderTime: number, followerCurrent: number, followerDuration: number, tolerance = DRIFT_TOLERANCE): boolean {
  return Math.abs(followerTime(leaderTime, followerDuration) - followerCurrent) > tolerance;
}

/** "0:03.2" for a time in seconds. */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}
