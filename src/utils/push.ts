/**
 * Sending a push notification to a driver's phone.
 *
 * Uses Expo's push service rather than talking to FCM and APNs directly. One
 * HTTP call covers both platforms, Expo holds the APNs key and the FCM
 * credentials that EAS already provisioned, and the app receives a single token
 * shape on either OS. Going direct would mean a service-account JSON for
 * Firebase, a .p8 key for Apple, and two code paths — for the same delivery.
 *
 * ## This never throws
 *
 * Every function here swallows its own failures. A notification is a courtesy
 * on top of an action that has already succeeded: by the time we get here the
 * order IS assigned and the transaction IS committed. Letting a push failure
 * bubble would turn "the driver's phone was off" into a 500 on the dispatcher's
 * assign button, which is a far worse outcome than a missed buzz — the job would
 * appear unassigned when it is not.
 *
 * The app polls its own work list underneath all of this, so a dropped
 * notification costs a driver at most one poll interval.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Expo's own shape — `ExponentPushToken[...]` or the older `ExpoPushToken[...]`. */
const TOKEN_SHAPE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

export function isExpoPushToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

export interface PushMessage {
  /** Where to deliver. Anything not matching Expo's token shape is dropped. */
  to: string;
  title: string;
  body: string;
  /**
   * Delivered to the app untouched, and used to route the tap.
   *
   * Keep it small — Expo caps the whole message at 4KB, and APNs at 4KB too, so
   * this is an id and a kind, never a copy of the record.
   */
  data?: Record<string, string>;
}

/**
 * Fire and forget, in one batch.
 *
 * Expo accepts up to 100 messages per request, which is more than this company
 * has drivers, so a bulk assign is still a single call.
 */
/**
 * Android notification channels, which the app creates at startup.
 *
 * A channel is the unit a USER can mute, so the split is not cosmetic: a driver
 * who silences dispatch chatter must not thereby silence new work. `jobs` is the
 * default because that is the one that must never be missed.
 *
 * iOS ignores this field entirely — it has no equivalent, and importance there
 * is a single per-app setting.
 */
export type PushChannel = 'jobs' | 'messages';

export async function sendPush(
  messages: PushMessage[],
  channelId: PushChannel = 'jobs',
): Promise<void> {
  const valid = messages.filter((m) => isExpoPushToken(m.to));
  if (valid.length === 0) return;

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Expo will gzip a large batch back at us otherwise.
        'Accept-Encoding': 'gzip, deflate',
        Accept: 'application/json',
      },
      body: JSON.stringify(
        valid.map((m) => ({
          to: m.to,
          title: m.title,
          body: m.body,
          data: m.data,
          sound: 'default',
          /*
           * `high` so Android delivers it while the device is dozing. A courier
           * being told about a new job twenty minutes late is the same as not
           * being told, and this is the exact case Doze was built to defer.
           */
          priority: 'high',
          // Android only: routes into the channel the app creates at startup.
          channelId,
        })),
      ),
    });

    if (!res.ok) {
      console.warn(`[push] Expo returned ${res.status}`);
      return;
    }

    /*
     * A 200 does NOT mean delivered. Expo answers per-message, and the one that
     * matters is `DeviceNotRegistered` — the app was uninstalled or the token
     * rotated. Logged rather than acted on: clearing the row from here would
     * mean a write inside a path that is meant to be side-effect free, and the
     * next sign-in overwrites the token anyway.
     */
    const body = (await res.json()) as { data?: { status: string; message?: string }[] };
    for (const ticket of body.data ?? []) {
      if (ticket.status === 'error') console.warn(`[push] ${ticket.message ?? 'unknown error'}`);
    }
  } catch (e) {
    console.warn('[push] send failed:', e instanceof Error ? e.message : e);
  }
}
