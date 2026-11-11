package com.lattelix.aurelia.deviceaudio;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionResult;
import com.lattelix.aurelia.BuildConfig;
import com.lattelix.aurelia.source.AndroidYouTubeSourceFactory;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Owns the Activity-independent player and queue; process recreation restores paused. */
@OptIn(markerClass = UnstableApi.class)
public final class AureliaDeviceAudioService extends MediaSessionService {
    private static final long PROGRESS_INTERVAL_MS = 500;
    private static final long PERSIST_INTERVAL_MS = 2_000;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static final String NOTIFICATION_CHANNEL = "aurelia-playback-silent-v1";
    private final DeviceVolumePolicy volumePolicy = new DeviceVolumePolicy(NativeFeaturePolicy.silentQa());
    private final DeviceAudioState state = new DeviceAudioState(NativeFeaturePolicy.silentQa());
    private final DevicePlaybackGeneration generations = new DevicePlaybackGeneration();
    private DevicePlaybackGeneration.QueueToken queueToken;
    private AndroidYouTubeSourceFactory youtubeSources;
    private ExoPlayer player;
    private MediaSession session;
    private DeviceAudioPersistence persistence;
    private boolean suppressPlayerEvents;
    private boolean persistScheduled;
    // Ephemeral debug QA metadata, never part of the public snapshot/persistence codec.
    private String qaSourceFailureCode;
    private Integer qaMedia3ErrorCode;

    private final Runnable progress = new Runnable() {
        @Override
        public void run() {
            if (player != null && player.isPlaying()) synchronizeAndPublish();
            mainHandler.postDelayed(this, PROGRESS_INTERVAL_MS);
        }
    };

    private final Runnable persist = () -> {
        persistScheduled = false;
        if (persistence != null) persistence.save(state.restoreRequest());
    };

    @Override
    public void onCreate() {
        super.onCreate();
        configureSilentNotification();
        player = createPlayer(null);
        persistence = new DeviceAudioPersistence(this);
        restorePausedQueue();
        session = new MediaSession.Builder(this, new SessionPlayer(player, queueToken))
            .setCallback(new SessionCallback())
            .build();
        mainHandler.postDelayed(progress, PROGRESS_INTERVAL_MS);
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onDestroy() {
        mainHandler.removeCallbacks(progress);
        mainHandler.removeCallbacks(persist);
        persistScheduled = false;
        if (persistence != null) persistence.save(state.restoreRequest());
        generations.invalidate();
        closeYouTubeSources();
        if (session != null) {
            session.release();
            session = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    private void restorePausedQueue() {
        DeviceQueueRequest stored = persistence.restore();
        if (stored == null) return;
        try {
            state.restorePaused(stored, "restore-" + UUID.randomUUID());
            applyPlayerQueue(state.restoreRequest());
        } catch (Exception error) {
            abandonFailedPlayer();
            persistence.clear();
            try {
                state.stop("superseded-" + UUID.randomUUID());
            } catch (DeviceAudioException impossible) {
                throw new IllegalStateException(impossible);
            }
        }
    }

    private void loadQueue(DeviceQueueRequest request) {
        clearQaFailureDiagnostic();
        state.replace(request);
        try {
            applyPlayerQueue(request);
        } catch (RuntimeException error) {
            abandonFailedPlayer();
            state.fail(DeviceAudioException.PLAYBACK_FAILED);
        }
        publish();
    }

    private ExoPlayer createPlayer(DevicePlaybackGeneration.QueueToken token) {
        clearQaFailureDiagnostic();
        ExoPlayer created = new ExoPlayer.Builder(this).setWakeMode(C.WAKE_MODE_LOCAL).build();
        // Set app volume before the player has a source or can prepare/play.
        created.setVolume((float) volumePolicy.clamp(state.snapshot().volume()));
        created.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true);
        created.setHandleAudioBecomingNoisy(true);
        PlaybackListener listener = new PlaybackListener(created, token);
        created.addListener(listener);
        created.addAnalyticsListener(listener);
        return created;
    }

    private static boolean qaDiagnosticsEnabled() {
        return BuildConfig.DEBUG && NativeFeaturePolicy.silentQa();
    }

    private void clearQaFailureDiagnostic() {
        qaSourceFailureCode = null;
        qaMedia3ErrorCode = null;
    }

    private void configureSilentNotification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                NOTIFICATION_CHANNEL, "Aurelia playback", NotificationManager.IMPORTANCE_LOW);
            channel.setSound(null, null);
            channel.enableVibration(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(channel);
        }
        setMediaNotificationProvider(new SilentMediaNotificationProvider(this, NOTIFICATION_CHANNEL));
    }

    private void closeYouTubeSources() {
        AndroidYouTubeSourceFactory previous = youtubeSources;
        youtubeSources = null;
        if (previous == null) return;
        try { previous.cancelAll(); } catch (RuntimeException ignored) { /* sanitized teardown */ }
        try { previous.close(); } catch (RuntimeException ignored) { /* sanitized teardown */ }
    }

    private void abandonFailedPlayer() {
        generations.invalidate();
        closeYouTubeSources();
        suppressPlayerEvents = true;
        try { player.pause(); player.stop(); player.clearMediaItems(); }
        finally { suppressPlayerEvents = false; }
    }

    private void applyPlayerQueue(DeviceQueueRequest request) {
        suppressPlayerEvents = true;
        try {
            // Revisions may be reused: actual player/source ownership is an identity fence.
            queueToken = generations.replace(request);
            closeYouTubeSources();
            ExoPlayer previous = player;
            player = createPlayer(queueToken);
            if (session != null) session.setPlayer(new SessionPlayer(player, queueToken));
            if (previous != null) previous.release();
            player.setRepeatMode(toPlayerRepeat(request.repeat()));
            player.setShuffleModeEnabled(request.shuffle());
            player.setVolume((float) volumePolicy.clamp(request.volume()));
            if (request.tracks().isEmpty()) return;
            List<MediaSource> sources = new ArrayList<>(request.tracks().size());
            DefaultMediaSourceFactory studioSources = new DefaultMediaSourceFactory(this);
            for (DeviceQueueEntry entry : request.tracks()) {
                MediaItem item = toMediaItem(entry, generations.beginAttempt(queueToken, entry.entryId()));
                if ("youtube".equals(entry.provider())) {
                    if (!NativeFeaturePolicy.youtubeEnabled()) throw new IllegalStateException("source-disabled");
                    if (youtubeSources == null) youtubeSources = new AndroidYouTubeSourceFactory(this);
                    sources.add(youtubeSources.create(item, entry.externalId()));
                } else {
                    sources.add(studioSources.createMediaSource(item));
                }
            }
            player.setMediaSources(sources, request.index(), secondsToMilliseconds(request.position()));
            // A paused queue (including process restore) must not start a resolver or network I/O.
            if (generations.playRequested(queueToken)) {
                player.setVolume((float) volumePolicy.clamp(state.snapshot().volume()));
                player.prepare();
                player.play();
            } else player.pause();
        } finally {
            suppressPlayerEvents = false;
        }
    }

    private MediaItem toMediaItem(DeviceQueueEntry entry, DevicePlaybackGeneration.Attempt attempt) {
        MediaMetadata metadata = new MediaMetadata.Builder()
            .setTitle(entry.title()).setArtist(entry.artist()).build();
        return new MediaItem.Builder()
            .setMediaId(entry.entryId().toString())
            .setUri("youtube".equals(entry.provider())
                ? "aurelia-youtube://track/" + entry.externalId() : StudioCatalogue.assetUri(entry.externalId()))
            .setTag(attempt)
            .setMediaMetadata(metadata)
            .build();
    }

    private void mutateQueue(DeviceQueueMutation mutation) throws DeviceAudioException {
        state.validateMutation(mutation);
        if (!generations.accepts(queueToken) || !queueToken.revision().equals(mutation.expectedRevision()))
            throw new DeviceAudioException(DeviceAudioException.STALE_REVISION);
        // Capture the actual native current occurrence/position, including an autonomous next.
        synchronizeAndPublish();
        state.validateMutation(mutation);
        List<DeviceQueueMutation.Edit> edits = mutation.edits(state.snapshot().queue());
        suppressPlayerEvents = true;
        try {
            state.mutate(mutation);
            generations.mutate(queueToken, mutation);
            for (DeviceQueueMutation.Edit edit : edits) {
                if ("remove".equals(edit.kind)) player.removeMediaItem(edit.index);
                else if ("move".equals(edit.kind)) player.moveMediaItem(edit.index, edit.target);
                else {
                    DeviceQueueEntry entry = mutation.tracks().get(edit.index);
                    MediaItem item = toMediaItem(entry, generations.beginAttempt(queueToken, entry.entryId()));
                    MediaSource source;
                    if ("youtube".equals(entry.provider())) {
                        if (youtubeSources == null) youtubeSources = new AndroidYouTubeSourceFactory(this);
                        source = youtubeSources.create(item, entry.externalId());
                    } else source = new DefaultMediaSourceFactory(this).createMediaSource(item);
                    player.addMediaSource(edit.index, source);
                }
            }
            for (int i = 0; i < mutation.tracks().size(); i++) {
                DeviceQueueEntry entry = mutation.tracks().get(i);
                MediaItem item = player.getMediaItemAt(i);
                if (!entry.title().contentEquals(item.mediaMetadata.title == null ? "" : item.mediaMetadata.title) ||
                    !entry.artist().contentEquals(item.mediaMetadata.artist == null ? "" : item.mediaMetadata.artist))
                    player.replaceMediaItem(i, item.buildUpon().setMediaMetadata(new MediaMetadata.Builder()
                        .setTitle(entry.title()).setArtist(entry.artist()).build()).build());
            }
            // Queue edits are never a prepare/play intent, including paused restores.
            if (!generations.playRequested(queueToken)) player.pause();
        } finally { suppressPlayerEvents = false; }
        synchronizeAndPublish();
        publish();
    }

    private boolean currentAttempt(ExoPlayer source, DevicePlaybackGeneration.QueueToken token) {
        if (source != player || !generations.accepts(token)) return false;
        return generations.accepts(attemptTag(source.getCurrentMediaItem()));
    }

    private static DevicePlaybackGeneration.Attempt attemptTag(MediaItem item) {
        if (item == null || item.localConfiguration == null
            || !(item.localConfiguration.tag instanceof DevicePlaybackGeneration.Attempt)) return null;
        return (DevicePlaybackGeneration.Attempt) item.localConfiguration.tag;
    }

    private void synchronizeAndPublish() {
        if (suppressPlayerEvents || player == null || !currentAttempt(player, queueToken)) return;
        player.setVolume((float) volumePolicy.clamp(player.getVolume()));
        DeviceAudioSnapshot before = state.snapshot();
        if (before.queue().isEmpty()) return;
        // A late idle event must not erase a decoding failure. A trusted system
        // controller may explicitly prepare the player again without a JS command.
        if ("failed".equals(before.status())) {
            if (player.getPlayerError() != null || player.getPlaybackState() == Player.STATE_IDLE) return;
            try {
                state.play(before.revision());
            } catch (DeviceAudioException stale) {
                return;
            }
        }
        int index = player.getCurrentMediaItemIndex();
        String status;
        if (player.isPlaying()) status = "playing";
        else if (player.getPlaybackState() == Player.STATE_ENDED) status = "ended";
        else if (!player.getPlayWhenReady() && !generations.playRequested(queueToken)) status = "paused";
        else if (player.getPlaybackState() == Player.STATE_BUFFERING) status = "loading";
        else status = "paused";
        state.synchronize(
            index,
            millisecondsToSeconds(player.getCurrentPosition()),
            millisecondsToSeconds(player.getDuration()),
            status
        );
        state.synchronizeControls(
            fromPlayerRepeat(player.getRepeatMode()),
            player.getShuffleModeEnabled(),
            player.getVolume()
        );
        publish();
    }

    private void resumeOwnedQueue(String revision) throws DeviceAudioException {
        state.requireRevision(revision);
        if (state.snapshot().queue().isEmpty()) return;
        suppressPlayerEvents = true;
        try {
            boolean rebuild = !generations.accepts(queueToken)
                || player.getPlaybackState() == Player.STATE_IDLE || player.getPlayerError() != null;
            state.play(revision);
            if (rebuild) {
                DeviceQueueRequest stored = state.restoreRequest();
                applyPlayerQueue(new DeviceQueueRequest(stored.ownerId(), stored.revision(), stored.tracks(),
                    stored.index(), stored.position(), true, stored.repeat(), stored.shuffle(), stored.volume()));
            } else {
                generations.setPlayRequested(queueToken, true);
                player.setVolume((float) volumePolicy.clamp(state.snapshot().volume()));
                if (player.getPlaybackState() == Player.STATE_ENDED) player.seekToDefaultPosition();
                player.play();
            }
        } finally {
            suppressPlayerEvents = false;
        }
        synchronizeAndPublish();
    }

    private enum Navigation { NEXT_ITEM, PREVIOUS_ITEM, NEXT, PREVIOUS }

    private void navigateOwnedQueue(String revision, Navigation navigation) throws DeviceAudioException {
        DeviceQueueNavigation.navigate(state, revision, new DeviceQueueNavigation.Playback() {
            @Override
            public int targetIndex() {
                if (navigation == Navigation.NEXT || navigation == Navigation.NEXT_ITEM)
                    return player.getNextMediaItemIndex();
                int previous = player.getPreviousMediaItemIndex();
                if (navigation == Navigation.PREVIOUS && (previous == C.INDEX_UNSET
                    || player.getCurrentPosition() > player.getMaxSeekToPreviousPosition()))
                    return player.getCurrentMediaItemIndex();
                return previous;
            }

            @Override
            public boolean requiresRebuild() {
                return !generations.accepts(queueToken) || "failed".equals(state.snapshot().status())
                    || player.getPlaybackState() == Player.STATE_IDLE || player.getPlayerError() != null;
            }

            @Override
            public boolean playRequested() {
                // Audio focus/noisy-route handling may pause Media3 without a JS command.
                // A stale generation intent must not resume such a paused player on Next.
                return generations.playRequested(queueToken) && player.getPlayWhenReady();
            }

            @Override
            public void seek() {
                switch (navigation) {
                    case NEXT_ITEM: player.seekToNextMediaItem(); break;
                    case PREVIOUS_ITEM: player.seekToPreviousMediaItem(); break;
                    case NEXT: player.seekToNext(); break;
                    case PREVIOUS: player.seekToPrevious(); break;
                }
            }

            @Override
            public void replaceQueue(DeviceQueueRequest request) { applyPlayerQueue(request); }

            @Override
            public void synchronize() { synchronizeAndPublish(); }
        });
    }

    private void pauseOwnedQueue() throws DeviceAudioException {
        state.pause(state.snapshot().revision());
        generations.setPlayRequested(queueToken, false);
        player.pause();
        synchronizeAndPublish();
    }

    private void stopPlayerSources() {
        // System Stop also cancels resolver/loader work, while retaining the owned paused queue.
        synchronizeAndPublish();
        try { state.pause(state.snapshot().revision()); } catch (DeviceAudioException ignored) { }
        generations.invalidate();
        closeYouTubeSources();
        player.pause();
        player.stop();
        publish();
    }

    private void publish() {
        DeviceAudioSnapshot snapshot = state.snapshot();
        schedulePersistence();
        if (session == null) return;
        Bundle bundle = DeviceAudioBundleCodec.snapshotToBundle(snapshot);
        for (MediaSession.ControllerInfo controller : session.getConnectedControllers()) {
            if (isOwnController(controller)) {
                session.sendCustomCommand(
                    controller,
                    DeviceAudioCommands.command(DeviceAudioCommands.SNAPSHOT_EVENT),
                    new Bundle(bundle)
                );
            }
        }
    }

    private void schedulePersistence() {
        if (persistScheduled) return;
        persistScheduled = true;
        mainHandler.postDelayed(persist, PERSIST_INTERVAL_MS);
    }

    private boolean isOwnController(MediaSession.ControllerInfo controller) {
        return controller.getUid() == Process.myUid()
            && getPackageName().equals(controller.getPackageName());
    }

    private SessionResult executeCustomCommand(String action, Bundle args) {
        try {
            Map<String, Object> value = DeviceAudioBundleCodec.bundleToMap(args);
            switch (action) {
                case DeviceAudioCommands.GET_SNAPSHOT:
                    if (!value.isEmpty()) throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
                    break;
                case DeviceAudioCommands.LOAD_QUEUE:
                    loadQueue(DeviceAudioValidator.loadRequest(value, NativeFeaturePolicy.youtubeEnabled()));
                    break;
                case DeviceAudioCommands.MUTATE_QUEUE:
                    mutateQueue(DeviceAudioValidator.mutationRequest(value, NativeFeaturePolicy.youtubeEnabled()));
                    break;
                case DeviceAudioCommands.PLAY: {
                    String revision = DeviceAudioValidator.revisionRequest(value);
                    resumeOwnedQueue(revision);
                    break;
                }
                case DeviceAudioCommands.PAUSE: {
                    String revision = DeviceAudioValidator.revisionRequest(value);
                    state.pause(revision);
                    generations.setPlayRequested(queueToken, false);
                    player.pause();
                    synchronizeAndPublish();
                    break;
                }
                case DeviceAudioCommands.SEEK: {
                    String revision = DeviceAudioValidator.revision(value.get("revision"));
                    double position = DeviceAudioValidator.seekRequest(value);
                    state.seek(revision, position);
                    player.seekTo(secondsToMilliseconds(position));
                    publish();
                    break;
                }
                case DeviceAudioCommands.SET_REPEAT: {
                    String revision = DeviceAudioValidator.revision(value.get("revision"));
                    String repeat = DeviceAudioValidator.repeatRequest(value);
                    state.setRepeat(revision, repeat);
                    player.setRepeatMode(toPlayerRepeat(repeat));
                    publish();
                    break;
                }
                case DeviceAudioCommands.SET_SHUFFLE: {
                    String revision = DeviceAudioValidator.revision(value.get("revision"));
                    boolean enabled = DeviceAudioValidator.shuffleRequest(value);
                    state.setShuffle(revision, enabled);
                    player.setShuffleModeEnabled(enabled);
                    publish();
                    break;
                }
                case DeviceAudioCommands.SET_VOLUME: {
                    String revision = DeviceAudioValidator.revision(value.get("revision"));
                    double volume = DeviceAudioValidator.volumeRequest(value);
                    state.setVolume(revision, volume);
                    player.setVolume((float) volumePolicy.clamp(volume));
                    publish();
                    break;
                }
                case DeviceAudioCommands.NEXT: {
                    String revision = DeviceAudioValidator.revisionRequest(value);
                    navigateOwnedQueue(revision, Navigation.NEXT_ITEM);
                    break;
                }
                case DeviceAudioCommands.PREVIOUS: {
                    String revision = DeviceAudioValidator.revisionRequest(value);
                    navigateOwnedQueue(revision, Navigation.PREVIOUS_ITEM);
                    break;
                }
                case DeviceAudioCommands.STOP: {
                    String revision = DeviceAudioValidator.revisionRequest(value);
                    state.requireStopRevision(revision);
                    state.stop("superseded-" + UUID.randomUUID());
                    generations.invalidate();
                    closeYouTubeSources();
                    suppressPlayerEvents = true;
                    try {
                        player.stop();
                        player.clearMediaItems();
                    } finally {
                        suppressPlayerEvents = false;
                    }
                    persistence.clear();
                    publish();
                    break;
                }
                default:
                    return errorResult(DeviceAudioException.UNAVAILABLE, SessionResult.RESULT_ERROR_NOT_SUPPORTED);
            }
            Bundle result = DeviceAudioBundleCodec.snapshotToBundle(state.snapshot());
            if (DeviceAudioCommands.GET_SNAPSHOT.equals(action) && qaDiagnosticsEnabled()
                && "failed".equals(state.snapshot().status())
                && qaSourceFailureCode != null && qaMedia3ErrorCode != null) {
                result.putString("qaSourceFailureCode", qaSourceFailureCode);
                result.putInt("qaMedia3ErrorCode", qaMedia3ErrorCode);
            }
            return new SessionResult(SessionResult.RESULT_SUCCESS, result);
        } catch (DeviceAudioException error) {
            int result = DeviceAudioException.STALE_REVISION.equals(error.code())
                ? SessionResult.RESULT_ERROR_INVALID_STATE
                : SessionResult.RESULT_ERROR_BAD_VALUE;
            return errorResult(error.code(), result);
        } catch (RuntimeException error) {
            abandonFailedPlayer();
            state.fail(DeviceAudioException.PLAYBACK_FAILED);
            publish();
            return new SessionResult(
                SessionResult.RESULT_SUCCESS,
                DeviceAudioBundleCodec.snapshotToBundle(state.snapshot())
            );
        }
    }

    private static SessionResult errorResult(String code, int resultCode) {
        Bundle extras = new Bundle();
        extras.putString("errorCode", code);
        return new SessionResult(resultCode, extras);
    }

    private static int toPlayerRepeat(String repeat) {
        if ("one".equals(repeat)) return Player.REPEAT_MODE_ONE;
        if ("all".equals(repeat)) return Player.REPEAT_MODE_ALL;
        return Player.REPEAT_MODE_OFF;
    }

    private static String fromPlayerRepeat(int repeat) {
        if (repeat == Player.REPEAT_MODE_ONE) return "one";
        if (repeat == Player.REPEAT_MODE_ALL) return "all";
        return "off";
    }

    private static long secondsToMilliseconds(double seconds) {
        return Math.round(Math.max(0, Math.min(86400, seconds)) * 1000);
    }

    private static double millisecondsToSeconds(long milliseconds) {
        if (milliseconds == C.TIME_UNSET || milliseconds < 0) return 0;
        return Math.min(86400, milliseconds / 1000.0);
    }

    private final class PlaybackListener implements Player.Listener, AnalyticsListener {
        private final ExoPlayer source;
        private final DevicePlaybackGeneration.QueueToken token;

        private PlaybackListener(ExoPlayer source, DevicePlaybackGeneration.QueueToken token) {
            this.source = source;
            this.token = token;
        }

        @Override
        public void onEvents(Player ignored, Player.Events events) {
            if (currentAttempt(source, token)) synchronizeAndPublish();
        }

        @Override
        public void onPlayerError(AnalyticsListener.EventTime eventTime, PlaybackException error) {
            if (suppressPlayerEvents || !currentAttempt(source, token)) return;
            if (eventTime.windowIndex < 0 || eventTime.windowIndex >= eventTime.timeline.getWindowCount()) return;
            MediaItem failedItem = eventTime.timeline.getWindow(eventTime.windowIndex, new Timeline.Window()).mediaItem;
            if (!generations.acceptsEvent(attemptTag(failedItem), attemptTag(source.getCurrentMediaItem()))) return;
            if (qaDiagnosticsEnabled()) {
                try { qaSourceFailureCode = AndroidYouTubeSourceFactory.diagnosticFailureCode(error); }
                catch (RuntimeException ignored) { qaSourceFailureCode = "DIAGNOSTIC_UNKNOWN"; }
                qaMedia3ErrorCode = error.errorCode;
            }
            // Never pass resolver exceptions, response data, or signed URLs across the bridge.
            state.fail(DeviceAudioException.PLAYBACK_FAILED);
            publish();
        }
    }

    /** System transport uses the same ownership/volume policy as the ID-only bridge. */
    private final class SessionPlayer extends ForwardingPlayer {
        private final ExoPlayer source;
        private final DevicePlaybackGeneration.QueueToken token;

        private SessionPlayer(ExoPlayer source, DevicePlaybackGeneration.QueueToken token) {
            super(source);
            this.source = source;
            this.token = token;
        }

        private boolean current() { return source == player && token == queueToken; }

        @Override
        public void setVolume(float volume) {
            if (current()) super.setVolume((float) volumePolicy.clamp(volume));
        }

        @Override
        public void mute() {
            if (!current()) return;
            super.mute();
            source.setVolume((float) volumePolicy.clamp(source.getVolume()));
        }

        @Override
        public void unmute() {
            if (!current()) return;
            if (NativeFeaturePolicy.silentQa()) source.setVolume(0);
            else super.unmute();
        }

        @Override
        public void prepare() {
            if (!current() || !generations.accepts(token) || state.snapshot().queue().isEmpty()) return;
            // Failed attempts are replaced only by explicit Play, which creates a new fence/factory.
            if (source.getPlayerError() != null || "failed".equals(state.snapshot().status())) return;
            source.setVolume((float) volumePolicy.clamp(state.snapshot().volume()));
            // Explicit trusted Prepare may load data, but does not set playWhenReady.
            source.prepare();
        }

        @Override
        public void play() {
            if (!current()) return;
            try { resumeOwnedQueue(state.snapshot().revision()); }
            catch (DeviceAudioException ignored) { /* no unowned playback */ }
            catch (RuntimeException error) { abandonFailedPlayer(); state.fail(DeviceAudioException.PLAYBACK_FAILED); publish(); }
        }

        @Override
        public void setPlayWhenReady(boolean playing) { if (playing) play(); else pause(); }

        @Override
        public void pause() {
            if (!current()) return;
            try { pauseOwnedQueue(); } catch (DeviceAudioException ignored) { }
        }

        @Override
        public void stop() { if (current()) stopPlayerSources(); }

        private void navigate(Navigation navigation) {
            if (!current()) return;
            try { navigateOwnedQueue(state.snapshot().revision(), navigation); }
            catch (DeviceAudioException ignored) { /* no unowned navigation */ }
            catch (RuntimeException error) { abandonFailedPlayer(); state.fail(DeviceAudioException.PLAYBACK_FAILED); publish(); }
        }

        @Override
        public void seekToNextMediaItem() { navigate(Navigation.NEXT_ITEM); }

        @Override
        public void seekToPreviousMediaItem() { navigate(Navigation.PREVIOUS_ITEM); }

        @Override
        public void seekToNext() { navigate(Navigation.NEXT); }

        @Override
        public void seekToPrevious() { navigate(Navigation.PREVIOUS); }
    }

    @OptIn(markerClass = UnstableApi.class)
    private final class SessionCallback implements MediaSession.Callback {
        @Override
        public MediaSession.ConnectionResult onConnect(
            MediaSession mediaSession,
            MediaSession.ControllerInfo controller
        ) {
            if (!isOwnController(controller) && !controller.isTrusted()) {
                return MediaSession.ConnectionResult.reject();
            }
            SessionCommands commands = isOwnController(controller)
                ? DeviceAudioCommands.ownSessionCommands()
                : new SessionCommands.Builder().build();
            return MediaSession.ConnectionResult.accept(commands, transportAndReadCommands());
        }

        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
            MediaSession mediaSession,
            MediaSession.ControllerInfo controller,
            androidx.media3.session.SessionCommand command,
            Bundle args
        ) {
            if (!isOwnController(controller)) {
                return Futures.immediateFuture(
                    errorResult(DeviceAudioException.UNAVAILABLE, SessionResult.RESULT_ERROR_PERMISSION_DENIED)
                );
            }
            return Futures.immediateFuture(executeCustomCommand(command.customAction, args));
        }

        @Override
        public ListenableFuture<List<MediaItem>> onAddMediaItems(
            MediaSession mediaSession,
            MediaSession.ControllerInfo controller,
            List<MediaItem> mediaItems
        ) {
            return Futures.immediateFailedFuture(new SecurityException("queue-mutation-not-allowed"));
        }

        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(
            MediaSession mediaSession,
            MediaSession.ControllerInfo controller,
            List<MediaItem> mediaItems,
            int startIndex,
            long startPositionMs
        ) {
            return Futures.immediateFailedFuture(new SecurityException("queue-replacement-not-allowed"));
        }

        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(
            MediaSession mediaSession,
            MediaSession.ControllerInfo controller,
            boolean isForPlayback
        ) {
            return Futures.immediateFailedFuture(new UnsupportedOperationException("resumption-input-not-allowed"));
        }
    }

    @OptIn(markerClass = UnstableApi.class)
    private static Player.Commands transportAndReadCommands() {
        return new Player.Commands.Builder()
            .add(Player.COMMAND_PLAY_PAUSE)
            .add(Player.COMMAND_PREPARE)
            .add(Player.COMMAND_STOP)
            .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_TO_NEXT)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            .add(Player.COMMAND_SEEK_TO_PREVIOUS)
            .add(Player.COMMAND_SEEK_BACK)
            .add(Player.COMMAND_SEEK_FORWARD)
            .add(Player.COMMAND_SET_REPEAT_MODE)
            .add(Player.COMMAND_SET_SHUFFLE_MODE)
            .add(Player.COMMAND_GET_CURRENT_MEDIA_ITEM)
            .add(Player.COMMAND_GET_TIMELINE)
            .add(Player.COMMAND_GET_METADATA)
            .add(Player.COMMAND_GET_AUDIO_ATTRIBUTES)
            .add(Player.COMMAND_GET_VOLUME)
            .build();
    }
}
