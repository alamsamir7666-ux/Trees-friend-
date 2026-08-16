/**
 * Unit tests for the YouTube session cookie validator.
 *
 * The validator runs at module load and logs a warning if
 * YOUTUBE_SESSION_COOKIE is set but missing critical auth cookies
 * (__Secure-1PSID, __Secure-3PSID, HSID, SSID).
 *
 * Since the validator runs at module load (not as an exported function),
 * we re-implement the validation logic inline here and test it directly.
 * Keep in sync with lib/youtubeTranscript.ts:validateYoutubeSessionCookie.
 *
 * If you edit the validator in youtubeTranscript.ts, edit the local copy
 * below too.
 */
import { describe, expect, it } from "vitest";

// ─── Local copy of the validation logic ─────────────────────────────────────
// Keep in sync with artifacts/api-server/src/lib/youtubeTranscript.ts.

const CRITICAL_YOUTUBE_COOKIES = ["__Secure-1PSID", "__Secure-3PSID", "HSID", "SSID"];

function findMissingCriticalCookies(cookieStr: string | undefined): string[] {
  if (!cookieStr || !cookieStr.trim()) {
    // No cookie configured — return empty (not an error case).
    return [];
  }
  const present = new Set<string>();
  for (const part of cookieStr.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    present.add(trimmed.slice(0, eqIdx).trim());
  }
  return CRITICAL_YOUTUBE_COOKIES.filter((name) => !present.has(name));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("YouTube cookie validator", () => {
  it("returns empty array when no cookie is configured (not an error)", () => {
    expect(findMissingCriticalCookies(undefined)).toEqual([]);
    expect(findMissingCriticalCookies("")).toEqual([]);
    expect(findMissingCriticalCookies("   ")).toEqual([]);
  });

  it("detects all 4 critical cookies as missing when cookie has none of them", () => {
    // A cookie with only non-critical cookies (e.g. just PREF + SID)
    const cookie = "PREF=f6=40000000; SID=abc123";
    const missing = findMissingCriticalCookies(cookie);
    expect(missing).toEqual(["__Secure-1PSID", "__Secure-3PSID", "HSID", "SSID"]);
  });

  it("detects the user's actual incomplete cookie (from the bug report)", () => {
    // This is the exact cookie the user reported in the bug report —
    // it has SID, APISID, SAPISID, __Secure-1PAPISID, __Secure-3PAPISID,
    // PREF, SIDCC but is missing the 4 critical ones.
    const userCookie =
      "PREF=f6=40000000&tz=Asia.Dhaka; APISID=a2Dk0-xcAHPrYcBl/AIa-hmoINkdD1ksRG; " +
      "SAPISID=Y8x1daObPpVzQXHt/AKDO2rJtYayU24Z5i; " +
      "__Secure-1PAPISID=Y8x1daObPpVzQXHt/AKDO2rJtYayU24Z5i; " +
      "__Secure-3PAPISID=Y8x1daObPpVzQXHt/AKDO2rJtYayU24Z5i; " +
      "SID=g.a000BgmgCYvH6TC0cGfC-Q-hWmF-afrAK7u5R0CCpNZaPKljLo7CuSVPigUfxKr3y44vf_q7WwACgYKAQ4SARQSFQHGX2MiJP4ELAuIInkucc_SOReXHhoVAUF8yKphg0WgQgHP6F6m1KXVlF2j0076; " +
      "SIDCC=AKEyXzUaUxnM-4gNlztqXzJNyNDpaWWvKbDzlaIMWDFtTyH8qxJ-_-3F3Uu9awomnN1selL2KQ";
    const missing = findMissingCriticalCookies(userCookie);
    expect(missing).toEqual(["__Secure-1PSID", "__Secure-3PSID", "HSID", "SSID"]);
  });

  it("returns empty array when ALL critical cookies are present", () => {
    const completeCookie =
      "__Secure-1PSID=abc; __Secure-3PSID=def; HSID=ghi; SSID=jkl; " +
      "SID=mno; APISID=pqr; SAPISID=stu; PREF=vwx";
    const missing = findMissingCriticalCookies(completeCookie);
    expect(missing).toEqual([]);
  });

  it("detects partial missing (only 2 of 4 critical present)", () => {
    const partialCookie = "__Secure-1PSID=abc; HSID=def; SID=ghi";
    const missing = findMissingCriticalCookies(partialCookie);
    expect(missing).toEqual(["__Secure-3PSID", "SSID"]);
  });

  it("handles whitespace and malformed entries gracefully", () => {
    // Cookies with extra whitespace, empty entries, and entries without =
    const messyCookie = "  __Secure-1PSID=abc  ;  ; ; HSID=def ; malformedEntry ; SSID=ghi  ";
    const missing = findMissingCriticalCookies(messyCookie);
    // __Secure-3PSID is missing
    expect(missing).toEqual(["__Secure-3PSID"]);
  });

  it("is case-sensitive on cookie names (YouTube cookies ARE case-sensitive)", () => {
    // YouTube cookie names are case-sensitive. A cookie named
    // "__secure-1psid" (lowercase) is NOT the same as "__Secure-1PSID".
    const wrongCaseCookie = "__secure-1psid=abc; __secure-3psid=def; hsid=ghi; ssid=jkl";
    const missing = findMissingCriticalCookies(wrongCaseCookie);
    // All 4 should be detected as missing because the case is wrong.
    expect(missing).toEqual(["__Secure-1PSID", "__Secure-3PSID", "HSID", "SSID"]);
  });
});
