"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  Account,
  Album,
  Artist,
  Library,
  MusicPlaylist,
  PlaybackSource,
  Track,
  UserPlaylist,
} from "@aurelia/core";
import {
  PlayerStore,
  BrowserAudioEngine,
  NativeAudioEngine,
  DeviceAudioEngine,
  initialPlayer,
  type ListeningEvent,
  type PlaybackStatus,
} from "@aurelia/player";
import { Capacitor } from "@capacitor/core";
import type { RankedTrack } from "@aurelia/recommendations";
import { api } from "@/lib/client-api";
import { nativeCloudSessionAvailable } from "@/lib/native-cloud-session";
import {
  bindApiAccount,
  captureApiAccountScope,
  apiAccountScopeCurrent,
  type ApiAccountScope,
} from "@/lib/client-account";
import {
  AccountOwnership,
  restoreQueueState,
  type AccountOwnershipScope,
  type AccountRefreshTicket,
} from "./account-ownership";
import { AuthDialog } from "./auth-dialog";
import { useGuestVerification } from "./guest-verification";
interface OwnedOperation {
  readonly ownerId: string;
  readonly account: AccountOwnershipScope;
  readonly api: ApiAccountScope;
}
const unauthorized = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  error.status === 401;
interface Bootstrap {
  user: Account | null;
  library: Library | null;
  catalogue: Track[];
  albums: Album[];
  artists: Artist[];
  editorialPlaylists: MusicPlaylist[];
  capabilities: Record<string, boolean>;
  recommendations: RankedTrack[];
}
const emptyLibrary: Library = {
  likes: [],
  playlists: [],
  history: [],
  followedArtists: [],
  queue: null,
  searches: [],
};
interface AppContextValue {
  data: Bootstrap;
  loading: boolean;
  error: string | null;
  player: PlayerStore;
  playback: PlaybackStatus;
  toast: (message: string) => void;
  refresh: () => Promise<void>;
  ensureAccount: () => boolean;
  openAuth: (event?: { currentTarget: EventTarget | null }) => void;
  like: (track: Track) => Promise<void>;
  hide: (track: Track) => Promise<void>;
  createPlaylist: (
    name: string,
    description?: string,
  ) => Promise<string | null>;
  updatePlaylist: (
    id: string,
    changes: { name?: string; description?: string },
  ) => Promise<boolean>;
  reorderPlaylist: (
    id: string,
    trackIds: string[],
    expectedTrackIds: string[],
  ) => Promise<boolean>;
  addTrack: (playlist: UserPlaylist, track: Track) => Promise<boolean>;
  mutation: (
    path: string,
    method: string,
    payload?: unknown,
  ) => Promise<boolean>;
  setUser: (user: Account | null) => void;
  listeningEvent: (event: ListeningEvent) => void;
}
const Context = createContext<AppContextValue | null>(null);
export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap>({
    user: null,
    library: emptyLibrary,
    catalogue: [],
    albums: [],
    artists: [],
    editorialPlaylists: [],
    capabilities: {},
    recommendations: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState(false);
  const authOpener = useRef<HTMLElement | null>(null);
  const openAuth = useCallback(
    (event?: { currentTarget: EventTarget | null }) => {
      authOpener.current =
        event?.currentTarget instanceof HTMLElement
          ? event.currentTarget
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      setAuth(true);
    },
    [],
  );
  const [message, setMessage] = useState("");
  const [player] = useState(() => new PlayerStore());
  const {
    verify: verifyGuest,
    cancel: cancelGuestVerification,
    dialog: guestDialog,
  } = useGuestVerification();
  const guestVerificationRequired =
    data.capabilities.guestVerification === true;
  useEffect(
    () =>
      player.subscribe(() => {
        if (!player.getSnapshot().playing) cancelGuestVerification();
      }),
    [player, cancelGuestVerification],
  );
  const [playback, setPlayback] = useState<PlaybackStatus>({ state: "idle" });
  const accountRef = useRef<string | undefined>(undefined);
  const ownership = useRef(new AccountOwnership());
  const mounted = useRef(false);
  const refreshInFlight = useRef<AccountRefreshTicket | null>(null);
  const ready = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((text: string) => {
    setMessage(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(""), 4500);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  const captureOwner = useCallback(
    (expectedId: string | undefined): OwnedOperation | null => {
      const account = ownership.current.capture();
      const apiScope = captureApiAccountScope();
      if (
        !mounted.current ||
        !expectedId ||
        account.userId !== expectedId ||
        accountRef.current !== expectedId ||
        apiScope.userId !== expectedId
      )
        return null;
      return { ownerId: expectedId, account, api: apiScope };
    },
    [],
  );
  const ownerCurrent = useCallback(
    (operation: OwnedOperation) =>
      mounted.current &&
      ownership.current.current(operation.account) &&
      apiAccountScopeCurrent(operation.api) &&
      accountRef.current === operation.ownerId,
    [],
  );
  const clearOwnedProfile = useCallback(
    (scope: AccountOwnershipScope, apiScope: ApiAccountScope) => {
      if (
        !mounted.current ||
        !apiAccountScopeCurrent(apiScope) ||
        !ownership.current.clearAccount(scope)
      )
        return false;
      const previous = accountRef.current;
      bindApiAccount(null);
      accountRef.current = undefined;
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setMessage("");
      player.dispatch({ type: "pause" });
      player.dispatch({ type: "restore", state: initialPlayer });
      if (previous) {
        try {
          localStorage.removeItem(`aurelia.player.${previous}`);
          localStorage.removeItem(`aurelia.search.${previous}`);
        } catch {
          /* Private-mode storage may be unavailable. */
        }
      }
      setData((current) => ({
        ...current,
        user: null,
        library: emptyLibrary,
        recommendations: [],
      }));
      setLoading(false);
      return true;
    },
    [player],
  );
  const operationError = useCallback(
    (error: unknown, operation: OwnedOperation, fallback: string) => {
      if (!ownerCurrent(operation)) return;
      const message = error instanceof Error ? error.message : fallback;
      if (unauthorized(error)) {
        if (clearOwnedProfile(operation.account, operation.api))
          setError(message);
      } else toast(message);
    },
    [ownerCurrent, clearOwnedProfile, toast],
  );
  const refresh = useCallback(async () => {
    const request = ownership.current.beginRefresh();
    refreshInFlight.current = request;
    let completion = request;
    let apiScope = captureApiAccountScope();
    try {
      const result = await api<Bootstrap>("bootstrap");
      if (!mounted.current || !apiAccountScopeCurrent(apiScope)) return;
      const accepted = ownership.current.acceptRefresh(
        request,
        result.user?.id ?? null,
      );
      if (!accepted) return;
      const previous = accountRef.current;
      completion = accepted;
      // Bind before publishing data or dispatching player events for the accepted account.
      bindApiAccount(result.user?.id ?? null);
      apiScope = captureApiAccountScope();
      accountRef.current = result.user?.id;
      if (ready.current && previous !== result.user?.id) {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setMessage("");
        if (previous) {
          try {
            localStorage.removeItem(`aurelia.player.${previous}`);
            localStorage.removeItem(`aurelia.search.${previous}`);
          } catch {
            /* Private-mode storage may be unavailable. */
          }
        }
        player.dispatch({ type: "pause" });
        player.dispatch({ type: "restore", state: initialPlayer });
      }
      const demo = result.capabilities.demoCatalogue === true;
      setData({
        ...result,
        catalogue: demo
          ? result.catalogue
          : result.catalogue.filter((track) => track.provider === "youtube"),
        albums: demo ? result.albums : [],
        artists: demo ? result.artists : [],
        editorialPlaylists: demo ? result.editorialPlaylists : [],
        recommendations: demo
          ? result.recommendations
          : result.recommendations.filter(
              (entry) => entry.track.provider === "youtube",
            ),
      });
      setError(null);
    } catch (e) {
      if (
        mounted.current &&
        ownership.current.refreshCurrent(completion) &&
        apiAccountScopeCurrent(apiScope)
      ) {
        if (unauthorized(e)) clearOwnedProfile(completion.scope, apiScope);
        setError(e instanceof Error ? e.message : "Unable to connect");
      }
    } finally {
      if (refreshInFlight.current === request) refreshInFlight.current = null;
      if (
        mounted.current &&
        ownership.current.refreshCurrent(completion) &&
        apiAccountScopeCurrent(apiScope)
      )
        setLoading(false);
    }
  }, [player, clearOwnedProfile]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const foreground = () => {
      if (document.visibilityState !== "visible") return;
      const pending = refreshInFlight.current;
      if (pending && ownership.current.current(pending.scope)) return;
      void refresh();
    };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refresh]);
  const userId = data.user?.id;
  useEffect(() => {
    if (loading) return;
    const nativeSession = nativeCloudSessionAvailable();
    const preserveInitialPlayback = !ready.current && player.hasPlayRequest();
    if (!preserveInitialPlayback) player.dispatch({ type: "pause" });
    ready.current = false;
    if (!preserveInitialPlayback)
      player.dispatch({ type: "restore", state: initialPlayer });
    const key = `aurelia.player.${userId ?? "guest"}`;
    try {
      const local = localStorage.getItem(key);
      if (!preserveInitialPlayback)
        player.dispatch({
          type: "restore",
          state: restoreQueueState(nativeSession, data.library?.queue, () =>
            local ? JSON.parse(local) : initialPlayer,
          ),
        });
    } catch {
      localStorage.removeItem(key);
    }
    ready.current = true;
    const accountScope = ownership.current.capture();
    const apiScope = captureApiAccountScope();
    const current = () =>
      ownership.current.current(accountScope) &&
      apiAccountScopeCurrent(apiScope) &&
      accountRef.current === userId;
    let lastServer = "";
    let lastLocal = "";
    const save = (departing = false) => {
      if (!ready.current || !current()) return;
      const snapshot = player.getSnapshot();
      const serialized = JSON.stringify(snapshot);
      try {
        if (serialized !== lastLocal) {
          localStorage.setItem(key, serialized);
          lastLocal = serialized;
        }
      } catch {
        /* Storage can be unavailable in private browsers. */
      }
      if (
        !nativeSession &&
        userId &&
        serialized !== lastServer &&
        (!departing || serialized.length < 60000)
      ) {
        lastServer = serialized;
        void api("library/queue", {
          method: "PUT",
          body: serialized,
          keepalive: departing,
          headers: { "X-Aurelia-Account": userId },
        }).catch((error: unknown) => {
          if (!current()) return;
          if (unauthorized(error)) {
            if (clearOwnedProfile(accountScope, apiScope))
              setError(
                error instanceof Error
                  ? error.message
                  : "Sign in again to save your library.",
              );
          } else lastServer = "";
        });
      }
    };
    const saveOnExit = () => save(true);
    const interval = setInterval(save, 5000);
    window.addEventListener("pagehide", saveOnExit);
    return () => {
      save();
      clearInterval(interval);
      window.removeEventListener("pagehide", saveOnExit);
    };
    // Account changes restore only that account's player. Library updates never reset playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, loading, player, clearOwnedProfile]);
  const listeningEvent = useCallback(
    (event: ListeningEvent) => {
      const operation = captureOwner(userId);
      if (!operation) return;
      void api("library/history", {
        method: "POST",
        headers: { "X-Aurelia-Account": operation.ownerId },
        body: JSON.stringify({
          trackId: event.track.id,
          playId: event.playId,
          completion: event.kind === "play" ? 0 : event.completion,
        }),
      })
        .then(() =>
          ownerCurrent(operation) && event.kind === "play"
            ? refresh()
            : undefined,
        )
        .catch((error: unknown) => {
          if (unauthorized(error))
            operationError(
              error,
              operation,
              "Sign in again to save listening history.",
            );
        });
      if (event.kind === "complete" || event.kind === "skip")
        void api("library/signals", {
          method: "POST",
          headers: { "X-Aurelia-Account": operation.ownerId },
          body: JSON.stringify({
            trackId: event.track.id,
            kind: event.kind,
            value: event.kind === "complete" ? event.completion : 1,
          }),
        }).catch((error: unknown) => {
          if (unauthorized(error))
            operationError(
              error,
              operation,
              "Sign in again to save listening history.",
            );
        });
    },
    [userId, refresh, captureOwner, ownerCurrent, operationError],
  );
  const transport = useSyncExternalStore(
    player.subscribe,
    () => {
      const state = player.getSnapshot();
      if (
        Capacitor.isNativePlatform() &&
        (state.queue.some((track) => track.provider === "youtube") ||
          (Capacitor.getPlatform() === "android" &&
            state.queue[state.index]?.provider === "studio" &&
            state.mode === "audio"))
      )
        return "device";
      return Capacitor.getPlatform() === "ios" &&
        Capacitor.isPluginAvailable("AureliaAudio") &&
        state.queue[state.index]?.provider === "studio" &&
        state.mode === "audio"
        ? "studio"
        : "browser";
    },
    () => "browser",
  );
  const deferDevice = loading && transport === "device";
  useEffect(() => {
    if (deferDevice) return;
    setPlayback({ state: "idle" });
    if (transport === "device") {
      const engine = new DeviceAudioEngine(
        player,
        listeningEvent,
        toast,
        setPlayback,
        {
          ownerId: userId ?? "guest",
          pluginAvailable: Capacitor.isPluginAvailable("AureliaDeviceAudio"),
        },
      );
      return () => engine.dispose();
    }
    const acceptsWebAudio = (track: Track) =>
      !Capacitor.isNativePlatform() ||
      (track.provider !== "youtube" &&
        !player
          .getSnapshot()
          .queue.some((entry) => entry.provider === "youtube") &&
        !(
          Capacitor.getPlatform() === "android" &&
          track.provider === "studio" &&
          player.getSnapshot().mode === "audio"
        ));
    const resolve = async (track: Track, signal: AbortSignal) => {
      // Store subscribers run before React replaces an engine after a queue change.
      if (!acceptsWebAudio(track))
        return Promise.reject(
          new Error("Direct playback is not available for this queue."),
        );
      if (track.provider === "youtube" && guestVerificationRequired)
        await verifyGuest(signal);
      signal.throwIfAborted();
      return api<PlaybackSource>(
        `stream?id=${encodeURIComponent(track.id)}&quality=${player.getSnapshot().quality}`,
        {
          signal,
        },
      );
    };
    const engine =
      transport === "studio"
        ? new NativeAudioEngine(player, resolve, listeningEvent, toast)
        : new BrowserAudioEngine(
            player,
            resolve,
            listeningEvent,
            toast,
            (track) =>
              api<Track[]>(`related?id=${encodeURIComponent(track.id)}`),
            setPlayback,
            acceptsWebAudio,
          );
    return () => engine.dispose();
  }, [
    player,
    listeningEvent,
    toast,
    transport,
    deferDevice,
    userId,
    guestVerificationRequired,
    verifyGuest,
  ]);
  const ensureAccount = useCallback(() => {
    if (data.user) return true;
    openAuth();
    return false;
  }, [data.user, openAuth]);
  const mutation = useCallback(
    async (path: string, method: string, payload?: unknown) => {
      if (!ensureAccount()) return false;
      const operation = captureOwner(userId);
      if (!operation) return false;
      try {
        await api(path, {
          method,
          headers: { "X-Aurelia-Account": operation.ownerId },
          ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        });
        if (!ownerCurrent(operation)) return false;
        await refresh();
        return ownerCurrent(operation);
      } catch (e) {
        operationError(e, operation, "Could not save");
        return false;
      }
    },
    [
      ensureAccount,
      refresh,
      userId,
      captureOwner,
      ownerCurrent,
      operationError,
    ],
  );
  const value = useMemo<AppContextValue>(
    () => ({
      data,
      loading,
      error,
      player,
      playback,
      toast,
      refresh,
      listeningEvent,
      ensureAccount,
      openAuth,
      setUser: (user) => {
        const previous = accountRef.current;
        // Invalidate first: synchronous player events/old effect cleanup must not write for the departing account.
        ownership.current.transition(user?.id ?? null);
        bindApiAccount(user?.id ?? null);
        accountRef.current = user?.id;
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setMessage("");
        setError(null);
        player.dispatch({ type: "pause" });
        if (previous && previous !== user?.id) {
          try {
            localStorage.removeItem(`aurelia.player.${previous}`);
            localStorage.removeItem(`aurelia.search.${previous}`);
          } catch {
            /* Private-mode storage may be unavailable. */
          }
        }
        if (previous !== user?.id)
          player.dispatch({ type: "restore", state: initialPlayer });
        setLoading(true);
        setData((d) => ({
          ...d,
          user,
          library: emptyLibrary,
          recommendations: [],
        }));
        void refresh();
      },
      mutation,
      like: async (track) => {
        const operation = captureOwner(userId);
        const liked = data.library?.likes.some((t) => t.id === track.id);
        if (
          (await mutation("library/likes", liked ? "DELETE" : "POST", {
            trackId: track.id,
          })) &&
          operation &&
          ownerCurrent(operation)
        )
          toast(
            liked
              ? "Removed from your liked songs"
              : "Saved to your liked songs",
          );
      },
      hide: async (track) => {
        const operation = captureOwner(userId);
        if (
          (await mutation("library/signals", "POST", {
            kind: "hide",
            trackId: track.id,
          })) &&
          operation &&
          ownerCurrent(operation)
        )
          toast("We’ll play less like this");
      },
      createPlaylist: async (name, description = "") => {
        if (!ensureAccount()) return null;
        const operation = captureOwner(userId);
        if (!operation) return null;
        try {
          const p = await api<{ id: string }>("library/playlists", {
            method: "POST",
            body: JSON.stringify({ name, description }),
            headers: { "X-Aurelia-Account": operation.ownerId },
          });
          if (!ownerCurrent(operation)) return null;
          await refresh();
          if (!ownerCurrent(operation)) return null;
          toast("Playlist created");
          return p.id;
        } catch (e) {
          operationError(e, operation, "Could not create playlist");
          return null;
        }
      },
      updatePlaylist: async (id, changes) => {
        const operation = captureOwner(userId);
        const saved = await mutation(
          `library/playlists/${id}`,
          "PATCH",
          changes,
        );
        if (!saved || !operation || !ownerCurrent(operation)) return false;
        toast("Playlist updated");
        return true;
      },
      reorderPlaylist: async (id, trackIds, expectedTrackIds) => {
        const operation = captureOwner(userId);
        const saved = await mutation(`library/playlists/${id}/order`, "PUT", {
          trackIds,
          expectedTrackIds,
        });
        if (!saved || !operation || !ownerCurrent(operation)) return false;
        toast("Playlist order saved");
        return true;
      },
      addTrack: async (playlist, track) => {
        const operation = captureOwner(userId);
        if (
          (await mutation(`library/playlists/${playlist.id}/tracks`, "POST", {
            trackId: track.id,
          })) &&
          operation &&
          ownerCurrent(operation)
        ) {
          toast(`Added to ${playlist.name}`);
          return true;
        }
        return false;
      },
    }),
    [
      data,
      loading,
      error,
      player,
      playback,
      toast,
      refresh,
      listeningEvent,
      ensureAccount,
      openAuth,
      mutation,
      userId,
      captureOwner,
      ownerCurrent,
      operationError,
    ],
  );
  return (
    <Context.Provider value={value}>
      {children}
      {guestDialog}
      {auth && (
        <AuthDialog
          onClose={() => setAuth(false)}
          returnFocusTo={authOpener.current}
        />
      )}
      <div
        role="status"
        aria-live="polite"
        className={`toast ${message ? "visible" : ""}`}
      >
        {message}
      </div>
    </Context.Provider>
  );
}
export function useApp() {
  const value = useContext(Context);
  if (!value) throw new Error("AppProvider missing");
  return value;
}
export function usePlayer() {
  const { player } = useApp();
  return useSyncExternalStore(
    player.subscribe,
    player.getSnapshot,
    player.getServerSnapshot,
  );
}
