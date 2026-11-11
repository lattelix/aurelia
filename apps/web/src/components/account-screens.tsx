"use client";
import { appHref } from "@/lib/app-navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  LogOut,
  Shield,
  Check,
  ArrowUpRight,
  AudioLines,
  Smartphone,
} from "lucide-react";
import { api } from "@/lib/client-api";
import { useApp, usePlayer } from "./app-context";
import { Dialog } from "./dialog";
import { AppearancePicker } from "./appearance-picker";
import { Capacitor } from "@capacitor/core";
import { DeviceApproval } from "./device-approval";
import { LocalCredential } from "./local-credential";
import { AccountSecurity } from "./account-security";
import { AuthNotice } from "./auth-notice";
import { nativeCloudSessionAvailable } from "@/lib/native-cloud-session";
import {
  captureApiAccountScope,
  apiAccountScopeCurrent,
} from "@/lib/client-account";
export function AccountScreen() {
  const { data, openAuth, setUser, toast } = useApp();
  const [deletingFor, setDeletingFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expectedUserId, setExpectedUserId] = useState<string | null>(null);
  useEffect(() => {
    setExpectedUserId(
      new URLSearchParams(window.location.search).get("expectedUserId"),
    );
  }, []);
  if (!data.user)
    return (
      <div className="page account-page">
        <AuthNotice />
        <DeviceApproval key="guest" />
        <div className="page-heading">
          <div>
            <span className="eyebrow">A LITTLE SPACE OF YOUR OWN</span>
            <h1>Your music starts here.</h1>
          </div>
        </div>
        <div className="empty-state">
          <AudioLines size={48} />
          <h2>Make yourself at home</h2>
          <p>
            Save songs, build playlists, and find a mix that feels like you.
          </p>
          <button className="button primary" onClick={openAuth}>
            Create account or sign in
          </button>
        </div>
      </div>
    );
  const user = data.user;
  const wrongBrowserAccount =
    expectedUserId !== null && expectedUserId !== user.id;
  const nativeSession = nativeCloudSessionAvailable();
  return (
    <div className="page account-page">
      <AuthNotice />
      <DeviceApproval key={data.user?.id ?? "guest"} />
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR CORNER OF AURELIA</span>
          <h1>Your account</h1>
        </div>
      </div>
      <div className="account-profile">
        <span className="avatar big">{user.name[0].toUpperCase()}</span>
        <div>
          <h2>{user.name}</h2>
          <p>{user.email ?? "Connected with your social identity"}</p>
        </div>
      </div>
      <section className="settings-section">
        <h2>Connected accounts</h2>
        <p className="muted">
          Link another sign-in method to this same account. Your library stays
          together.
        </p>
        {wrongBrowserAccount && (
          <p role="alert" className="error-text">
            The app uses a different account. Sign out here and sign in to the
            same account before linking services.
          </p>
        )}
        {nativeSession && (
          <a
            className="button secondary"
            href={`https://aurelia.lattelix.com/account?expectedUserId=${encodeURIComponent(user.id)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Manage sign-in methods in your browser <ArrowUpRight size={16} />
          </a>
        )}
        {(["google", "telegram", "apple"] as const).map((provider) => (
          <div className="settings-row" key={provider}>
            <span>
              <strong>{provider[0].toUpperCase() + provider.slice(1)}</strong>
              <small>
                {user.identities.includes(provider)
                  ? "Linked to your account"
                  : data.capabilities[provider]
                    ? "Connect to your existing account"
                    : "Sign-in service not connected yet"}
              </small>
            </span>
            {user.identities.includes(provider) ? (
              <span className="status-pill">
                <Check size={16} />
                Linked
              </span>
            ) : (
              <form
                method="post"
                action={`/api/auth/${provider}/start?expectedUserId=${encodeURIComponent(user.id)}&returnTo=${encodeURIComponent(expectedUserId ? `/account?expectedUserId=${expectedUserId}` : "/account")}`}
              >
                <button
                  className="button secondary small"
                  disabled={
                    !data.capabilities[provider] ||
                    wrongBrowserAccount ||
                    nativeSession
                  }
                >
                  Link account <ArrowUpRight size={16} />
                </button>
              </form>
            )}
          </div>
        ))}
        {user.identities.includes("local") ? (
          <div className="settings-row">
            <strong>Email and password</strong>
            <span className="status-pill">
              <Check size={16} />
              Linked
            </span>
          </div>
        ) : (
          !wrongBrowserAccount &&
          !nativeSession &&
          data.capabilities.localAccounts !== false && (
            <LocalCredential key={user.id} user={user} />
          )
        )}
      </section>
      {!nativeSession && !wrongBrowserAccount && (
        <AccountSecurity key={user.id} userId={user.id} />
      )}
      <section className="settings-section">
        <h2>Your data belongs to you</h2>
        <div className="settings-row">
          <span>
            <strong>Export your library</strong>
            <small>
              Download your playlists, likes, and listening history.
            </small>
          </span>
          <button
            className="button secondary small"
            onClick={async () => {
              const scope = captureApiAccountScope();
              try {
                const exported = await api("library/export", {
                  headers: { "X-Aurelia-Account": user.id },
                });
                if (!apiAccountScopeCurrent(scope)) return;
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(exported, null, 2)], {
                    type: "application/json",
                  }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "aurelia-library.json";
                a.click();
                URL.revokeObjectURL(url);
              } catch (e) {
                if (apiAccountScopeCurrent(scope))
                  toast(e instanceof Error ? e.message : "Export failed");
              }
            }}
          >
            <ArrowDownToLine size={17} />
            Export
          </button>
        </div>
        {!nativeSession && (
          <div className="settings-row">
            <span>
              <strong>Delete account</strong>
              <small>
                Permanently remove your account, identities, and personal data.
              </small>
            </span>
            <button
              className="text-button danger-text"
              onClick={() => setDeletingFor(user.id)}
            >
              Delete account
            </button>
          </div>
        )}
      </section>
      <button
        className="button secondary"
        onClick={async () => {
          const scope = captureApiAccountScope();
          try {
            await api("auth/logout", { method: "POST" });
            if (!apiAccountScopeCurrent(scope)) return;
            setUser(null);
            toast("You’re signed out");
          } catch (e) {
            if (apiAccountScopeCurrent(scope))
              toast(e instanceof Error ? e.message : "Sign out failed");
          }
        }}
      >
        <LogOut size={18} />
        Sign out
      </button>
      {deletingFor && (
        <Dialog
          title="Delete your account?"
          onClose={() => setDeletingFor(null)}
        >
          <p>
            Your library, playlists, listening history, and all linked
            identities will be permanently deleted.
          </p>
          <p className="muted">
            Export your data first if you want to keep it.
          </p>
          <button
            className="button danger wide"
            disabled={busy}
            onClick={async () => {
              if (deletingFor !== user.id) {
                setDeletingFor(null);
                toast(
                  "Your account changed. Start again if you want to delete it.",
                );
                return;
              }
              const scope = captureApiAccountScope();
              setBusy(true);
              try {
                await api("auth/account", {
                  method: "DELETE",
                  headers: { "X-Aurelia-Account": deletingFor },
                });
                if (!apiAccountScopeCurrent(scope)) return;
                localStorage.removeItem(`aurelia.player.${user.id}`);
                localStorage.removeItem(`aurelia.search.${user.id}`);
                setDeletingFor(null);
                setUser(null);
                toast("Your account and personal data have been deleted");
              } catch (e) {
                if (apiAccountScopeCurrent(scope))
                  toast(e instanceof Error ? e.message : "Deletion failed");
              } finally {
                if (apiAccountScopeCurrent(scope)) setBusy(false);
              }
            }}
          >
            Permanently delete account
          </button>
        </Dialog>
      )}
    </div>
  );
}
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export function SettingsScreen() {
  const { data, player, toast } = useApp();
  const state = usePlayer();
  const nativePlayback = Capacitor.isNativePlatform();
  const [install, setInstall] = useState<InstallEvent | null>(null);
  useEffect(() => {
    const listener = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", listener);
    return () => window.removeEventListener("beforeinstallprompt", listener);
  }, []);
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">MAKE IT FEEL LIKE YOU</span>
          <h1>Settings</h1>
        </div>
      </div>
      <AppearancePicker />
      <section className="settings-section">
        <h2>Listening</h2>
        <div className="settings-row">
          <span>
            <strong>Keep the music going</strong>
            <small>
              {nativePlayback
                ? "Related-song continuation is not available in the native player yet. Choose a mix or add songs to your queue."
                : "Add related songs when your queue ends, when the source provides them."}
            </small>
          </span>
          <button
            role="switch"
            aria-checked={!nativePlayback && state.autoplay}
            disabled={nativePlayback}
            aria-label="Autoplay"
            className={`switch ${!nativePlayback && state.autoplay ? "on" : ""}`}
            onClick={() =>
              player.dispatch({ type: "autoplay", enabled: !state.autoplay })
            }
          >
            <span />
          </button>
        </div>
        <div className="settings-row">
          <span>
            <strong>Keyboard shortcuts</strong>
            <small>Space: play/pause · Alt + arrows: previous/next.</small>
          </span>
          <kbd>Space</kbd>
        </div>
      </section>
      <section className="settings-section">
        <h2>Music sources</h2>
        {data.capabilities.demoCatalogue && (
          <div className="settings-row">
            <span>
              <strong>Aurelia Studio</strong>
              <small>12 original instrumental sketches. Ready to play.</small>
            </span>
            <span className="status-pill">
              <Check size={15} />
              Available
            </span>
          </div>
        )}
        <div className="settings-row">
          <span>
            <strong>YouTube</strong>
            <small>
              {data.capabilities.youtube
                ? "Search by song title or paste a video link to play and save it."
                : "Paste a video link in Search to play and save it. Search by title is not connected yet."}
            </small>
          </span>
          <span className="status-pill">
            {data.capabilities.youtube ? "Connected" : "Video links available"}
          </span>
        </div>
        <p className="source-notice">
          {Capacitor.isNativePlatform()
            ? "YouTube audio uses the device playback module. Unavailable recordings show an error; video opens separately on YouTube."
            : data.capabilities.youtubeAudio
              ? "Audio availability is experimental. If the source is unavailable, the player opens the official video and pauses when the app is hidden. Background YouTube audio has not been verified on this server."
              : "YouTube plays as video while the app is visible. Audio mode is not enabled on this server."}
        </p>
      </section>
      <section className="settings-section">
        <h2>Take Aurelia with you</h2>
        <div className="settings-row">
          <span>
            <strong>Install the app</strong>
            <small>
              On iPhone: open in Safari, tap Share, then Add to Home Screen.
            </small>
          </span>
          {install ? (
            <button
              className="button secondary small"
              onClick={async () => {
                await install.prompt();
                const choice = await install.userChoice;
                if (choice.outcome === "accepted") setInstall(null);
              }}
            >
              <Smartphone size={17} />
              Install
            </button>
          ) : (
            <Smartphone size={25} />
          )}
        </div>
        <div className="settings-row">
          <span>
            <strong>Offline</strong>
            <small>
              The interface and downloaded UI assets stay available. Streaming
              and library changes need a connection.
            </small>
          </span>
          <Shield size={22} />
        </div>
      </section>
      <section className="settings-section">
        <h2>About</h2>
        <div className="settings-row">
          <span>
            <strong>Aurelia · Studio Edition</strong>
            <small>Independent music, a little closer. Version 0.1.0.</small>
          </span>
          <AudioLines size={25} />
        </div>
        <p>
          <Link href="/privacy">Privacy & data</Link> ·{" "}
          <Link href={appHref("/account")}>Your account</Link> ·{" "}
          <button
            className="text-button"
            onClick={() =>
              toast(
                "Artwork and original instrumental sketches are included under CC0. See THIRD_PARTY_NOTICES.md for dependencies.",
              )
            }
          >
            Credits
          </button>
        </p>
      </section>
    </div>
  );
}
export { PrivacyContent as PrivacyScreen } from "./privacy-content";
