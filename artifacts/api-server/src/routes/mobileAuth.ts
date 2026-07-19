import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { signMobileJwt } from "../middlewares/mobileJwt";

const router = Router();

/**
 * POST /api/mobile-auth/sign-in
 * Body: { email: string, password: string }
 *
 * Verifies credentials against Clerk's Backend API (never touches Clerk's
 * Frontend API, which is not recommended for direct native integration —
 * see https://clerk.com/docs/guides/how-clerk-works/overview). On success,
 * mints our own mobile session JWT for the Flutter app to use as a Bearer
 * token on all subsequent API calls.
 */
router.post("/mobile-auth/sign-in", async (req, res) => {
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
      // Deliberately vague — don't reveal whether the email exists.
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

    const token = signMobileJwt({ clerkId: user.id, email: primaryEmail });

    res.json({
      token,
      user: {
        id: user.id,
        email: primaryEmail,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (err) {
    console.error("Mobile sign-in error:", err);
    res.status(500).json({ error: "Sign-in failed. Please try again." });
  }
});

/**
 * POST /api/mobile-auth/sign-up
 * Body: { email: string, password: string, firstName?: string, lastName?: string }
 *
 * Creates a new Clerk user directly via the Backend API. Note this skips
 * Clerk's email verification step (createUser() marks the email as
 * verified automatically) — acceptable for this app's needs, but if you
 * want email verification for mobile sign-ups too, that would need to be
 * layered on separately (e.g. your own verification-code email flow).
 */
router.post("/mobile-auth/sign-up", async (req, res) => {
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

    const token = signMobileJwt({ clerkId: user.id, email: normalizedEmail });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: normalizedEmail,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (err: any) {
    console.error("Mobile sign-up error:", err);
    // Clerk returns structured errors with a `errors` array; surface the
    // first message if present (e.g. "That email address is taken").
    const clerkMessage = err?.errors?.[0]?.message;
    res.status(400).json({ error: clerkMessage ?? "Sign-up failed. Please try again." });
  }
});

export default router;
