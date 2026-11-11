package com.lattelix.aurelia.cloudsession;

import static org.junit.Assert.*;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import okhttp3.Dns;
import okhttp3.Request;
import org.junit.Test;

public class CloudDnsTest {
    private static List<InetAddress> addresses() throws Exception {
        return Arrays.asList(InetAddress.getByAddress(new byte[] { (byte) 192, 0, 2, 1 }),
            InetAddress.getByAddress(new byte[] { 0x20, 0x01, 0x0d, (byte) 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 }));
    }

    @Test public void primaryPlatformAnswerIsPreferredAndItsOrderIsPreserved() throws Exception {
        List<String> queried = new ArrayList<>();
        List<InetAddress> primary = addresses();
        CloudDns dns = new CloudDns(host -> { queried.add(host); return primary; });
        List<InetAddress> result = dns.lookup(CloudDns.CANONICAL_HOST);
        assertEquals(primary, result);
        assertEquals(Collections.singletonList(CloudDns.CANONICAL_HOST), queried);
        primary.set(0, primary.get(1));
        assertNotEquals(primary, result);
        assertThrows(UnsupportedOperationException.class, () -> result.clear());
    }

    @Test public void onlyCanonicalUnknownHostUsesTheFixedAliasThroughTheSameDelegate() throws Exception {
        List<String> queried = new ArrayList<>();
        List<InetAddress> alias = addresses();
        Dns delegate = host -> {
            queried.add(host);
            if (host.equals(CloudDns.CANONICAL_HOST)) throw new UnknownHostException("private-system-detail");
            assertEquals("ff408608d619c199.vercel-dns-017.com", host);
            return alias;
        };
        assertEquals(alias, new CloudDns(delegate).lookup(CloudDns.CANONICAL_HOST));
        assertEquals(Arrays.asList(CloudDns.CANONICAL_HOST, CloudDns.HOSTING_ALIAS), queried);
    }

    @Test public void otherHostsAndExceptionTypesCannotEnableFallback() {
        for (String host : Arrays.asList("www.youtube.com", CloudDns.HOSTING_ALIAS,
            "aurelia.lattelix.com.evil.invalid", "AURELIA.LATTELIX.COM")) {
            List<String> queried = new ArrayList<>();
            CloudDns dns = new CloudDns(value -> { queried.add(value); throw new UnknownHostException("private-host"); });
            assertThrows(UnknownHostException.class, () -> dns.lookup(host));
            assertEquals(Collections.singletonList(host), queried);
        }
        List<String> queried = new ArrayList<>();
        IllegalStateException failure = new IllegalStateException("private-client-state");
        CloudDns dns = new CloudDns(host -> { queried.add(host); throw failure; });
        assertSame(failure, assertThrows(IllegalStateException.class, () -> dns.lookup(CloudDns.CANONICAL_HOST)));
        assertEquals(Collections.singletonList(CloudDns.CANONICAL_HOST), queried);
    }

    @Test public void emptyOrMalformedPrimaryAnswersFailWithoutTryingTheAlias() {
        for (List<InetAddress> answer : Arrays.<List<InetAddress>>asList(null, Collections.<InetAddress>emptyList(), Arrays.<InetAddress>asList((InetAddress) null))) {
            List<String> queried = new ArrayList<>();
            CloudDns dns = new CloudDns(host -> { queried.add(host); return answer; });
            UnknownHostException failure = assertThrows(UnknownHostException.class, () -> dns.lookup(CloudDns.CANONICAL_HOST));
            assertEquals("cloud-network-dns", CloudFailureDiagnostics.code(failure));
            assertEquals(Collections.singletonList(CloudDns.CANONICAL_HOST), queried);
        }
    }

    @Test public void unavailableOrEmptyAliasFailsClosedWithoutRetainingPrivateDetails() {
        for (boolean empty : new boolean[] { false, true }) {
            List<String> queried = new ArrayList<>();
            CloudDns dns = new CloudDns(host -> {
                queried.add(host);
                if (host.equals(CloudDns.CANONICAL_HOST) || !empty) throw new UnknownHostException("private-dns-detail");
                return Collections.emptyList();
            });
            UnknownHostException failure = assertThrows(UnknownHostException.class, () -> dns.lookup(CloudDns.CANONICAL_HOST));
            assertEquals("cloud-network-dns", CloudFailureDiagnostics.code(failure));
            assertEquals("cloud-network-dns", failure.getMessage());
            assertNull(failure.getCause());
            assertEquals(Arrays.asList(CloudDns.CANONICAL_HOST, CloudDns.HOSTING_ALIAS), queried);
        }
    }

    @Test public void eachLookupReturnsToThePlatformWithoutKeepingAnAliasAddressCache() throws Exception {
        List<String> queried = new ArrayList<>();
        List<InetAddress> answer = addresses();
        CloudDns dns = new CloudDns(host -> {
            queried.add(host);
            if (queried.size() == 1) throw new UnknownHostException();
            return answer;
        });
        dns.lookup(CloudDns.CANONICAL_HOST);
        dns.lookup(CloudDns.CANONICAL_HOST);
        assertEquals(Arrays.asList(CloudDns.CANONICAL_HOST, CloudDns.HOSTING_ALIAS, CloudDns.CANONICAL_HOST), queried);
    }

    @Test public void fallbackAddressSelectionDoesNotRewriteCanonicalRequestOrCredentialHeaders() throws Exception {
        List<InetAddress> answer = addresses();
        new CloudDns(host -> {
            if (host.equals(CloudDns.CANONICAL_HOST)) throw new UnknownHostException();
            return answer;
        }).lookup(CloudDns.CANONICAL_HOST);
        String owner = "daed6c3c-9924-42b7-91f1-3a7799731ab2";
        Request request = CloudHttp.build(CloudPolicy.request("library/likes", "POST", "{}", owner), "synthetic-only-token");
        assertEquals("https://aurelia.lattelix.com/api/library/likes", request.url().toString());
        assertEquals(CloudDns.CANONICAL_HOST, request.url().host());
        assertEquals("Bearer synthetic-only-token", request.header("Authorization"));
        assertEquals(owner, request.header("X-Aurelia-Account"));
        assertNull(request.header("Host")); // OkHttp derives the Host header from the unchanged URL.
        assertNull(request.header("Cookie"));
    }
}
