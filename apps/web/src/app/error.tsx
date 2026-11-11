"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="page empty-state">
      <h1>Let’s try that again.</h1>
      <p>This page hit a snag. Your saved music is still in your library.</p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
