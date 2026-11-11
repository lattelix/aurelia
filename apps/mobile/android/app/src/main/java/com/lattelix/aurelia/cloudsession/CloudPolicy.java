package com.lattelix.aurelia.cloudsession;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

final class CloudPolicy {
    static final String ORIGIN = "https://aurelia.lattelix.com";
    static final int LIMIT = 2 * 1024 * 1024;
    private static final String UUID = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
    private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    static RequestSpec request(String path, String method, String body, String expectedAccountId) throws CloudFailure {
        if (path == null || method == null || path.length() > 4096 || path.isEmpty() || path.startsWith("/") ||
            path.contains("\\") || path.indexOf('#') >= 0 || path.chars().anyMatch(c -> c < 0x20 || c == 0x7f)) invalid();
        if (!Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE").contains(method)) invalid();
        if (body != null && (method.equals("GET") || body.length() > LIMIT || body.getBytes(StandardCharsets.UTF_8).length > LIMIT)) invalid();
        if (expectedAccountId != null && !expectedAccountId.matches(UUID)) invalid();
        URI relative;
        try { relative = new URI(path); } catch (Exception ignored) { throw new CloudFailure("cloud-invalid-request"); }
        if (relative.isAbsolute() || relative.getRawAuthority() != null || relative.getRawFragment() != null) invalid();
        if (relative.getRawPath() == null || relative.getRawPath().matches("(?i).*%(?:2f|5c|2e|25).*")) invalid();
        String decoded;
        try { decoded = URLDecoder.decode(relative.getRawPath(), "UTF-8"); }
        catch (Exception ignored) { throw new CloudFailure("cloud-invalid-request"); }
        if (!decoded.matches("[A-Za-z0-9:_-]+(?:/[A-Za-z0-9:_-]+)*") || decoded.length() > 512) invalid();
        String[] segments = decoded.split("/");
        boolean allowed = false;
        if (method.equals("GET")) {
            allowed = segments.length == 1 && Arrays.asList("bootstrap", "search", "autocomplete", "recommendations", "related", "library", "import", "discovery", "lyrics").contains(decoded);
            allowed |= segments.length == 2 && Arrays.asList("album", "artist", "playlist").contains(segments[0]) && segments[1].length() <= 160;
            allowed |= decoded.equals("library/export") || decoded.equals("import/fixture");
        } else {
            allowed = (decoded.equals("library/likes") && Arrays.asList("POST", "DELETE").contains(method)) ||
                (decoded.equals("library/playlists") && method.equals("POST")) ||
                (decoded.equals("library/queue") && method.equals("PUT")) ||
                (Arrays.asList("library/history", "library/signals", "library/artists").contains(decoded) && method.equals("POST")) ||
                (Arrays.asList("import/fixture", "import/file", "import/resolve").contains(decoded) && method.equals("POST"));
            if (segments.length >= 3 && segments[0].equals("library") && segments[1].equals("playlists") && segments[2].matches(UUID)) {
                allowed |= segments.length == 3 && Arrays.asList("PATCH", "DELETE").contains(method);
                allowed |= segments.length == 4 && segments[3].equals("tracks") && Arrays.asList("POST", "DELETE").contains(method);
                allowed |= segments.length == 4 && segments[3].equals("order") && method.equals("PUT");
            }
            if (expectedAccountId == null) invalid();
        }
        if (!allowed) invalid();
        validateQuery(decoded, relative.getRawQuery());
        if (body != null) jsonDepth(body);
        return new RequestSpec(path, method, body, expectedAccountId);
    }

    private static void validateQuery(String path, String query) throws CloudFailure {
        if (query == null) {
            if (path.equals("lyrics")) invalid();
            return;
        }
        Set<String> allowed = path.equals("search") ? new HashSet<>(Arrays.asList("q", "provider")) :
            Arrays.asList("autocomplete", "lyrics").contains(path) ? new HashSet<>(Arrays.asList("q")) :
            path.equals("related") ? new HashSet<>(Arrays.asList("id")) : new HashSet<>();
        Set<String> seen = new HashSet<>();
        for (String pair : query.split("&", -1)) {
            String[] pieces = pair.split("=", 2);
            String name, value;
            try { name = URLDecoder.decode(pieces[0], "UTF-8"); value = pieces.length == 2 ? URLDecoder.decode(pieces[1], "UTF-8") : ""; }
            catch (Exception ignored) { throw new CloudFailure("cloud-invalid-request"); }
            if (!allowed.contains(name) || !seen.add(name) || value.length() > 200 || value.chars().anyMatch(c -> c < 0x20 || c == 0x7f)) invalid();
            if (name.equals("provider") && !Arrays.asList("studio", "youtube").contains(value)) invalid();
            if (name.equals("id") && !value.matches("[A-Za-z0-9:_-]{1,160}")) invalid();
            if (path.equals("lyrics") && value.trim().length() < 2) invalid();
        }
        if (path.equals("lyrics") && !seen.contains("q")) invalid();
    }

    static String verificationUri(String value, String userCode) throws CloudFailure {
        if (value == null || value.length() > 512 || userCode == null || !userCode.matches("[A-Z0-9]{4}-[A-Z0-9]{4}")) invalidResponse();
        URI uri;
        try { uri = new URI(value); } catch (Exception ignored) { throw new CloudFailure("cloud-invalid-response"); }
        if (!"https".equals(uri.getScheme()) || !"aurelia.lattelix.com".equals(uri.getRawAuthority()) ||
            uri.getRawUserInfo() != null || !"/account".equals(uri.getRawPath()) || uri.getRawFragment() != null ||
            !value.equals(ORIGIN + "/account?connect=" + userCode)) invalidResponse();
        return value;
    }

    static void jsonDepth(String text) throws CloudFailure {
        int depth = 0; boolean quoted = false, escaped = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (quoted) { if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') quoted = false; }
            else if (c == '"') quoted = true;
            else if (c == '{' || c == '[') { if (++depth > 40) invalidResponse(); }
            else if (c == '}' || c == ']') { if (--depth < 0) invalidResponse(); }
        }
        if (quoted || depth != 0) invalidResponse();
    }

    static boolean validToken(String value) { return value != null && value.length() >= 16 && value.length() <= 4096 && value.matches("[A-Za-z0-9._~+/-]+=*"); }
    static String verifier() { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); return base64Url(bytes); }
    static String challenge(String verifier) throws CloudFailure {
        if (verifier == null || !verifier.matches("[A-Za-z0-9_-]{43,128}")) invalid();
        try { return base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII))); }
        catch (Exception ignored) { throw new CloudFailure("cloud-unavailable"); }
    }
    private static String base64Url(byte[] bytes) {
        StringBuilder out = new StringBuilder(); int accumulator = 0, bits = 0;
        for (byte value : bytes) {
            accumulator = (accumulator << 8) | (value & 255); bits += 8;
            while (bits >= 6) { bits -= 6; out.append(ALPHABET.charAt((accumulator >>> bits) & 63)); }
        }
        if (bits > 0) out.append(ALPHABET.charAt((accumulator << (6 - bits)) & 63));
        return out.toString();
    }
    private static void invalid() throws CloudFailure { throw new CloudFailure("cloud-invalid-request"); }
    private static void invalidResponse() throws CloudFailure { throw new CloudFailure("cloud-invalid-response"); }
    static final class RequestSpec {
        final String path, method, body, expectedAccountId;
        RequestSpec(String path, String method, String body, String expectedAccountId) {
            this.path = path; this.method = method; this.body = body; this.expectedAccountId = expectedAccountId;
        }
        @Override public String toString() { return "CloudRequest(redacted)"; }
    }
}
