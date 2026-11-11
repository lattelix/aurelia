package com.lattelix.aurelia.deviceaudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

public class StudioCatalogueTest {
    @Test
    public void mapsAllBundledAssetsToCanonicalTrackIds() {
        List<String> albums = List.of("afterglow", "blue-hours", "parallel", "still-life");
        int external = 1;
        for (String album : albums) {
            for (int track = 1; track <= 3; track++) {
                String id = Integer.toString(external++);
                assertEquals("studio:" + album + "-" + track, StudioCatalogue.trackIds().get(id));
                assertEquals("asset:///" + id + ".mp3", StudioCatalogue.assetUri(id));
            }
        }
        assertEquals(12, StudioCatalogue.trackIds().size());
        assertTrue(StudioCatalogue.matches("12", "studio:still-life-3"));
        assertFalse(StudioCatalogue.matches("12", "studio:still-life-2"));
    }
}
