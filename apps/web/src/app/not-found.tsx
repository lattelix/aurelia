import Link from "next/link";
export default function NotFound() {
  return (
    <div className="page empty-state">
      <h1>This track leads nowhere.</h1>
      <p>The page you’re looking for isn’t here.</p>
      <Link className="button primary" href="/">
        На главную Aurelia
      </Link>
      <Link className="button secondary" href="/app" prefetch={false}>
        Открыть плеер
      </Link>
    </div>
  );
}
