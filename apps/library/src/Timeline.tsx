import type { MotionEntry } from "@kinetic/schema";
import { buildTimeline, curvePath, easingCurve, formatMs, type TimelineRow } from "./timeline.ts";

const CURVE_W = 44;
const CURVE_H = 32;

function Curve({ row }: { row: TimelineRow }) {
  const points = easingCurve(row.easing);
  const label = typeof row.easing === "string" ? row.easing : `cubic-bezier(${row.easing.join(", ")})`;
  if (!points) return <span className="curve curve-unknown" title={label}>?</span>;
  return (
    <svg className="curve" viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} width={CURVE_W} height={CURVE_H} role="img" aria-label={`Easing ${label}`}>
      <title>{label}</title>
      <path className="curve-frame" d={`M0 ${CURVE_H * 0.8} H${CURVE_W} M0 ${CURVE_H * 0.2} H${CURVE_W}`} />
      <path className="curve-line" d={curvePath(points, CURVE_W, CURVE_H)} />
    </svg>
  );
}

function Row({ row }: { row: TimelineRow }) {
  return (
    <li className={`tl-row tl-${row.source}`}>
      <span className="tl-label">
        <span className="tl-property">{row.property}</span>
        <span className="tl-element">
          {row.element} · {row.trigger}
        </span>
      </span>
      <span className="tl-track">
        <span className={`tl-bar${row.repeats ? " tl-repeat" : ""}`} style={{ left: `${row.start * 100}%`, width: `${(row.end - row.start) * 100}%` }}>
          {row.offsets.map((offset, i) => (
            <span key={i} className="tl-tick" style={{ left: `${offset * 100}%` }} />
          ))}
        </span>
      </span>
      <span className="tl-meta">
        <span>{row.label}</span>
        <span className={`confidence confidence-${row.confidence}`}>{row.confidence}</span>
      </span>
      <Curve row={row} />
    </li>
  );
}

export function Timeline({ entries }: { entries: readonly MotionEntry[] }) {
  const { timed, scroll, axisMs } = buildTimeline(entries);
  return (
    <section aria-labelledby="timeline-title">
      <h2 id="timeline-title">Motion timeline</h2>
      {entries.length === 0 && <p className="muted">No motion was captured.</p>}
      {timed.length > 0 && (
        <>
          <div className="tl-axis" aria-hidden="true">
            <span>0</span>
            <span>{formatMs(axisMs / 2)}</span>
            <span>{formatMs(axisMs)}</span>
          </div>
          <ul className="timeline" aria-label="Time-based motion, one row per property">
            {timed.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </ul>
        </>
      )}
      {scroll.length > 0 && (
        <>
          <h3>Scroll-linked</h3>
          <ul className="timeline" aria-label="Scroll-linked motion, one row per property">
            {scroll.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
