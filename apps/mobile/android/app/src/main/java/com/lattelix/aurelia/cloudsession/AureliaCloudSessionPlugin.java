package com.lattelix.aurelia.cloudsession;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;
import okhttp3.Call;

/** Browser consent + private native bearer transport. No credential is returned across the bridge. */
@CapacitorPlugin(name = "AureliaCloudSession")
public final class AureliaCloudSessionPlugin extends Plugin {
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(32), runnable -> new Thread(runnable, "aurelia-cloud-session"), new ThreadPoolExecutor.AbortPolicy());
    private final ThreadPoolExecutor cancellation = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(4), runnable -> new Thread(runnable, "aurelia-cloud-cancel"), new ThreadPoolExecutor.DiscardOldestPolicy());
    private final Handler main = new Handler(Looper.getMainLooper());
    private final DeviceGrantState grants = new DeviceGrantState(SystemClock::elapsedRealtime);
    private final AtomicLong sessionEpoch = new AtomicLong();
    private volatile boolean destroyed;
    private CloudTokenStore store;
    private CloudHttp http;

    @Override public void load() { store = new CloudTokenStore(getContext()); http = new CloudHttp(); }

    @PluginMethod public void status(PluginCall call) {
        submit(call, () -> resolve(call, new JSObject().put("available", true).put("authenticated", store.read() != null)));
    }

    @PluginMethod public void beginSignIn(PluginCall call) {
        final long generation = grants.reset(); cancelCalls(true);
        submit(call, () -> {
            requireGrant(generation);
            String verifier = CloudPolicy.verifier();
            JSONObject body = new JSONObject().put("codeChallenge", CloudPolicy.challenge(verifier)).put("deviceName", "Aurelia for Android");
            CloudHttp.Result response = http.internal("auth/device/start", body, null);
            if (response.status != 200 && response.status != 201) throw new CloudFailure("cloud-sign-in-unavailable");
            JSONObject data = response.object();
            String code = text(data, "userCode", 9);
            String verification = CloudPolicy.verificationUri(text(data, "verificationUri", 512), code);
            String deviceCode = text(data, "deviceCode", 512);
            if (!CloudPolicy.validToken(deviceCode) || integer(data, "expiresIn") != 600 || integer(data, "interval") != 3)
                throw new CloudFailure("cloud-invalid-response");
            if (!grants.install(generation, deviceCode, verifier)) throw new CloudFailure("cloud-sign-in-cancelled");
            main.post(() -> {
                if (destroyed || !grants.current(generation)) { reject(call, "cloud-sign-in-cancelled"); return; }
                Activity activity = getActivity();
                if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                    grants.reset(); reject(call, "cloud-browser-unavailable"); return;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(verification));
                    intent.addCategory(Intent.CATEGORY_BROWSABLE);
                    activity.startActivity(intent);
                    resolve(call, new JSObject().put("userCode", code).put("verificationUri", verification).put("expiresIn", 600).put("interval", 3));
                } catch (Exception ignored) { grants.reset(); reject(call, "cloud-browser-unavailable"); }
            });
        });
    }

    @PluginMethod public void pollSignIn(PluginCall call) {
        // Reserving before queueing prevents a burst of JS calls from bypassing the minimum interval.
        DeviceGrantState.Poll poll = grants.poll();
        if (poll == null) { resolve(call, state("expired")); return; }
        if (poll.deviceCode == null) { resolve(call, state("pending")); return; }
        submit(call, () -> {
            requireGrant(poll.generation);
            if (!grants.canSend(poll)) { resolve(call, state("pending")); return; }
            JSONObject body = new JSONObject().put("deviceCode", poll.deviceCode).put("codeVerifier", poll.verifier);
            CloudHttp.Result response = http.internal("auth/device/token", body, null);
            requireGrant(poll.generation);
            if (response.status == 429) { grants.slowDown(poll.generation); resolve(call, state("pending")); return; }
            if (response.status == 400 || response.status == 410) { grants.reset(); resolve(call, state("expired")); return; }
            if (response.status != 200) throw new CloudFailure("cloud-sign-in-unavailable");
            JSONObject data = response.object(); String status = text(data, "status", 16);
            if (status.equals("pending")) { resolve(call, state("pending")); return; }
            if (status.equals("expired")) { grants.reset(); resolve(call, state("expired")); return; }
            if (!status.equals("approved")) throw new CloudFailure("cloud-invalid-response");
            String token = text(data, "token", 4096);
            if (!CloudPolicy.validToken(token)) throw new CloudFailure("cloud-invalid-response");
            JSObject user = account(data.opt("user")); long expiresIn = integer(data, "expiresIn");
            requireGrant(poll.generation); store.save(token, expiresIn);
            if (destroyed || !grants.current(poll.generation)) { store.clear(); throw new CloudFailure("cloud-sign-in-cancelled"); }
            sessionEpoch.incrementAndGet(); grants.reset();
            resolve(call, state("approved").put("user", user));
        });
    }

    @PluginMethod public void cancelSignIn(PluginCall call) { grants.reset(); cancelCalls(true); resolve(call, new JSObject()); }

    @PluginMethod public void signOut(PluginCall call) {
        grants.reset(); sessionEpoch.incrementAndGet(); cancelCalls(false);
        submit(call, () -> {
            boolean revoked = false;
            try {
                String token = store.read();
                if (token != null) { int status = http.internal("auth/logout", new JSONObject(), token).status; revoked = status >= 200 && status < 300; }
            } catch (Exception ignored) { /* Local logout remains unconditional after network/storage failure. */ }
            finally { store.clear(); }
            resolve(call, new JSObject().put("revoked", revoked));
        });
    }

    @PluginMethod public void request(PluginCall call) {
        final CloudPolicy.RequestSpec spec;
        final long epoch = sessionEpoch.get();
        try {
            Iterator<String> keys = call.getData().keys();
            while (keys.hasNext()) if (!Arrays.asList("path", "method", "body", "expectedAccountId").contains(keys.next())) throw new CloudFailure("cloud-invalid-request");
            spec = CloudPolicy.request(argument(call, "path", false), argument(call, "method", true) == null ? "GET" : argument(call, "method", true),
                argument(call, "body", true), argument(call, "expectedAccountId", true));
        } catch (Exception ignored) { reject(call, "cloud-invalid-request"); return; }
        submit(call, () -> {
            if (epoch != sessionEpoch.get()) throw new CloudFailure("cloud-session-changed");
            String token = store.read();
            CloudHttp.Result response = http.publicRequest(spec, token);
            if (epoch != sessionEpoch.get()) throw new CloudFailure("cloud-session-changed");
            if (response.status == 401 && token != null) { store.clear(); sessionEpoch.incrementAndGet(); }
            Object data = response.data;
            if (response.status < 200 || response.status >= 300)
                data = new JSObject().put("error", response.status == 401 ? "Sign in to continue." : "Cloud request failed.");
            resolve(call, new JSObject().put("status", response.status).put("data", data));
        });
    }

    private void requireGrant(long generation) throws CloudFailure {
        if (destroyed || !grants.current(generation)) throw new CloudFailure("cloud-sign-in-cancelled");
    }
    private static String argument(PluginCall call, String key, boolean optional) throws CloudFailure {
        Object value = call.getData().opt(key);
        if (optional && (value == null || value == JSONObject.NULL)) return null;
        if (!(value instanceof String)) throw new CloudFailure("cloud-invalid-request"); return (String) value;
    }
    private static String text(JSONObject object, String key, int max) throws CloudFailure {
        Object value = object.opt(key);
        if (!(value instanceof String) || ((String) value).isEmpty() || ((String) value).length() > max ||
            ((String) value).chars().anyMatch(c -> c < 0x20 || c == 0x7f)) throw new CloudFailure("cloud-invalid-response");
        return (String) value;
    }
    private static long integer(JSONObject object, String key) throws CloudFailure {
        Object value = object.opt(key);
        if (!(value instanceof Number)) throw new CloudFailure("cloud-invalid-response");
        long result = ((Number) value).longValue();
        if (((Number) value).doubleValue() != result) throw new CloudFailure("cloud-invalid-response"); return result;
    }
    private static JSObject account(Object value) throws CloudFailure {
        if (!(value instanceof JSONObject)) throw new CloudFailure("cloud-invalid-response");
        JSONObject object = (JSONObject) value;
        String id = text(object, "id", 36), name = text(object, "name", 160);
        if (!id.matches("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")) throw new CloudFailure("cloud-invalid-response");
        Object email = object.opt("email");
        if (email != JSONObject.NULL && (!(email instanceof String) || ((String) email).length() > 320 || ((String) email).chars().anyMatch(c -> c < 0x20)))
            throw new CloudFailure("cloud-invalid-response");
        Object identities = object.opt("identities");
        if (!(identities instanceof JSONArray) || ((JSONArray) identities).length() > 8) throw new CloudFailure("cloud-invalid-response");
        JSONArray clean = new JSONArray();
        for (int i = 0; i < ((JSONArray) identities).length(); i++) {
            Object identity = ((JSONArray) identities).opt(i);
            if (!(identity instanceof String) || !Arrays.asList("local", "google", "apple", "telegram").contains(identity)) throw new CloudFailure("cloud-invalid-response");
            clean.put(identity);
        }
        return new JSObject().put("id", id).put("name", name).put("email", email).put("identities", clean);
    }
    private static JSObject state(String value) { return new JSObject().put("status", value); }
    private void resolve(PluginCall call, JSObject value) { if (!destroyed) call.resolve(value); }
    private void reject(PluginCall call, String code) { if (!destroyed) call.reject("Aurelia cloud session is unavailable.", code); }
    private interface Work { void run() throws Exception; }
    private void submit(PluginCall call, Work work) {
        if (destroyed) { reject(call, "cloud-unavailable"); return; }
        try { worker.execute(() -> {
            if (destroyed) return;
            try { work.run(); }
            catch (CloudFailure failure) { reject(call, failure.code); }
            catch (Exception ignored) { reject(call, "cloud-client-unexpected"); }
        }); } catch (Exception ignored) { reject(call, "cloud-busy"); }
    }
    private void cancelCalls(boolean grantsOnly) {
        // Snapshot first: a delayed cancel must never cancel a subsequently started grant/logout.
        if (http == null) return;
        List<Call> active = http.snapshot(grantsOnly);
        try { cancellation.execute(() -> CloudHttp.cancel(active)); } catch (Exception ignored) { /* shutting down */ }
    }
    @Override protected void handleOnDestroy() {
        destroyed = true; grants.reset(); sessionEpoch.incrementAndGet(); worker.shutdownNow();
        try { cancellation.execute(() -> { if (http != null) http.close(); }); } catch (Exception ignored) { /* already closing */ }
        cancellation.shutdown(); super.handleOnDestroy();
    }
}
