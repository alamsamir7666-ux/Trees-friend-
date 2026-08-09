import { Router } from "express";
import type { z } from "zod";
import { clerkClient } from "@clerk/express";
import { signTokenPair, verifyRefreshToken } from "../middlewares/mobileJwt";
import { authLimiter } from "../middlewares/rateLimiter";
import { validateBody } from "../lib/validateRequest";
import { asyncHandler, HttpError } from "../lib/errors";
import {
  MobileSignInBody,
  MobileSignUpBody,
  MobileRefreshBody,
} from "../lib/schemas";

const router = Router();

/**
 * POST /api/mobile-auth/sign-in
 * Body: { email: string, password: string }
 *
 * Returns an access token (1h) + refresh token (30d). The Flutter app
 * should store the refresh token securely (Keychain/Keystore) and call
 * /mobile-auth/refresh before the access token expires.
 */
router.post(
  "/mobile-auth/sign-in",
  authLimiter,
  validateBody(MobileSignInBody, "MobileSignInBody"),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof MobileSignInBody>;
    const normalizedEmail = email.trim().toLowerCase();

    const { data: users } = await clerkClient.users.getUserList({
      emailAddress: [normalizedEmail],
      limit: 1,
    });

    const user = users[0];
    if (!user) {
      throw new HttpError(401, "Invalid email or password");
    }

    try {
      await clerkClient.users.verifyPassword({
        userId: user.id,
        password,
      });
    } catch {
      throw new HttpError(401, "Invalid email or password");
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
  }),
);

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
router.post(
  "/mobile-auth/refresh",
  authLimiter,
  validateBody(MobileRefreshBody, "MobileRefreshBody"),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof MobileRefreshBody>;

    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      throw new HttpError(401, "Invalid or expired refresh token");
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
  }),
);

/**
 * POST /api/mobile-auth/sign-up
 * Body: { email, password, firstName?, lastName? }
 *
 * Returns an access token (1h) + refresh token (30d), same as sign-in.
 */
router.post(
  "/mobile-auth/sign-up",
  authLimiter,
  validateBody(MobileSignUpBody, "MobileSignUpBody"),
  asyncHandler(async (req, res) => {
    const { email, password, firstName, lastName } = req.body as z.infer<typeof MobileSignUpBody>;
    const normalizedEmail = email.trim().toLowerCase();

    try {
      const user = await clerkClient.users.createUser({
        emailAddress: [normalizedEmail],
        password,
        firstName: firstName ?? undefined,
        lastName: lastName ?? undefined,
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
    } catch (err) {
      // Clerk's error shape: { errors: [{ message, code }] }
      const clerkErr = err as { errors?: { message?: string; code?: string }[] };
      const clerkMessage = clerkErr?.errors?.[0]?.message;
      // Re-throw as a 400 HttpError so the global handler logs + responds uniformly.
      // Expose the Clerk message (it's user-facing: "Email already in use", etc.)
      throw new HttpError(400, clerkMessage ?? "Sign-up failed. Please try again.", {
        code: clerkErr?.errors?.[0]?.code,
        expose: true,
        cause: err,
      });
    }
  }),
);

export default router;
