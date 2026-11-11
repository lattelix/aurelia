package com.lattelix.aurelia.cloudsession;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import okhttp3.Dns;

/** Address selection only: HTTPS authority, TLS verification and request headers stay canonical. */
final class CloudDns implements Dns {
    static final String CANONICAL_HOST = "aurelia.lattelix.com";
    // Owner-confirmed public CNAME on 2026-11-08. Revalidate when hosting changes.
    static final String HOSTING_ALIAS = "ff408608d619c199.vercel-dns-017.com";
    private final Dns delegate;

    CloudDns() { this(Dns.SYSTEM); }
    CloudDns(Dns delegate) { this.delegate = Objects.requireNonNull(delegate); }

    @Override public List<InetAddress> lookup(String hostname) throws UnknownHostException {
        List<InetAddress> addresses;
        try { addresses = delegate.lookup(hostname); }
        catch (UnknownHostException ignored) {
            if (!CANONICAL_HOST.equals(hostname)) throw unavailable();
            try { return validated(delegate.lookup(HOSTING_ALIAS)); }
            catch (UnknownHostException ignoredAlias) { throw unavailable(); }
        }
        // A malformed successful response is terminal, not permission for another lookup.
        return validated(addresses);
    }

    private static List<InetAddress> validated(List<InetAddress> addresses) throws UnknownHostException {
        if (addresses == null || addresses.isEmpty()) throw unavailable();
        List<InetAddress> ordered = new ArrayList<>(addresses.size());
        for (InetAddress address : addresses) {
            if (address == null) throw unavailable();
            byte[] bytes = address.getAddress();
            if (bytes == null || (bytes.length != 4 && bytes.length != 16)) throw unavailable();
            ordered.add(address);
        }
        return Collections.unmodifiableList(ordered);
    }

    private static UnknownHostException unavailable() {
        return new UnknownHostException("cloud-network-dns");
    }
}
