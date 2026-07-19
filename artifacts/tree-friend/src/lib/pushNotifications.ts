/**
 * Browser Push Notifications (Web Push API)
 *
 * Setup:
 * 1. Generate VAPID keys: npx web-push generate-vapid-keys
 * 2. Add VITE_VAPID_PUBLIC_KEY=... to tree-friend/.env
 * 3. Add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_MAILTO to api-server/.env
 */

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function requestPushPermission(): Promise<boolean> {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !VAPID_PUBLIC_KEY) {
    return false;
  }
  const permission = await Notification.requestPermission();
  return permission === "granted";
}

export async function subscribeToPush(userId: string): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) return true; // Already subscribed

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    // Send subscription to backend
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ subscription, userId }),
    });

    return true;
  } catch (err) {
    console.warn("[push] Subscribe failed:", err);
    return false;
  }
}

export async function unsubscribeFromPush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
    }
  } catch (err) {
    console.warn("[push] Unsubscribe failed:", err);
  }
}

export function isPushSupported(): boolean {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window && !!VAPID_PUBLIC_KEY;
}
