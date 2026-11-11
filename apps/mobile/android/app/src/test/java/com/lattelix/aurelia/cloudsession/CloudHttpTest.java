package com.lattelix.aurelia.cloudsession;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.ConnectException;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.NoRouteToHostException;
import java.net.ProtocolException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.UnknownServiceException;
import java.util.concurrent.TimeoutException;
import javax.net.ssl.SSLException;
import okhttp3.Request;
import org.junit.Test;

public class CloudHttpTest {
    @Test public void ambientCapacitorCookieHandlerDoesNotProvideCookiesOrArbitraryHeaders() throws Exception {
        CookieHandler previous = CookieHandler.getDefault();
        try {
            CookieHandler.setDefault(new CookieManager());
            Request guest = CloudHttp.build(CloudPolicy.request("bootstrap", "GET", null, null), null);
            assertEquals(CloudPolicy.ORIGIN + "/api/bootstrap", guest.url().toString()); assertNull(guest.header("Cookie")); assertNull(guest.header("Authorization"));
            assertEquals("identity", guest.header("Accept-Encoding"));
            String owner = "daed6c3c-9924-42b7-91f1-3a7799731ab2";
            Request signed = CloudHttp.build(CloudPolicy.request("library/likes", "POST", "{}", owner), "synthetic-only-token");
            assertEquals("https://aurelia.lattelix.com/api/library/likes", signed.url().toString());
            assertEquals(owner, signed.header("X-Aurelia-Account")); assertEquals("Bearer synthetic-only-token", signed.header("Authorization")); assertNull(signed.header("Cookie"));
        } finally { CookieHandler.setDefault(previous); }
    }
    @Test public void responseCapAllowsExactEofAndRejectsOneExtraByte() throws Exception {
        assertEquals("1234", CloudHttp.read(new ByteArrayInputStream("1234".getBytes()), 4));
        try { CloudHttp.read(new ByteArrayInputStream("12345".getBytes()), 4); fail(); }
        catch (CloudFailure expected) { assertEquals("cloud-response-too-large", expected.code); }
    }

    @Test public void typedTransportFailuresHaveFixedCategoriesWithoutTheirMessages() {
        Throwable[] errors = { new UnknownHostException("private-host"), new SSLException("private-certificate"),
            new SocketTimeoutException("private-socket"), new TimeoutException("private-request"),
            new ConnectException("private-address"), new NoRouteToHostException("private-route"),
            new ProtocolException("private-response"), new UnknownServiceException("private-protocol"),
            new IOException("private-body"), new IllegalStateException("private-state"), new RuntimeException("private-client") };
        String[] categories = { "dns", "tls", "timeout", "timeout", "connect", "connect", "protocol", "protocol", "io", "state", "unexpected" };
        for (int i = 0; i < errors.length; i++) {
            String expected = "cloud-" + (i < 9 ? "network-" : "client-") + categories[i];
            CloudFailure sanitized = new CloudFailure(CloudFailureDiagnostics.code(errors[i]));
            assertEquals(expected, sanitized.code);
            assertEquals(expected, sanitized.getMessage());
            assertNull(sanitized.getCause());
            assertFalse(sanitized.toString().contains("private"));
        }
    }

    @Test public void nestedSpecificTransportCauseWinsOverGenericWrapperTypes() {
        Throwable wrapped = new IllegalStateException("private-wrapper",
            new IOException("private-stream", new UnknownHostException("private-host")));
        assertEquals("cloud-network-dns", CloudFailureDiagnostics.code(wrapped));
        assertEquals("cloud-network-tls", CloudFailureDiagnostics.code(new RuntimeException(new SSLException("private"))));
        assertEquals("cloud-network-io", CloudFailureDiagnostics.code(new IllegalStateException(new IOException("private"))));
    }

    @Test public void existingCloudFailureCategorySurvivesWrappersUnchanged() {
        CloudFailure fixed = new CloudFailure("cloud-invalid-response");
        assertEquals(fixed.code, CloudFailureDiagnostics.code(new IOException("private", fixed)));
        assertEquals(fixed.code, CloudFailureDiagnostics.code(fixed));
    }

    @Test public void causesAreIdentityBoundedAndCyclesCannotHangClassification() {
        RuntimeException first = new RuntimeException("private-one");
        RuntimeException second = new RuntimeException("private-two");
        first.initCause(second); second.initCause(first);
        assertEquals("cloud-client-unexpected", CloudFailureDiagnostics.code(first));
        Throwable inside = new UnknownHostException("private-host");
        for (int i = 0; i < 7; i++) inside = new RuntimeException(inside);
        assertEquals("cloud-network-dns", CloudFailureDiagnostics.code(inside));
        assertEquals("cloud-client-unexpected", CloudFailureDiagnostics.code(new RuntimeException(inside)));
    }

    @Test public void classificationDoesNotReadMessagesStacksOrUntrustedStringValues() {
        IOException privateError = new IOException() {
            @Override public String getMessage() { throw new AssertionError("Message must not be read"); }
            @Override public String toString() { throw new AssertionError("String must not be read"); }
            @Override public StackTraceElement[] getStackTrace() { throw new AssertionError("Stack must not be read"); }
        };
        assertEquals("cloud-network-io", CloudFailureDiagnostics.code(privateError));
        assertEquals("cloud-client-unexpected", CloudFailureDiagnostics.code(new RuntimeException("cloud-network-dns https://private.invalid/token")));
        assertEquals("cloud-client-unexpected", CloudFailureDiagnostics.code(null));
        RuntimeException brokenCause = new RuntimeException() {
            @Override public synchronized Throwable getCause() { throw new IllegalStateException("private-cause"); }
        };
        assertEquals("cloud-client-unexpected", CloudFailureDiagnostics.code(brokenCause));
    }
}
