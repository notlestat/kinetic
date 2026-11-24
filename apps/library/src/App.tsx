import { useEffect } from "react";
import { listCaptures } from "./api.ts";
import { Detail } from "./Detail.tsx";
import { Grid } from "./Grid.tsx";
import { useLoad, useRoute } from "./hooks.ts";

export function App() {
  const route = useRoute();

  // Each route starts at the top, and focus moves to the main region for keyboard and screen reader users.
  useEffect(() => {
    window.scrollTo(0, 0);
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [route.page, route.page === "detail" ? `${route.site}/${route.slug}` : ""]);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <a className="wordmark" href="#/">
          Kinetic <span>library</span>
        </a>
      </header>
      <main id="main" tabIndex={-1}>
        {route.page === "detail" ? <Detail key={`${route.site}/${route.slug}`} site={route.site} slug={route.slug} /> : <GridPage />}
      </main>
    </>
  );
}

function GridPage() {
  const [result] = useLoad("grid", (signal) => listCaptures(signal));
  useEffect(() => {
    document.title = "Kinetic library";
  }, []);
  return (
    <>
      <h1 className="page-title">Captures</h1>
      {result.state === "loading" && <p className="muted">Loading…</p>}
      {result.state === "error" && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      {result.state === "ready" && <Grid captures={result.data} />}
    </>
  );
}
