package com.lattelix.aurelia.cloudsession;

import static org.junit.Assert.*;
import org.junit.Test;

public class CloudPolicyTest {
    private static final String OWNER = "daed6c3c-9924-42b7-91f1-3a7799731ab2";
    private void denied(String path, String method, String body, String owner) {
        try { CloudPolicy.request(path, method, body, owner); fail("Request should be rejected"); }
        catch (CloudFailure expected) { assertEquals("cloud-invalid-request", expected.code); }
    }
    @Test public void publicRoutesAndBoundOwnerWritesAreAccepted() throws Exception {
        for (String path : new String[]{"bootstrap", "search?q=test&provider=youtube", "album/youtube%3Aalbum", "library/export", "import/fixture"})
            assertEquals(path, CloudPolicy.request(path, "GET", null, null).path);
        assertEquals(OWNER, CloudPolicy.request("library/likes", "POST", "{}", OWNER).expectedAccountId);
        assertEquals("DELETE", CloudPolicy.request("library/playlists/" + OWNER + "/tracks", "DELETE", "{}", OWNER).method);
    }
    @Test public void remoteMediaAuthTraversalAndEncodedSeparatorsAreRejected() {
        for (String path : new String[]{"https://example.test/api/bootstrap", "https://aurelia-music.vercel.app/api/library", "https://aurelia.lattelix.com/api/library", "//example.test/bootstrap", "/bootstrap", "stream", "audio/iframe",
            "auth/device/token", "auth/me", "auth/logout", "library/../bootstrap", "library%2flikes", "library%252flikes", "album/%2e", "bootstrap#x",
            "bootstrap?redirect=https://example.test", "search?q=a&q=b", "search?provider=other", "library?token=x"}) denied(path, "GET", null, null);
        denied("library/likes", "POST", "{}", null); denied("library/queue", "PUT", "{}", "invalid");
        denied("bootstrap", "HEAD", null, null); denied("bootstrap", "GET", "{}", null);
    }
    @Test public void payloadAndNestingAreBounded() throws Exception {
        denied("library/queue", "PUT", "x".repeat(CloudPolicy.LIMIT + 1), OWNER);
        denied("library/queue", "PUT", "я".repeat(CloudPolicy.LIMIT / 2 + 1), OWNER);
        try { CloudPolicy.jsonDepth("[".repeat(41) + "]".repeat(41)); fail(); } catch (CloudFailure expected) { assertEquals("cloud-invalid-response", expected.code); }
        CloudPolicy.jsonDepth("{\"text\":\"[\\\"{}]\"}");
    }
    @Test public void discoveryIsReadOnlyAndCannotSelectRemoteEndpoints() throws Exception {
        assertEquals("discovery", CloudPolicy.request("discovery", "GET", null, null).path);
        denied("discovery", "POST", "{}", OWNER);
        denied("discovery?url=https%3A%2F%2Fevil.invalid", "GET", null, null);
        denied("discovery?continuation=untrusted", "GET", null, null);
        denied("discovery/private", "GET", null, null);
    }
    @Test public void onlyCanonicalConsentUrlIsAccepted() throws Exception {
        assertEquals("https://aurelia.lattelix.com", CloudPolicy.ORIGIN);
        String code = "ABCD-EF23", uri = "https://aurelia.lattelix.com/account?connect=" + code;
        assertEquals(uri, CloudPolicy.verificationUri(uri, code));
        for (String bad : new String[]{"https://aurelia-music.vercel.app/account?connect=" + code,
            uri.replace("aurelia.lattelix.com", "aurelia.lattelix.com:443"), uri.replace("aurelia.lattelix.com", "aurelia.lattelix.com.evil.invalid"),
            uri + "&next=bad", uri + "#fragment", uri.replace("https:", "http:"), uri.replace("ABCD", "ZZZZ"), uri.replace("/account", "/account/")}) {
            try { CloudPolicy.verificationUri(bad, code); fail(); } catch (CloudFailure expected) { assertEquals("cloud-invalid-response", expected.code); }
        }
    }
    @Test public void lyricsIsBoundedMetadataReadOnly() throws Exception {
        assertEquals("lyrics?q=Artist%20Song", CloudPolicy.request("lyrics?q=Artist%20Song", "GET", null, null).path);
        assertEquals("lyrics?q=" + "a".repeat(200), CloudPolicy.request("lyrics?q=" + "a".repeat(200), "GET", null, OWNER).path);
        for (String path : new String[]{"lyrics", "lyrics?", "lyrics?q=", "lyrics?q=a", "lyrics?q=%20%20", "lyrics?q=a%0Ab", "lyrics?q=ab%7Fcd",
            "lyrics?q=" + "a".repeat(201), "lyrics?q=ab&q=cd", "lyrics?q=ab&url=https%3A%2F%2Fevil.invalid", "lyrics/private?q=ab"})
            denied(path, "GET", null, OWNER);
        denied("lyrics?q=ab", "POST", "{}", OWNER);
        denied("lyrics?q=ab", "GET", "{}", OWNER);
    }
    @Test public void playlistOrderRequiresExactOwnedWriteRoute() throws Exception {
        String path = "library/playlists/" + OWNER + "/order";
        assertEquals(OWNER, CloudPolicy.request(path, "PUT", "{\"trackIds\":[],\"expectedTrackIds\":[]}", OWNER).expectedAccountId);
        denied(path, "PUT", "{}", null);
        denied(path, "POST", "{}", OWNER);
        denied(path, "GET", null, OWNER);
        denied(path + "/extra", "PUT", "{}", OWNER);
        denied(path + "?url=untrusted", "PUT", "{}", OWNER);
        denied("library/playlists/not-a-uuid/order", "PUT", "{}", OWNER);
    }
    @Test public void s256MatchesRfc7636AndVerifierContainsNoSecretsFromDevice() throws Exception {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", CloudPolicy.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        String first = CloudPolicy.verifier(), second = CloudPolicy.verifier();
        assertTrue(first.matches("[A-Za-z0-9_-]{43}")); assertNotEquals(first, second); assertEquals(43, CloudPolicy.challenge(first).length());
        assertEquals("CloudRequest(redacted)", CloudPolicy.request("bootstrap", "GET", null, null).toString());
    }
}
