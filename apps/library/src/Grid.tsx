import { useMemo, useState } from "react";
import { type BrokenCapture, type CaptureListItem, isBroken } from "./api.ts";
import { EMPTY_FILTERS, type FilterState, MOTION_FILTERS, matchesFilters, sitesOf, tagsFor, toggle, TRIGGER_FILTERS } from "./filters.ts";
import { detailHref, useReducedMotion } from "./hooks.ts";

export function Grid({ captures }: { captures: (CaptureListItem | BrokenCapture)[] }) {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const items = useMemo(() => captures.filter((c): c is CaptureListItem => !isBroken(c)), [captures]);
  const broken = captures.filter(isBroken);
  const shown = items.filter((item) => matchesFilters(item, filters));
  const sites = sitesOf(items);
  const active = (filters.text !== "" || filters.site !== "" || filters.sources.length > 0 || filters.triggers.length > 0);

  return (
    <>
      <search className="filters" aria-label="Filter captures">
        <label className="field field-text">
          <span>Search</span>
          <input
            type="search"
            value={filters.text}
            placeholder="Names, URLs and taste notes"
            onChange={(e) => setFilters({ ...filters, text: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Site</span>
          <select value={filters.site} onChange={(e) => setFilters({ ...filters, site: e.target.value })}>
            <option value="">All sites</option>
            {sites.map((site) => (
              <option key={site} value={site}>
                {site}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="chips">
          <legend>Motion</legend>
          {MOTION_FILTERS.map((f) => (
            <label key={f.id} className="chip">
              <input type="checkbox" checked={filters.sources.includes(f.id)} onChange={() => setFilters({ ...filters, sources: toggle(filters.sources, f.id) })} />
              <span>{f.label}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="chips">
          <legend>Trigger</legend>
          {TRIGGER_FILTERS.map((f) => (
            <label key={f.id} className="chip">
              <input type="checkbox" checked={filters.triggers.includes(f.id)} onChange={() => setFilters({ ...filters, triggers: toggle(filters.triggers, f.id) })} />
              <span>{f.label}</span>
            </label>
          ))}
        </fieldset>
        {active && (
          <button type="button" className="button quiet" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear filters
          </button>
        )}
      </search>

      <p className="count" role="status" aria-live="polite">
        {shown.length === items.length ? `${items.length} ${items.length === 1 ? "capture" : "captures"}` : `${shown.length} of ${items.length} captures`}
      </p>

      {items.length === 0 ? (
        <div className="empty">
          <p>No captures yet.</p>
          <p>Capture a component with the extension, or browse the examples: run the companion with KINETIC_LIBRARY_DIR=examples.</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="empty">Nothing matches these filters.</p>
      ) : (
        <ul className="grid" aria-label="Captures">
          {shown.map((item) => (
            <Card key={`${item.site}/${item.slug}`} item={item} />
          ))}
        </ul>
      )}

      {broken.length > 0 && (
        <details className="broken">
          <summary>
            {broken.length} unreadable {broken.length === 1 ? "capture" : "captures"}
          </summary>
          <ul>
            {broken.map((b) => (
              <li key={`${b.site}/${b.slug}`}>
                <code>
                  {b.site}/{b.slug}
                </code>
                : {b.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Card({ item }: { item: CaptureListItem }) {
  const reduced = useReducedMotion();
  const tags = tagsFor(item);
  const poster = item.media.screenshot;
  return (
    <li className="card">
      <a className="card-link" href={detailHref(item.site, item.slug)}>
        <div className="card-media">
          {item.media.original ? (
            // Muted, looping and silent, so it needs no controls; with reduced motion it stays on its poster.
            <video
              key={reduced ? "still" : "moving"}
              src={item.media.original}
              poster={poster}
              muted
              loop
              playsInline
              autoPlay={!reduced}
              preload={reduced ? "none" : "metadata"}
              aria-hidden="true"
              tabIndex={-1}
            />
          ) : poster ? (
            <img src={poster} alt="" loading="lazy" />
          ) : (
            <span className="card-placeholder">Not recorded yet</span>
          )}
        </div>
        <span className="card-body">
          <span className="card-name">{item.componentName}</span>
          <span className="card-site">{item.site}</span>
        </span>
      </a>
      {tags.length > 0 && (
        <ul className="tags" aria-label={`${item.componentName} tags`}>
          {tags.map((tag) => (
            <li key={`${tag.kind}:${tag.label}`} className={`tag tag-${tag.kind}`}>
              {tag.label}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
