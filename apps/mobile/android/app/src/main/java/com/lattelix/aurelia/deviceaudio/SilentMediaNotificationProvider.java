package com.lattelix.aurelia.deviceaudio;

import android.content.Context;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaNotification;
import androidx.media3.session.MediaSession;
import com.google.common.collect.ImmutableList;

/** Silent media notifications, including API 24/25 which have no notification channels. */
@OptIn(markerClass = UnstableApi.class)
final class SilentMediaNotificationProvider extends DefaultMediaNotificationProvider {
    SilentMediaNotificationProvider(Context context, String channelId) {
        super(context, session -> DEFAULT_NOTIFICATION_ID, channelId, DEFAULT_CHANNEL_NAME_RESOURCE_ID);
    }

    @Override
    protected int[] addNotificationActions(
        MediaSession session, ImmutableList<CommandButton> buttons,
        NotificationCompat.Builder builder, MediaNotification.ActionFactory actions
    ) {
        builder.setSilent(true).setPriority(NotificationCompat.PRIORITY_LOW)
            .setSound(null).setVibrate(new long[0]);
        return super.addNotificationActions(session, buttons, builder, actions);
    }
}
