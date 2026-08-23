/**
 * useGuestSession — manages the phone-verified guest session.
 *
 * Part 2 of the Daraz-style guest checkout.
 *
 * State machine:
 *   1. Not signed in, not verified → localStorage cart (useGuestCart)
 *   2. Not signed in, verified → server cart (useGetCart with guest JWT)
 *   3. Signed in → server cart (useGetCart with Clerk JWT)
 *
 * The guest JWT is stored in localStorage under GUEST_TOKEN_KEY. On app
 * boot, App.tsx's token getter checks for this key when Clerk isn't
 * signed in, and attaches it as `Authorization: Bearer <guest-jwt>` if
 * present. This means all API calls (useGetCart, useCreateOrder, etc.)
 * work unchanged for verified guests — the backend's requireGuestOrAuth
 * middleware validates the token and sets req.userId = "guest_<phone>".
 *
 * Session lifecycle:
 *   - Verified via POST /auth/guest-otp/verify → guestToken stored
 *   - Expires after 30 min (JWT exp claim) — the next API call 401s,
 *     which the frontend should handle by clearing the session and
 *     prompting re-verification
 *   - Cleared on sign-in (App.tsx detects isSignedIn → clears guest token)
 *   - Cleared on explicit logout / "sign out of guest session"
 */

import { useState, useCallback, useEffect } from "react";
import { apiClient } from "@/lib/apiClient";

const GUEST_TOKEN_KEY = "treefriend_guest_token";
const GUEST_PHONE_KEY = "treefriend_guest_phone";

function readToken(): string | null {
  try {
    return localStorage.getItem(GUEST_TOKEN_KEY);
  } catch {
    return null;
  }
}

function readPhone(): string | null {
  try {
    return localStorage.getItem(GUEST_PHONE_KEY);
  } catch {
    return null;
  }
}

function writeSession(token: string, phone: string): void {
  try {
    localStorage.setItem(GUEST_TOKEN_KEY, token);
    localStorage.setItem(GUEST_PHONE_KEY, phone);
  } catch {
    // localStorage unavailable (private mode) — non-critical, the session
    // just won't persist across page reloads. The in-memory state still
    // works for the current tab.
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(GUEST_TOKEN_KEY);
    localStorage.removeItem(GUEST_PHONE_KEY);
  } catch {
    // Same as above — nothing to do.
  }
}

export interface GuestSession {
  /** The guest JWT, or null if not verified. */
  guestToken: string | null;
  /** The verified phone number (normalized bare-local form). */
  guestPhone: string | null;
  /** True if the guest has a valid-looking token (not necessarily unexpired). */
  isVerified: boolean;

  /**
   * Send an OTP to the given phone number.
   * Returns { success: true } on success, { success: false, error } on failure.
   * Always returns success: true even if the transport fails (the backend
   * doesn't leak transport errors to avoid breaking the buyer's UX).
   */
  sendOtp: (phone: string) => Promise<{ success: boolean; error?: string }>;

  /**
   * Verify the OTP code for the given phone number.
   * On success: stores the guest JWT, sets isVerified = true.
   * On failure: returns { success: false, error }.
   */
  verifyOtp: (
    phone: string,
    code: string,
  ) => Promise<{ success: boolean; error?: string }>;

  /** Clear the guest session (on sign-in, logout, or 401). */
  clear: () => void;
}

export function useGuestSession(): GuestSession {
  const [guestToken, setGuestToken] = useState<string | null>(readToken);
  const [guestPhone, setGuestPhone] = useState<string | null>(readPhone);

  // Listen for storage events (cross-tab sync — if the buyer verifies in
  // one tab, other tabs should see the updated session).
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === GUEST_TOKEN_KEY) {
        setGuestToken(e.newValue);
      }
      if (e.key === GUEST_PHONE_KEY) {
        setGuestPhone(e.newValue);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const sendOtp = useCallback(async (phone: string) => {
    try {
      const { data } = await apiClient.post<{
        success: boolean;
        expiresInMs?: number;
      }>("/auth/guest-otp/send", { phone });
      return { success: data.success === true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Failed to send code.",
      };
    }
  }, []);

  const verifyOtp = useCallback(
    async (phone: string, code: string) => {
      try {
        const { data } = await apiClient.post<{
          success: boolean;
          phone?: string;
          sessionExpiresAt?: string;
          guestToken?: string;
          error?: string;
        }>("/auth/guest-otp/verify", { phone, code });

        if (data.success && data.guestToken && data.phone) {
          writeSession(data.guestToken, data.phone);
          setGuestToken(data.guestToken);
          setGuestPhone(data.phone);
          return { success: true };
        }
        return {
          success: false,
          error: data.error ?? "Verification failed.",
        };
      } catch (err) {
        // The API returns 400 for wrong codes, which apiClient throws on.
        // Parse the error message from the response.
        const msg = err instanceof Error ? err.message : "Verification failed.";
        // Try to extract the JSON error body from the HTTP error string
        const match = msg.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const body = JSON.parse(match[0]);
            if (body.error) {
              return { success: false, error: body.error };
            }
          } catch {
            // Fall through to returning the raw message
          }
        }
        return { success: false, error: msg };
      }
    },
    [],
  );

  const clear = useCallback(() => {
    clearSession();
    setGuestToken(null);
    setGuestPhone(null);
  }, []);

  return {
    guestToken,
    guestPhone,
    isVerified: guestToken != null,
    sendOtp,
    verifyOtp,
    clear,
  };
}

/**
 * Get the guest token from localStorage (for use outside of React components,
 * e.g. in App.tsx's token getter).
 */
export function getGuestToken(): string | null {
  return readToken();
}

/**
 * Clear the guest session from localStorage (for use outside of React
 * components, e.g. in App.tsx when the user signs in).
 */
export function clearGuestSession(): void {
  clearSession();
}
