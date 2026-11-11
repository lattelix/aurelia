"use client";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Upload,
  CheckCircle2,
  Link2,
  Music2,
  FileJson,
  AlertCircle,
} from "lucide-react";
import type { Match } from "@aurelia/integrations";
import { api } from "@/lib/client-api";
import { useApp } from "./app-context";
import { nativeCloudSessionAvailable } from "@/lib/native-cloud-session";
import { captureApiAccountScope, apiAccountScopeCurrent } from "@/lib/client-account";
import { AuthNotice } from "./auth-notice";
interface ImportStatus {
  jobs: {
    id: string;
    provider: string;
    status: string;
    total: number;
    imported: number;
    matched: number;
    unmatched: number;
    failed: number;
    notice: string | null;
  }[];
  items: {
    id: string;
    source: Match["source"];
    match: Match;
    status: string;
  }[];
}
export function ImportScreen() {
  const { data, ensureAccount, refresh, toast } = useApp();
  const [status, setStatus] = useState<ImportStatus>({ jobs: [], items: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => {
    const scope = captureApiAccountScope();
    return api<ImportStatus>("import", { headers: scope.userId ? { "X-Aurelia-Account": scope.userId } : {} })
      .then((value) => { if (apiAccountScopeCurrent(scope)) setStatus(value); })
      .catch((reason: unknown) => {
        if (apiAccountScopeCurrent(scope)) setError(reason instanceof Error ? reason.message : "Could not load import progress.");
      });
  };
  useEffect(() => {
    setStatus({ jobs: [], items: [] }); setError(""); setBusy(false);
    if (data.user) void load();
    // Account ownership, rather than profile object refreshes, owns import state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.user?.id]);
  useEffect(() => {
    if (!busy && !status.jobs.some((j) => j.status === "running")) return;
    const interval = setInterval(() => void load(), 1500);
    return () => clearInterval(interval);
  }, [busy, status.jobs]);
  async function run(kind: "fixture" | "file", file?: File) {
    if (!ensureAccount()) return;
    const scope = captureApiAccountScope();
    setBusy(true);
    setError("");
    try {
      if (file && file.size > 2_000_000) throw new Error("This import supports files up to 2 MB. Split larger collections first.");
      const input = file ? JSON.parse(await file.text()) : undefined;
      if (!apiAccountScopeCurrent(scope)) return;
      const result = await api<ImportStatus>(`import/${kind}`, {
        method: "POST",
        headers: { "X-Aurelia-Account": scope.userId! },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      if (!apiAccountScopeCurrent(scope)) return;
      setStatus(result);
      await refresh();
      if (!apiAccountScopeCurrent(scope)) return;
      toast("Your import is ready. Review any unmatched songs below.");
    } catch (e) {
      if (apiAccountScopeCurrent(scope)) setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      if (apiAccountScopeCurrent(scope)) setBusy(false);
    }
  }
  async function resolve(itemId: string, trackId: string) {
    const scope = captureApiAccountScope();
    try {
      const next = await api<ImportStatus>("import/resolve", {
          method: "POST",
          headers: scope.userId ? { "X-Aurelia-Account": scope.userId } : {},
          body: JSON.stringify({ itemId, trackId }),
        });
      if (!apiAccountScopeCurrent(scope)) return;
      setStatus(next);
      await refresh();
      if (!apiAccountScopeCurrent(scope)) return;
      toast("Match confirmed and added to your library");
    } catch (e) {
      if (apiAccountScopeCurrent(scope)) toast(e instanceof Error ? e.message : "Could not match");
    }
  }
  const latest = status.jobs[0];
  return (
    <div className="page import-page">
      <AuthNotice />
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR FAVORITES, A NEW HOME</span>
          <h1>Bring your music with you.</h1>
          <p className="muted">A fresh start doesn’t mean starting over.</p>
        </div>
      </div>
      <div className="import-intro">
        <Link2 size={35} />
        <div>
          <h2>Your library stays yours.</h2>
          <p>
            Transfer your personal saved songs and playlist structure. We match
            titles, artists, albums, and duration, and ask you to review
            anything uncertain. No audio is copied.
          </p>
        </div>
      </div>
      <div className="import-options">
        <article>
          <div className="provider-symbol spotify-symbol">≋</div>
          <span className="eyebrow">PERSONAL LIBRARY TRANSFER</span>
          <h2>Spotify</h2>
          <p>Saved tracks, your playlists, and followed artists.</p>
          {data.capabilities.spotify ? (
            nativeCloudSessionAvailable() ? <a className="button primary" target="_blank" rel="noopener noreferrer" href={`https://aurelia.lattelix.com/account?expectedUserId=${encodeURIComponent(data.user?.id ?? "")}`}>Open your account in browser</a> : <form
              method="post"
              action={`/api/auth/spotify/start?expectedUserId=${encodeURIComponent(data.user?.id ?? "")}`}
              onSubmit={(e) => {
                if (!data.user) {
                  e.preventDefault();
                  ensureAccount();
                }
              }}
            ><button className="button primary">
              Connect Spotify
              <ArrowRight size={18} />
            </button></form>
          ) : (
            <>
              <button
                className="button secondary"
                onClick={() => void run("fixture")}
                disabled={busy}
              >
                {busy ? "Importing…" : "Try a sample import"}
                <ArrowRight size={18} />
              </button>
              <small>Sample data only. Spotify is not connected yet.</small>
            </>
          )}
        </article>
        <article>
          <div className="provider-symbol">
            <FileJson size={28} />
          </div>
          <span className="eyebrow">FROM A PERSONAL EXPORT</span>
          <h2>Import a file</h2>
          <p>
            An Aurelia library export or a JSON file with track titles, artists, and playlists. Up to 1,000 unique songs and 2 MB per file.
          </p>
          <label className="button secondary file-button">
            <Upload size={18} />
            Choose JSON file
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void run("file", file);
                e.target.value = "";
              }}
            />
          </label>
          <a href="/sample-import.json" download className="text-button muted">
            Download the sample format
          </a>
        </article>
      </div>
      {error && (
        <p className="form-error" role="alert">
          <AlertCircle size={18} />
          {error}
        </p>
      )}
      {latest && (
        <section className="import-progress">
          <div className="section-heading">
            <h2>
              {latest.status === "running"
                ? "Finding your music…"
                : latest.status === "failed"
                  ? "Import needs attention"
                  : "Your library is finding its feet."}
            </h2>
            <span className="status-pill">
              <CheckCircle2 size={16} />
              {latest.provider === "fixture"
                ? "Sample import"
                : latest.provider}{" "}
              · {latest.status}
            </span>
          </div>
          <progress
            max={Math.max(1, latest.total)}
            value={
              latest.status === "complete"
                ? latest.total
                : latest.matched + latest.unmatched
            }
          />
          <div className="import-counters">
            {[
              ["Imported", latest.imported],
              ["Matched", latest.matched],
              ["To review", latest.unmatched],
              ["Failed", latest.failed],
            ].map(([label, value]) => (
              <div key={label}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          {latest.notice && <p className="source-notice">{latest.notice}</p>}
        </section>
      )}
      {status.items.length > 0 && (
        <section>
          <div className="section-heading">
            <div>
              <span className="eyebrow">A LITTLE HELP FROM YOU</span>
              <h2>Let’s find the right song.</h2>
            </div>
          </div>
          {status.items.map((item) => (
            <div className="match-review" key={item.id}>
              <div>
                <Music2 size={25} />
                <span>
                  <strong>{item.source.title}</strong>
                  <small>
                    {item.source.artist} ·{" "}
                    {item.status === "review"
                      ? "Needs confirmation"
                      : "No confident match"}
                  </small>
                </span>
              </div>
              {item.match.candidates
                .filter(
                  (c) => c.track.provider === "youtube" || c.confidence >= 0.5,
                )
                .map((c) => (
                  <button
                    className="button secondary small"
                    key={c.track.id}
                    onClick={() => void resolve(item.id, c.track.id)}
                  >
                    {c.track.title} · {c.track.artist} ·{" "}
                    {Math.round(c.confidence * 100)}%
                  </button>
                ))}
              <label>
                Choose a match
                <select
                  aria-label={`Choose match for ${item.source.title}`}
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) void resolve(item.id, e.target.value);
                  }}
                >
                  <option value="" disabled>
                    Select a song…
                  </option>
                  {data.catalogue.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} — {t.artist}
                    </option>
                  ))}
                </select>
              </label>
              <small className="muted">
                Selecting a song explicitly confirms the match.
              </small>
            </div>
          ))}
        </section>
      )}
      <p className="fine-print">
        Only import libraries you own. Spotify access tokens are used on the
        server for this transfer and are not retained.
      </p>
    </div>
  );
}
