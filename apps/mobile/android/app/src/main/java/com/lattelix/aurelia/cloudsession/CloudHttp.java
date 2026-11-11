package com.lattelix.aurelia.cloudsession;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.Set;
import java.util.Collections;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import okhttp3.Authenticator;
import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/** All methods that touch sockets are invoked exclusively on owned worker threads. */
final class CloudHttp {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private final OkHttpClient client;
    private final Set<Call> calls = Collections.newSetFromMap(new ConcurrentHashMap<Call, Boolean>());
    CloudHttp() {
        client = new OkHttpClient.Builder().dns(new CloudDns()).followRedirects(false).followSslRedirects(false)
            .cookieJar(CookieJar.NO_COOKIES).authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
            .proxy(Proxy.NO_PROXY).cache(null).retryOnConnectionFailure(false)
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).writeTimeout(20, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS).build();
    }
    static Request build(CloudPolicy.RequestSpec spec, String token) throws CloudFailure {
        Request.Builder request = new Request.Builder().url(CloudPolicy.ORIGIN + "/api/" + spec.path)
            .header("Accept", "application/json").header("Accept-Encoding", "identity");
        if (token != null) {
            if (!CloudPolicy.validToken(token)) throw new CloudFailure("cloud-storage-failed");
            request.header("Authorization", "Bearer " + token);
        }
        if (spec.expectedAccountId != null) request.header("X-Aurelia-Account", spec.expectedAccountId);
        RequestBody body = spec.body == null ? null : RequestBody.create(spec.body, JSON);
        if (body == null && (spec.method.equals("POST") || spec.method.equals("PUT") || spec.method.equals("PATCH"))) body = RequestBody.create("{}", JSON);
        return request.method(spec.method, body).build();
    }
    Result publicRequest(CloudPolicy.RequestSpec spec, String token) throws CloudFailure {
        if (spec.body != null) parse(spec.body);
        Result result = execute(build(spec, token), false);
        if (result.status >= 200 && result.status < 300) credentialFree(result.data, 0);
        return result;
    }
    Result internal(String endpoint, JSONObject body, String token) throws CloudFailure {
        if (!endpoint.equals("auth/device/start") && !endpoint.equals("auth/device/token") && !endpoint.equals("auth/logout"))
            throw new CloudFailure("cloud-invalid-request");
        return execute(build(new CloudPolicy.RequestSpec(endpoint, "POST", body.toString(), null), token), true);
    }
    private Result execute(Request request, boolean grant) throws CloudFailure {
        Call call = client.newCall(request.newBuilder().tag(Boolean.class, grant).build()); calls.add(call);
        try (Response response = call.execute()) {
            int status = response.code();
            if (status < 200 || status >= 300) return new Result(status, JSONObject.NULL);
            String encoding = response.header("Content-Encoding");
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) throw new CloudFailure("cloud-invalid-response");
            ResponseBody body = response.body();
            if (body == null || body.contentLength() > CloudPolicy.LIMIT) throw new CloudFailure("cloud-invalid-response");
            MediaType type = body.contentType();
            if (type == null || !type.type().equals("application") || !type.subtype().equals("json")) throw new CloudFailure("cloud-invalid-response");
            return new Result(status, parse(read(body.byteStream(), CloudPolicy.LIMIT)));
        } catch (CloudFailure failure) { throw failure; }
        catch (Exception failure) { throw new CloudFailure(CloudFailureDiagnostics.code(failure)); }
        finally { calls.remove(call); }
    }
    static String read(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer, 0, Math.min(buffer.length, limit + 1 - bytes.size()))) != -1) {
            bytes.write(buffer, 0, count);
            if (bytes.size() > limit) throw new CloudFailure("cloud-response-too-large");
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }
    static Object parse(String text) throws CloudFailure {
        CloudPolicy.jsonDepth(text);
        try {
            JSONTokener parser = new JSONTokener(text); Object value = parser.nextValue();
            if (!(value instanceof JSONObject) && !(value instanceof JSONArray) || parser.nextClean() != 0) throw new Exception();
            return value;
        } catch (Exception ignored) { throw new CloudFailure("cloud-invalid-response"); }
    }
    private static void credentialFree(Object value, int depth) throws CloudFailure {
        if (depth > 40) throw new CloudFailure("cloud-invalid-response");
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next(); String normalized = key.replace("_", "").replace("-", "").toLowerCase(Locale.ROOT);
                if (normalized.matches("token|accesstoken|refreshtoken|sessiontoken|devicecode|codeverifier|codechallenge|authorization|cookie|password|passwordhash|clientsecret"))
                    throw new CloudFailure("cloud-invalid-response");
                credentialFree(object.opt(key), depth + 1);
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) credentialFree(array.opt(i), depth + 1);
        }
    }
    List<Call> snapshot(boolean grantsOnly) {
        List<Call> active = new ArrayList<>();
        for (Call call : calls) if (!grantsOnly || Boolean.TRUE.equals(call.request().tag(Boolean.class))) active.add(call);
        return active;
    }
    static void cancel(List<Call> active) { for (Call call : active) call.cancel(); }
    void close() { cancel(snapshot(false)); client.connectionPool().evictAll(); client.dispatcher().executorService().shutdown(); }
    static final class Result {
        final int status; final Object data;
        Result(int status, Object data) { this.status = status; this.data = data; }
        JSONObject object() throws CloudFailure {
            if (!(data instanceof JSONObject)) throw new CloudFailure("cloud-invalid-response"); return (JSONObject) data;
        }
        @Override public String toString() { return "CloudResponse(redacted)"; }
    }
}
