/**
 * useGuestSession — manages the phone-verified guest session with
 * access + refresh token rotation.
 *
 * Part 2 of the Daraz-style guest checkout.
 *
 * State machine:
 *   1. Not signed in, not verified → localStorage cart (useGuestCart)
 *   2. Not signed in, verified → server cart (useGetCart with guest JWT)
 *   3. Signed in → server cart (useGetCart with Clerk JWT)
 *
 * Token lifecycle:
 *   - Access token (30 min): attached as `Authorization: Bearer` on every request
 *   - Refresh token (7 days): stored in localStorage, used ONLY to obtain
 *     new access tokens via POST /auth/guest-otp/refresh
 *   - When the access token expires, the next API call returns 401 → the
 *     frontend silently calls the refresh endpoint → gets a new access
 *     token → retries the original request. The buyer sees no interruption.
 *   - If the refresh token is also expired (7 days), the buyer must
 *     re-verify their phone via OTP.
 *
 * Storage:
 *   - GUEST_TOKEN_KEY: the access token (read on every request by App.tsx's
 *     TokenSync, which attaches it as Authorization: Bearer)
 *   - GUEST_REFRESH_TOKEN_KEY: the refresh token (used only by this hook's
 *     refreshAccessToken function)
 *   - GUEST_PHONE_KEY: the verified phone number (for display + account claim)
 */

import { useState, useCallback, useEffect } from "react";
import { apiClient } from "@/lib/apiClient";

const GUEST_TOKEN_KEY = "treefriend_guest_token";
const GUEST_REFRESH_TOKEN_KEY = "treefriend_guest_refresh_token";
const GUEST_PHONE_KEY = "treefriend_guest_phone";

function readToken(): string | null {
  try {
    return localStorage.getItem(GUEST_TOKEN_KEY);
  } catch {
    return null;
  }
}

function readRefreshToken(): string | null {
  try {
    return localStorage.getItem(GUEST_REFRESH_TOKEN_KEY);
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

function writeSession(accessToken: string, refreshToken: string, phone: string): void {
  try {
    localStorage.setItem(GUEST_TOKEN_KEY, accessToken);
    localStorage.setItem(GUEST_REFRESH_TOKEN_KEY, refreshToken);
    localStorage.setItem(GUEST_PHONE_KEY, phone);
  } catch {
    // localStorage unavailable (private mode) — non-critical
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(GUEST_TOKEN_KEY);
    localStorage.removeItem(GUEST_REFRESH_TOKEN_KEY);
    localStorage.removeItem(GUEST_PHONE_KEY);
  } catch {
    // Same as above
  }
}

// ─── Refresh token singleton ──────────────────────────────────────────────────
//
// The refresh logic needs to be callable from OUTSIDE React (specifically,
// from the apiClient's 401 interceptor, which isn't a React component).
// We use a module-level singleton that's set up by the useGuestSession
// hook on mount, and can be called by the interceptor without React context.

let _refreshFn: (() => Promise<string | null>) | null = null;

/**
 * Try to refresh the guest access token using the stored refresh token.
 * Called by the 401 interceptor when a guest request fails with 401.
 *
 * Returns the new access token on success, or null on failure (refresh
 * token expired, not a guest session, etc.). The caller should retry
 * the original request with the new token, or redirect to re-verification.
 *
 * This function is safe to call from outside React (it reads localStorage
 * directly, not from React state).
 */
export async function tryRefreshGuestToken(): Promise<string | null> {
  const refreshToken = readRefreshToken();
  if (!refreshToken) return null;

  try {
    const { data } = await apiClient.post<{
      success: boolean;
      guestToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      error?: string;
    }>("/auth/guest-otp/refresh", { refreshToken });

    if (data.success && data.guestToken && data.refreshToken) {
      // Store the new token pair
      const phone = readPhone();
      if (phone) {
        writeSession(data.guestToken, data.refreshToken, phone);
      }
      return data.guestToken;
    }
    return null;
  } catch {
    // Refresh failed (expired refresh token, network error, etc.)
    // The caller should redirect to re-verification.
    return null;
  }
}

export interface GuestSession {
  /** The guest access token, or null if not verified. */
  guestToken: string | null;
  /** The verified phone number (normalized bare-local form). */
  guestPhone: string | null;
  /** True if the guest has a valid-looking token (not necessarily unexpired). */
  isVerified: boolean;

  /**
   * Send an OTP to the given phone number.
   * Returns { success: true } on success, { success: false, error } on failure.
   * Returns { success: false, retryAfter } when the cooldown is active.
   */
  sendOtp: (phone: string) => Promise<{
    success: boolean;
    error?: string;
    retryAfter?: number;
  }>;

  /**
   * Verify the OTP code for the given phone number.
   * On success: stores the guest token pair (access + refresh), sets isVerified = true.
   * On failure: returns { success: false, error }.
   */
  verifyOtp: (
    phone: string,
    code: string,
  ) => Promise<{ success: boolean; error?: string }>;

  /** Clear the guest session (on sign-in, logout, or refresh failure). */
  clear: () => void;
}

export function useGuestSession(): GuestSession {
  const [guestToken, setGuestToken] = useState<string | null>(readToken);
  const [guestPhone, setGuestPhone] = useState<string | null>(readPhone);

  // Listen for storage events (cross-tab sync)
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

  // Register the refresh function so the 401 interceptor can call it.
  // This is set on every render — safe because it's idempotent.
  useEffect(() => {
    _refreshFn = async () => {
      const newToken = await tryRefreshGuestToken();
      if (newToken) {
        setGuestToken(newToken);
      } else {
        // Refresh failed — clear the session entirely so the buyer
        // sees the OTP modal again.
        clearSession();
        setGuestToken(null);
        setGuestPhone(null);
      }
      return newToken;
    };
    return () => {
      _refreshFn = null;
    };
  }, []);

  const sendOtp = useCallback(async (phone: string) => {
    try {
      const { data } = await apiClient.post<{
        success: boolean;
        expiresInMs?: number;
        retryAfter?: number;
      }>("/auth/guest-otp/send", { phone });

      if (!data.success && data.retryAfter) {
        return {
          success: false,
          error: `Please wait ${data.retryAfter}s before requesting a new code.`,
          retryAfter: data.retryAfter,
        };
      }
      return { success: data.success === true };
    } catch (err) {
      // Check for 429 with retryAfter in the error message
      const msg = err instanceof Error ? err.message : "Failed to send code.";
      const match = msg.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const body = JSON.parse(match[0]);
          if (body.retryAfter) {
            return {
              success: false,
              error: `Please wait ${body.retryAfter}s before requesting a new code.`,
              retryAfter: body.retryAfter,
            };
          }
          if (body.error) {
            return { success: false, error: body.error };
          }
        } catch {
          // Fall through
        }
      }
      return {
        success: false,
        error: msg,
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
          refreshToken?: string;
          expiresIn?: number;
          error?: string;
        }>("/auth/guest-otp/verify", { phone, code });

        if (data.success && data.guestToken && data.refreshToken && data.phone) {
          writeSession(data.guestToken, data.refreshToken, data.phone);
          setGuestToken(data.guestToken);
          setGuestPhone(data.phone);
          return { success: true };
        }
        return {
          success: false,
          error: data.error ?? "Verification failed.",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Verification failed.";
        const match = msg.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const body = JSON.parse(match[0]);
            if (body.error) {
              return { success: false, error: body.error };
            }
          } catch {
            // Fall through
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
 * Get the guest access token from localStorage (for use outside of React
 * components, e.g. in App.tsx's token getter).
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
