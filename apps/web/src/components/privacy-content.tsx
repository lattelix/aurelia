import Link from "next/link";
import { appHref } from "@/lib/app-navigation";

export function PrivacyContent() {
  return (
    <div className="page prose-page">
      <span className="eyebrow">YOUR MUSIC, YOUR DATA</span>
      <h1>Privacy & listening</h1>
      <p>
        Aurelia stores your account identities, saved tracks, playlists, search
        requests you submit, listening history, and feedback to provide your
        library and recommendations. We do not sell this data or use it for
        advertising.
      </p>
      <h2>You’re in control</h2>
      <p>
        Export your music library metadata or permanently delete your account
        from the Account page. Account deletion removes sessions, identities,
        playlists, history, recommendation signals, feature votes, and private
        product feedback. Shared music metadata is retained independently of
        accounts.
      </p>
      <h2>External services</h2>
      <p>
        Opening Lyrics sends the song search query to LRCLIB. You choose the
        recording before synchronized text is displayed.
      </p>
      <p>
        Google, Telegram, and Apple authenticate you only when you choose them.
        We verify their identity tokens on the server. Spotify tokens are used
        for your requested personal library transfer and are discarded
        afterwards.
      </p>
      <p>
        Choosing a YouTube search, audio, or video connects your device or our
        server to Google services and is subject to{" "}
        <a
          href="https://www.youtube.com/t/terms"
          target="_blank"
          rel="noreferrer"
        >
          YouTube’s terms
        </a>{" "}
        and{" "}
        <a
          href="https://policies.google.com/privacy"
          target="_blank"
          rel="noreferrer"
        >
          Google’s privacy policy
        </a>
        . YouTube may set its own cookies and display advertising. Video uses
        the official embedded player. When an audio source is available, our
        server relays it to your player; availability depends on the source.
        This web version does not save music for downloading or offline use.
      </p>
      <p>
        When guest verification is enabled, choosing guest audio loads a
        Cloudflare Turnstile check. The server validates the result and stores a
        short-lived HTTP-only guest-access cookie.{" "}
        <a
          href="https://www.cloudflare.com/privacypolicy/"
          target="_blank"
          rel="noreferrer"
        >
          Cloudflare privacy policy
        </a>{" "}
        describes its data processing. Feature votes expose totals; product
        feedback stays private to its owner and is not automatically published.
      </p>
      <h2>Storage & security</h2>
      <p>
        Session cookies are HTTP-only, and passwords are hashed with scrypt. The
        player queue and recent search terms are also saved on your device under
        your account ID. You can remove this local data by clearing the
        browser’s site data. Original studio recordings and artwork ship with
        the application under CC0.
      </p>
      <h2>Before a public launch</h2>
      <p>
        This is a private MVP. A public deployment requires an identified
        operator, support contact, hosting region, retention policy, and
        completed provider compliance review. The project documentation records
        these release requirements.
      </p>
      <Link href={appHref("/account")} className="button secondary">
        Manage your account
      </Link>
    </div>
  );
}
