package com.lattelix.aurelia;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.lattelix.aurelia.deviceaudio.AureliaDeviceAudioPlugin;
import com.lattelix.aurelia.cloudsession.AureliaCloudSessionPlugin;
import com.lattelix.aurelia.appearance.AureliaSystemBarsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AureliaDeviceAudioPlugin.class);
        registerPlugin(AureliaCloudSessionPlugin.class);
        registerPlugin(AureliaSystemBarsPlugin.class);
        super.onCreate(savedInstanceState);
        AureliaSystemBarsPlugin.applyInitial(this);
    }
}
