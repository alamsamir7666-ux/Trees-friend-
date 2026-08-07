import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { signMobileJwt, signTokenPair, verifyRefreshToken } from "../middlewares/mobileJwt";
import { authLimiter } from "../middlewares/rateLimiter";
import { logger } from "../lib/logger";

const router = Router();

/**
 * POST /api/mobile-auth/sign-in
 * Body: { email: string, password: string }
 *
 * Returns an access token (1h) + refresh token (30d). The Flutter app
 * should store the refresh token securely (Keychain/Keystore) and call
 * /mobile-auth/refresh before the access token expires.
 */
router.post("/mobile-auth/sign-in", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    const { data: users } = await clerkClient.users.getUserList({
      emailAddress: [normalizedEmail],
      limit: 1,
    });

    const user = users[0];
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    try {
      await clerkClient.users.verifyPassword({
        userId: user.id,
        password,
      });
    } catch {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const primaryEmail =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
      normalizedEmail;

    const { accessToken, refreshToken, expiresIn } = signTokenPair({
      clerkId: user.id,
      email: primaryEmail,
    });

    res.json({
      token: accessToken,
      refreshToken,
      expiresIn,
      user: {
        id: user.id,
        email: primaryEmail,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (err) {
    logger.error({ err }, "Mobile sign-in error");
    res.status(500).json({ error: "Sign-in failed. Please try again." });
  }
});

/**
 * POST /api/mobile-auth/refresh
 * Body: { refreshToken: string }
 *
 * Validates a refresh token and issues a NEW access + refresh token pair.
 * The old refresh token is implicitly invalidated by rotation (the client
 * must use the new one). This is the industry-standard refresh-token
 * rotation pattern:
 *
 *   1. Client stores refresh token securely (Keychain/Keystore)
 *   2. Before access token expires (1h), client calls /refresh
 *   3. Server validates refresh token, returns new pair
 *   4. Client discards old refresh token, stores new one
 *   5. If an attacker stole the old refresh token, it's now useless
 *      (the legitimate user has already rotated to a new one)
 *
 * Rate-limited at 20/15min (same as sign-in) to prevent brute-force.
 */
router.post("/mobile-auth/refresh", authLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== "string" || !refreshToken) {
      res.status(400).json({ error: "Refresh token is required" });
      return;
    }

    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    // Issue a new token pair (rotation)
    const { accessToken, refreshToken: newRefreshToken, expiresIn } = signTokenPair({
      clerkId: payload.clerkId,
      email: payload.email,
    });

    res.json({
      token: accessToken,
      refreshToken: newRefreshToken,
      expiresIn,
    });
  } catch (err) {
    logger.error({ err }, "Token refresh error");
    res.status(500).json({ error: "Token refresh failed" });
  }
});

/**
 * POST /api/mobile-auth/sign-up
 * Body: { email, password, firstName?, lastName? }
 *
 * Returns an access token (1h) + refresh token (30d), same as sign-in.
 */
router.post("/mobile-auth/sign-up", authLimiter, async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    const user = await clerkClient.users.createUser({
      emailAddress: [normalizedEmail],
      password,
      firstName: typeof firstName === "string" ? firstName : undefined,
      lastName: typeof lastName === "string" ? lastName : undefined,
    });

    const { accessToken, refreshToken, expiresIn } = signTokenPair({
      clerkId: user.id,
      email: normalizedEmail,
    });

    res.status(201).json({
      token: accessToken,
      refreshToken,
      expiresIn,
      user: {
        id: user.id,
        email: normalizedEmail,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "Mobile sign-up error");
    const clerkMessage = err?.errors?.[0]?.message;
    res.status(400).json({ error: clerkMessage ?? "Sign-up failed. Please try again." });
  }
});

export default router;
