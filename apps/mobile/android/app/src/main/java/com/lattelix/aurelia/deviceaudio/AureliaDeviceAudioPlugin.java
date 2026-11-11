package com.lattelix.aurelia.deviceaudio;

import android.content.ComponentName;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "AureliaDeviceAudio")
public final class AureliaDeviceAudioPlugin extends Plugin {
    private static final String DETACHED = "plugin-detached";
    private static final String OBSOLETE = "obsolete-request";
    private static final String CONNECTION_FAILED = "native-connection-failed";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ArrayList<PendingCommand> pending = new ArrayList<>();
    private final Set<PendingCommand> inFlight = new LinkedHashSet<>();
    private MediaController controller;
    private ListenableFuture<MediaController> controllerFuture;
    private long connectionGeneration;
    private long loadGeneration;
    private boolean destroyed;

    @Override
    public void load() {
        super.load();
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        boolean youtubeEnabled = NativeFeaturePolicy.youtubeEnabled();
        JSObject providerReasons = new JSObject();
        if (!youtubeEnabled) providerReasons.put("youtube", DeviceAudioException.SOURCE_UNVERIFIED);
        JSObject result = new JSObject();
        result.put("apiVersion", 1);
        result.put("transport", "device");
        result.put("nativeQueue", true);
        result.put("queueMutation", true);
        result.put("available", true);
        ArrayList<String> providers = new ArrayList<>(Collections.singletonList("studio"));
        if (youtubeEnabled) providers.add("youtube");
        result.put("supportedProviders", new JSONArray(providers));
        result.put("reason", JSONObject.NULL);
        result.put("providerReasons", providerReasons);
        result.put("coverage", youtubeEnabled ? "bundled-studio-and-native-youtube" : "bundled-studio-only");
        call.resolve(result);
    }

    @PluginMethod
    public void getSnapshot(PluginCall call) {
        mainHandler.post(() -> {
            if (call.getData().length() != 0) {
                reject(call, DeviceAudioException.INVALID_REQUEST);
                return;
            }
            enqueue(call, DeviceAudioCommands.GET_SNAPSHOT, Bundle.EMPTY, loadGeneration);
        });
    }

    @PluginMethod
    public void loadQueue(PluginCall call) {
        mainHandler.post(() -> {
            try {
                DeviceQueueRequest request = DeviceAudioValidator.loadRequest(
                    DeviceAudioBundleCodec.jsonObjectToMap(call.getData()), NativeFeaturePolicy.youtubeEnabled()
                );
                long generation = ++loadGeneration;
                rejectOlderGenerations(generation);
                enqueue(
                    call,
                    DeviceAudioCommands.LOAD_QUEUE,
                    DeviceAudioBundleCodec.loadRequestToBundle(request),
                    generation
                );
            } catch (DeviceAudioException error) {
                reject(call, error.code());
            }
        });
    }

    @PluginMethod
    public void mutateQueue(PluginCall call) {
        mainHandler.post(() -> {
            try {
                DeviceQueueMutation mutation = DeviceAudioValidator.mutationRequest(
                    DeviceAudioBundleCodec.jsonObjectToMap(call.getData()), NativeFeaturePolicy.youtubeEnabled()
                );
                enqueue(call, DeviceAudioCommands.MUTATE_QUEUE, DeviceAudioBundleCodec.mutationToBundle(mutation), loadGeneration);
            } catch (DeviceAudioException error) { reject(call, error.code()); }
        });
    }

    @PluginMethod
    public void play(PluginCall call) { revisionCommand(call, DeviceAudioCommands.PLAY); }

    @PluginMethod
    public void pause(PluginCall call) { revisionCommand(call, DeviceAudioCommands.PAUSE); }

    @PluginMethod
    public void stop(PluginCall call) { revisionCommand(call, DeviceAudioCommands.STOP); }

    @PluginMethod
    public void next(PluginCall call) { revisionCommand(call, DeviceAudioCommands.NEXT); }

    @PluginMethod
    public void previous(PluginCall call) { revisionCommand(call, DeviceAudioCommands.PREVIOUS); }

    @PluginMethod
    public void seek(PluginCall call) {
        mainHandler.post(() -> {
            try {
                Map<String, Object> value = DeviceAudioBundleCodec.jsonObjectToMap(call.getData());
                double position = DeviceAudioValidator.seekRequest(value);
                Bundle args = revisionBundle(DeviceAudioValidator.revision(value.get("revision")));
                args.putDouble("position", position);
                enqueue(call, DeviceAudioCommands.SEEK, args, loadGeneration);
            } catch (DeviceAudioException error) {
                reject(call, error.code());
            }
        });
    }

    @PluginMethod
    public void setRepeat(PluginCall call) {
        mainHandler.post(() -> {
            try {
                Map<String, Object> value = DeviceAudioBundleCodec.jsonObjectToMap(call.getData());
                String mode = DeviceAudioValidator.repeatRequest(value);
                Bundle args = revisionBundle(DeviceAudioValidator.revision(value.get("revision")));
                args.putString("mode", mode);
                enqueue(call, DeviceAudioCommands.SET_REPEAT, args, loadGeneration);
            } catch (DeviceAudioException error) {
                reject(call, error.code());
            }
        });
    }

    @PluginMethod
    public void setShuffle(PluginCall call) {
        mainHandler.post(() -> {
            try {
                Map<String, Object> value = DeviceAudioBundleCodec.jsonObjectToMap(call.getData());
                boolean enabled = DeviceAudioValidator.shuffleRequest(value);
                Bundle args = revisionBundle(DeviceAudioValidator.revision(value.get("revision")));
                args.putBoolean("enabled", enabled);
                enqueue(call, DeviceAudioCommands.SET_SHUFFLE, args, loadGeneration);
            } catch (DeviceAudioException error) {
                reject(call, error.code());
            }
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        mainHandler.post(() -> {
            try {
                Map<String, Object> value = DeviceAudioBundleCodec.jsonObjectToMap(call.getData());
                double volume = DeviceAudioValidator.volumeRequest(value);
                Bundle args = revisionBundle(DeviceAudioValidator.revision(value.get("revision")));
                args.putDouble("value", volume);
                enqueue(call, DeviceAudioCommands.SET_VOLUME, args, loadGeneration);
            } catch (DeviceAudioException error) {
                reject(call, error.code());
            }
        });
    }

    private void revisionCommand(PluginCall call, String action) {
        mainHandler.post(() -> {
            try {
                String revision = DeviceAudioValidator.revisionRequest(
                    DeviceAudioBundleCodec.jsonObjectToMap(call.getData())
                );
                enqueue(call, action, revisionBundle(revision), loadGeneration);
            } catch (DeviceAudioException error) {
                reject(call, error.code());
            }
        });
    }

    private void enqueue(PluginCall call, String action, Bundle args, long generation) {
        if (destroyed) {
            reject(call, DETACHED);
            return;
        }
        PendingCommand command = new PendingCommand(call, action, args, generation);
        if (controller == null) {
            pending.add(command);
            connect();
            return;
        }
        send(command);
    }

    private void connect() {
        if (destroyed || controller != null || controllerFuture != null) return;
        Context context = getContext().getApplicationContext();
        long generation = ++connectionGeneration;
        SessionToken token = new SessionToken(
            context,
            new ComponentName(context, AureliaDeviceAudioService.class)
        );
        ControllerListener listener = new ControllerListener(generation);
        ListenableFuture<MediaController> future = new MediaController.Builder(context, token)
            .setApplicationLooper(Looper.getMainLooper())
            .setListener(listener)
            .buildAsync();
        controllerFuture = future;
        Futures.addCallback(
            future,
            new FutureCallback<>() {
                @Override
                public void onSuccess(MediaController connected) {
                    if (destroyed || generation != connectionGeneration || controllerFuture != future) {
                        MediaController.releaseFuture(future);
                        return;
                    }
                    controller = connected;
                    ArrayList<PendingCommand> waiting = new ArrayList<>(pending);
                    pending.clear();
                    for (PendingCommand command : waiting) {
                        if (command.generation < loadGeneration) finishReject(command, OBSOLETE);
                        else send(command);
                    }
                }

                @Override
                public void onFailure(Throwable failure) {
                    if (generation != connectionGeneration || controllerFuture != future) return;
                    controllerFuture = null;
                    rejectAllPending(CONNECTION_FAILED);
                }
            },
            ContextCompat.getMainExecutor(context)
        );
    }

    private void send(PendingCommand command) {
        if (destroyed || command.completed) {
            finishReject(command, DETACHED);
            return;
        }
        if (command.generation < loadGeneration) {
            finishReject(command, OBSOLETE);
            return;
        }
        MediaController current = controller;
        if (current == null) {
            pending.add(command);
            connect();
            return;
        }
        inFlight.add(command);
        ListenableFuture<SessionResult> result = current.sendCustomCommand(
            DeviceAudioCommands.command(command.action),
            new Bundle(command.args)
        );
        command.future = result;
        Futures.addCallback(
            result,
            new FutureCallback<>() {
                @Override
                public void onSuccess(SessionResult value) {
                    inFlight.remove(command);
                    if (command.completed) return;
                    if (destroyed) {
                        finishReject(command, DETACHED);
                        return;
                    }
                    if (command.generation < loadGeneration) {
                        finishReject(command, OBSOLETE);
                        return;
                    }
                    if (value.resultCode != SessionResult.RESULT_SUCCESS) {
                        String code = value.extras.getString("errorCode", DeviceAudioException.UNAVAILABLE);
                        finishReject(command, sanitizeCode(code));
                        return;
                    }
                    try {
                        JSObject snapshot = DeviceAudioBundleCodec.snapshotBundleToJs(value.extras);
                        command.completed = true;
                        command.call.resolve(snapshot);
                    } catch (DeviceAudioException error) {
                        finishReject(command, DeviceAudioException.UNAVAILABLE);
                    }
                }

                @Override
                public void onFailure(Throwable failure) {
                    inFlight.remove(command);
                    finishReject(command, destroyed ? DETACHED : CONNECTION_FAILED);
                }
            },
            ContextCompat.getMainExecutor(getContext())
        );
    }

    private void rejectOlderGenerations(long generation) {
        Iterator<PendingCommand> waiting = pending.iterator();
        while (waiting.hasNext()) {
            PendingCommand command = waiting.next();
            if (command.generation < generation) {
                waiting.remove();
                finishReject(command, OBSOLETE);
            }
        }
        for (PendingCommand command : new ArrayList<>(inFlight)) {
            if (command.generation < generation) {
                inFlight.remove(command);
                finishReject(command, OBSOLETE);
            }
        }
    }

    private void rejectAllPending(String code) {
        for (PendingCommand command : new ArrayList<>(pending)) finishReject(command, code);
        pending.clear();
        for (PendingCommand command : new ArrayList<>(inFlight)) finishReject(command, code);
        inFlight.clear();
    }

    private void finishReject(PendingCommand command, String code) {
        if (command.completed) return;
        command.completed = true;
        if (command.future != null) command.future.cancel(false);
        reject(command.call, code);
    }

    private static Bundle revisionBundle(String revision) {
        Bundle args = new Bundle();
        args.putString("revision", revision);
        return args;
    }

    private static String sanitizeCode(String code) {
        return switch (code) {
            case DeviceAudioException.INVALID_REQUEST,
                DeviceAudioException.SOURCE_UNVERIFIED,
                DeviceAudioException.UNAVAILABLE,
                DeviceAudioException.STALE_REVISION,
                DeviceAudioException.PLAYBACK_FAILED -> code;
            default -> DeviceAudioException.UNAVAILABLE;
        };
    }

    private static void reject(PluginCall call, String code) {
        call.reject(code, code);
    }

    @Override
    protected void handleOnDestroy() {
        Runnable cleanup = () -> {
            if (destroyed) return;
            destroyed = true;
            connectionGeneration++;
            rejectAllPending(DETACHED);
            controller = null;
            if (controllerFuture != null) {
                MediaController.releaseFuture(controllerFuture);
                controllerFuture = null;
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) cleanup.run();
        else mainHandler.post(cleanup);
        super.handleOnDestroy();
    }

    private final class ControllerListener implements MediaController.Listener {
        private final long generation;

        private ControllerListener(long generation) {
            this.generation = generation;
        }

        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
            MediaController source,
            SessionCommand command,
            Bundle args
        ) {
            if (
                !destroyed
                    && generation == connectionGeneration
                    && DeviceAudioCommands.SNAPSHOT_EVENT.equals(command.customAction)
            ) {
                try {
                    JSObject snapshot = DeviceAudioBundleCodec.snapshotBundleToJs(args);
                    notifyListeners("snapshot", snapshot, true);
                } catch (DeviceAudioException ignored) {
                    // Invalid native data is dropped without exposing it to the WebView.
                }
            }
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }

        @Override
        public void onDisconnected(MediaController disconnected) {
            if (generation != connectionGeneration || controller != disconnected) return;
            controller = null;
            controllerFuture = null;
            rejectAllPending(CONNECTION_FAILED);
        }
    }

    private static final class PendingCommand {
        private final PluginCall call;
        private final String action;
        private final Bundle args;
        private final long generation;
        private ListenableFuture<SessionResult> future;
        private boolean completed;

        private PendingCommand(PluginCall call, String action, Bundle args, long generation) {
            this.call = call;
            this.action = action;
            this.args = args;
            this.generation = generation;
        }
    }
}
