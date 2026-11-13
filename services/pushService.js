'use strict';

const admin = require('firebase-admin');
const User = require('../models/User');

// ---------------------------------------------------------------------------
// Firebase Admin initialisation
// Credentials come from FIREBASE_SERVICE_ACCOUNT_BASE64 (a base64 string of
// the service-account JSON). Never load credentials from a file on disk.
// ---------------------------------------------------------------------------
function initFirebase() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64) {
    console.warn('[pushService] FIREBASE_SERVICE_ACCOUNT_BASE64 is not set; push notifications are disabled.');
    return null;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    throw new Error(
      '[pushService] FIREBASE_SERVICE_ACCOUNT_BASE64 could not be decoded. ' +
      'Make sure it is a valid base64-encoded JSON string.'
    );
  }

  if (!admin.apps || admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  return admin.messaging();
}

const messaging = initFirebase();

// ---------------------------------------------------------------------------
// CRITICAL_ALERTS_ENABLED controls iOS-only behaviour:
//   - critical sound + interruption-level:critical on APNs
// It does NOT affect Android priority (Android is always high priority with
// channel sos_alarm_v1). Whether Android bypasses Do Not Disturb depends on
// the channel's bypassDnd setting AND the user granting Do Not Disturb access
// in the system settings — that is configured in the app, not here.
// ---------------------------------------------------------------------------
const CRITICAL_ALERTS_ENABLED = process.env.CRITICAL_ALERTS_ENABLED === 'true';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send push notification to multiple users.
 * @param {string[]} userIds
 * @param {{ type: string, alertId: string, senderName: string }} data
 * @param {{ title?: string, body?: string }} alertText
 */
async function sendPushNotification(userIds, data, alertText = {}) {
  try {
    if (!messaging) {
      return { success: true, notified: 0, disabled: true };
    }

    const users = await User.find({ _id: { $in: userIds } }).select('fcmTokens');
    const allTokens = users.flatMap(u => u.fcmTokens);

    if (allTokens.length === 0) {
      console.log('[push] No FCM tokens found for target users');
      return { success: true, notified: 0 };
    }

    const BATCH = 500;
    let totalNotified = 0;
    let totalFailed = 0;

    for (let i = 0; i < allTokens.length; i += BATCH) {
      const result = await _sendBatch(allTokens.slice(i, i + BATCH), data, alertText);
      totalNotified += result.successCount;
      totalFailed += result.failureCount;
      if (result.invalidTokens.length > 0) {
        await _pruneInvalidTokens(result.invalidTokens);
      }
    }

    console.log(`[push] Sent: ${totalNotified} ok, ${totalFailed} failed`);
    return { success: true, notified: totalNotified, failed: totalFailed };
  } catch (err) {
    console.error('[push] sendPushNotification error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send SOS alert to all circle members except the sender.
 */
async function sendSOSAlert(circleMembers, senderId, alertId, senderName) {
  const recipients = circleMembers.filter(
    id => id.toString() !== senderId.toString()
  );

  if (recipients.length === 0) {
    console.log('[push] No other members to notify');
    return { success: true, notified: 0 };
  }

  return sendPushNotification(
    recipients,
    { type: 'sos_triggered', alertId: alertId.toString(), senderName },
    { title: 'SOS Alert', body: `${senderName} needs help!` }
  );
}

function withoutUser(userIds, excludeId) {
  if (!excludeId) return userIds;
  return userIds.filter(id => id.toString() !== excludeId.toString());
}

/**
 * Notify circle members that someone is responding.
 * The responder never gets a push about their own action.
 */
async function sendMemberResponding(circleMembers, responderName, alertId, responderId) {
  const recipients = withoutUser(circleMembers, responderId);
  if (recipients.length === 0) return { success: true, notified: 0 };
  return sendPushNotification(
    recipients,
    { type: 'member_responding', alertId: alertId.toString(), senderName: responderName },
    { title: 'Help is on the way', body: `${responderName} is responding` }
  );
}

/**
 * Notify circle members that an alert has ended.
 * The person who ended it (excludeUserId) does not need the notification.
 */
async function sendAlertEnded(circleMembers, alertId, senderName, excludeUserId) {
  const recipients = withoutUser(circleMembers, excludeUserId);
  if (recipients.length === 0) return { success: true, notified: 0 };
  return sendPushNotification(
    recipients,
    { type: 'sos_ended', alertId: alertId.toString(), senderName },
    { title: 'Alert ended', body: `${senderName}'s SOS has ended` }
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Only a real SOS rings like an alarm. "Responding" and "ended" updates must be
// quiet, otherwise an "alert ended" message would ring the phone all over again.
const ALARM_TYPES = new Set(['sos_triggered']);

// A stale SOS delivered hours later is worse than none, so alarms expire fast.
const ALARM_TTL_SECONDS  = 10 * 60;
const UPDATE_TTL_SECONDS = 60 * 60;

/**
 * Build the FCM multicast message. Exported so tests can check the payload
 * without needing Firebase credentials.
 */
function buildMessage(tokens, data, alertText = {}, options = {}) {
  const critical   = options.criticalAlertsEnabled !== undefined
    ? options.criticalAlertsEnabled
    : CRITICAL_ALERTS_ENABLED;
  const isAlarm    = ALARM_TYPES.has(data.type);
  const ttlSeconds = isAlarm ? ALARM_TTL_SECONDS : UPDATE_TTL_SECONDS;
  const channelId  = isAlarm ? 'sos_alarm_v1' : 'sos_updates_v1';
  const senderName = String(data.senderName || 'Someone');

  const android = {
    priority: 'high',
    ttl: ttlSeconds * 1000,
    notification: isAlarm
      ? {
          channelId,
          priority: 'max',
          visibility: 'public',
          // Sound name WITHOUT file extension for Android (the channel decides on Android 8+)
          sound: 'sos_alarm',
          defaultVibrateTimings: false,
          vibrateTimingsMillis: [0, 500, 250, 500]
        }
      : {
          channelId,
          priority: 'default',
          visibility: 'public'
        }
  };

  const aps = {
    alert: {
      title: alertText.title || 'SOS Alert',
      body:  alertText.body  || `${senderName} needs help!`
    },
    badge: isAlarm ? 1 : 0
  };

  if (isAlarm) {
    // CRITICAL_ALERTS_ENABLED controls iOS-only critical-sound behaviour.
    aps.sound = critical
      ? { critical: 1, name: 'sos_alarm.wav', volume: 1.0 }
      : 'default';
    aps['interruption-level'] = critical ? 'critical' : 'time-sensitive';
  } else {
    aps.sound = 'default';
    aps['interruption-level'] = 'active';
  }

  return {
    tokens,
    // FCM data values MUST be strings
    data: {
      type:       String(data.type),
      alertId:    String(data.alertId),
      senderName,
      channelId
    },
    // Android: always high priority so the phone wakes. Whether the alarm
    // bypasses Do Not Disturb depends on the channel's bypassDnd setting AND
    // the user granting Do Not Disturb access in system settings.
    android,
    apns: {
      headers: {
        'apns-priority':   isAlarm ? '10' : '5',
        'apns-push-type':  'alert',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSeconds)
      },
      payload: { aps },
      fcmOptions: {}
    }
  };
}

async function _sendBatch(tokens, data, alertText) {
  const message = buildMessage(tokens, data, alertText);

  const response = await messaging.sendEachForMulticast(message);
  const invalidTokens = [];

  response.responses.forEach((resp, i) => {
    if (!resp.success) {
      const code = resp.error && resp.error.code;
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        invalidTokens.push(tokens[i]);
      }
    }
  });

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    invalidTokens
  };
}

async function _pruneInvalidTokens(invalidTokens) {
  if (!invalidTokens.length) return;
  try {
    await User.updateMany(
      { fcmTokens: { $in: invalidTokens } },
      { $pull: { fcmTokens: { $in: invalidTokens } } }
    );
    console.log(`[push] Pruned ${invalidTokens.length} invalid token(s)`);
  } catch (err) {
    console.error('[push] Prune tokens error:', err.message);
  }
}

module.exports = {
  buildMessage,
  sendPushNotification,
  sendSOSAlert,
  sendMemberResponding,
  sendAlertEnded
};
