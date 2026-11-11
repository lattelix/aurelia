package com.lattelix.aurelia.appearance;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Own-window icon contrast only. Does not change the OS theme, insets or material capabilities. */
@CapacitorPlugin(name = "AureliaSystemBars")
public final class AureliaSystemBarsPlugin extends Plugin {
    @PluginMethod public void setColorScheme(PluginCall call) {
        Object value = call.getData().opt("colorScheme");
        if (call.getData().length() != 1 || !(value instanceof String) ||
            !(value.equals("light") || value.equals("dark"))) {
            call.reject("invalid-color-scheme");
            return;
        }
        final Activity activity = getActivity();
        if (!available(activity)) { call.reject("system-bars-unavailable"); return; }
        final boolean light = value.equals("light");
        activity.runOnUiThread(() -> {
            if (getActivity() != activity || !available(activity)) {
                call.reject("system-bars-unavailable");
                return;
            }
            try { apply(activity, light); call.resolve(); }
            catch (RuntimeException ignored) { call.reject("system-bars-unavailable"); }
        });
    }

    /** Initial OS scheme until the WebView applies its persisted System/Light/Dark choice. */
    public static void applyInitial(Activity activity) {
        if (!available(activity)) return;
        boolean light = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            != Configuration.UI_MODE_NIGHT_YES;
        try { apply(activity, light); } catch (RuntimeException ignored) { }
    }

    private static boolean available(Activity activity) {
        return activity != null && !activity.isFinishing() && !activity.isDestroyed();
    }

    @SuppressWarnings("deprecation")
    private static void apply(Activity activity, boolean light) {
        Window window = activity.getWindow();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(light);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            controller.setAppearanceLightNavigationBars(light);
        } else {
            // API24/25 have white navigation icons only; retain a contrasting window bar.
            window.setNavigationBarColor(Color.BLACK);
        }
    }
}
