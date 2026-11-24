import { useCallback, useEffect, useRef, useState } from "react";
import { followerTime, formatClock, needsSeek } from "./sync.ts";

const RATES = [0.25, 0.5, 1] as const;

/**
 * The original and the rebuild side by side on one clock. The original leads: the
 * shared controls drive it, and every frame while it plays (and after each seek)
 * the rebuild is moved back onto its time if it drifts past the tolerance.
 */
export function SyncedVideos({ original, rebuild }: { original: string; rebuild?: string | undefined }) {
  const leaderRef = useRef<HTMLVideoElement>(null);
  const followerRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);

  /** Puts the rebuild on the original's time, and matches play or pause. */
  const sync = useCallback(() => {
    const leader = leaderRef.current;
    const follower = followerRef.current;
    if (!leader) return;
    setTime(leader.currentTime);
    if (!follower || follower.readyState < 1) return;
    if (needsSeek(leader.currentTime, follower.currentTime, follower.duration)) follower.currentTime = followerTime(leader.currentTime, follower.duration);
    const atEnd = follower.currentTime >= follower.duration - 0.01;
    if (!leader.paused && follower.paused && !atEnd) void follower.play().catch(() => undefined);
    if (leader.paused && !follower.paused) follower.pause();
  }, []);

  // While playing, check every frame. Paused, the seek and pause handlers call sync once.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      sync();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, sync]);

  useEffect(() => {
    for (const video of [leaderRef.current, followerRef.current]) if (video) video.playbackRate = rate;
  }, [rate, rebuild]);

  const toggle = () => {
    const leader = leaderRef.current;
    if (!leader) return;
    if (leader.paused) void leader.play().catch(() => undefined);
    else leader.pause();
  };

  const seek = (to: number) => {
    const leader = leaderRef.current;
    if (!leader) return;
    leader.currentTime = to;
    sync();
  };

  return (
    <section className="videos" aria-labelledby="videos-title">
      <h2 id="videos-title">Original and rebuild</h2>
      <div className="video-pair">
        <figure>
          <video
            ref={leaderRef}
            src={original}
            muted
            loop
            playsInline
            preload="auto"
            data-testid="video-original"
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              sync();
            }}
            onSeeked={sync}
            onTimeUpdate={() => !playing && setTime(leaderRef.current?.currentTime ?? 0)}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          />
          <figcaption>Original</figcaption>
        </figure>
        <figure>
          {rebuild ? (
            <video ref={followerRef} src={rebuild} muted playsInline preload="auto" data-testid="video-rebuild" onLoadedMetadata={sync} />
          ) : (
            <div className="video-missing">No rebuild video yet. Run a preview after Component.tsx is written.</div>
          )}
          <figcaption>Rebuild</figcaption>
        </figure>
      </div>
      <div className="transport">
        <button type="button" className="button" onClick={toggle} aria-label={playing ? "Pause both videos" : "Play both videos"}>
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          className="scrub"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(time, duration || 0)}
          aria-label="Position in both videos"
          aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <output className="clock" aria-live="off">
          {formatClock(time)} / {formatClock(duration)}
        </output>
        <fieldset className="rates">
          <legend className="sr-only">Speed</legend>
          {RATES.map((r) => (
            <label key={r} className="chip">
              <input type="radio" name="rate" checked={rate === r} onChange={() => setRate(r)} />
              <span>{r}×</span>
            </label>
          ))}
        </fieldset>
      </div>
    </section>
  );
}
