/**
 * OtpModal — phone verification modal for Daraz-style guest checkout.
 *
 * Part 2 of the guest checkout implementation.
 *
 * Two-step flow:
 *   1. Phone input — buyer enters their BD phone number, taps "Send Code"
 *   2. Code input — buyer enters the 6-digit code received via WhatsApp/SMS,
 *      taps "Verify"
 *
 * On successful verification, the modal closes and the parent component
 * (CartPage) re-renders — switching from the localStorage guest cart to
 * the server cart (via useGetCart with the guest JWT).
 *
 * The parent also triggers a cart merge (POST /cart/merge) to move the
 * localStorage items into the server cart — see CartPage's onVerified
 * callback.
 *
 * UX details:
 *   - 30-second cooldown on "Resend code" (matches Daraz's resend throttle;
 *     the backend also enforces 3/10min per phone, so the cooldown is a
 *     client-side UX nicety, not the actual rate limit)
 *   - "Change phone" link on step 2 lets the buyer go back to step 1
 *     without losing the already-typed code
 *   - Auto-focus on the code input when step 2 appears
 *   - 6-digit code input with numeric keyboard (inputMode="numeric")
 *   - Error messages from the backend are shown verbatim ("Incorrect code.
 *     4 attempts remaining.") so the buyer knows how many tries they have left
 */

import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Phone, ShieldCheck, Loader2, ArrowLeft } from "lucide-react";
import { useGuestSession } from "@/hooks/useGuestSession";

interface OtpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after successful verification — parent uses this to trigger cart merge. */
  onVerified?: () => void;
  /**
   * Optional pre-filled phone number (e.g. from the shipping address form
   * on the checkout page). When provided, the phone input is pre-filled
   * so the buyer doesn't have to re-type their number. Industry standard
   * — Daraz pre-fills from the buyer's profile.
   */
  initialPhone?: string;
}

const RESEND_COOLDOWN_SECONDS = 30;

export function OtpModal({ open, onOpenChange, onVerified, initialPhone }: OtpModalProps) {
  const { sendOtp, verifyOtp } = useGuestSession();
  const [step, setStep] = useState<1 | 2>(1);
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the code input when step 2 appears
  useEffect(() => {
    if (step === 2 && open) {
      setTimeout(() => codeInputRef.current?.focus(), 100);
    }
  }, [step, open]);

  // Resend cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // Reset state when the modal is closed
  useEffect(() => {
    if (!open) {
      // Small delay so the close animation doesn't show the reset
      setTimeout(() => {
        setStep(1);
        setPhone(initialPhone ?? "");
        setCode("");
        setError("");
        setCooldown(0);
      }, 200);
    }
  }, [open, initialPhone]);

  async function handleSendCode() {
    setError("");
    if (!phone.trim()) {
      setError("Please enter your phone number.");
      return;
    }
    setLoading(true);
    const result = await sendOtp(phone.trim());
    setLoading(false);

    if (result.success) {
      setStep(2);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } else if (result.retryAfter) {
      // Cooldown active — show the backend's retryAfter value
      setCooldown(result.retryAfter);
      setStep(2); // Move to step 2 so the buyer sees the resend timer
      setError(result.error ?? `Please wait ${result.retryAfter}s before requesting a new code.`);
    } else {
      setError(result.error ?? "Failed to send code. Please try again.");
    }
  }

  async function handleResend() {
    if (cooldown > 0) return;
    setError("");
    setLoading(true);
    const result = await sendOtp(phone.trim());
    setLoading(false);

    if (result.success) {
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setCode(""); // Clear any previously-typed code
      codeInputRef.current?.focus();
    } else {
      setError(result.error ?? "Failed to resend code. Please try again.");
    }
  }

  async function handleVerify() {
    setError("");
    if (code.length !== 6) {
      setError("Please enter the 6-digit code.");
      return;
    }
    setLoading(true);
    const result = await verifyOtp(phone.trim(), code);
    setLoading(false);

    if (result.success) {
      onOpenChange(false);
      onVerified?.();
    } else {
      setError(result.error ?? "Verification failed. Please try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 1 ? (
              <>
                <Phone className="h-5 w-5 text-accent" />
                Verify your phone
              </>
            ) : (
              <>
                <ShieldCheck className="h-5 w-5 text-accent" />
                Enter the code
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {step === 1
              ? "We'll send a verification code via WhatsApp to this number."
              : (
                <>
                  Sent to <span className="font-medium text-foreground">{phone}</span>.{" "}
                  Enter the 6-digit code to continue.
                </>
              )}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          // Step 1: Phone input
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="otp-phone">Phone number</Label>
              <Input
                id="otp-phone"
                type="tel"
                inputMode="tel"
                placeholder="01XXXXXXXXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !loading) handleSendCode();
                }}
                className="text-base"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                e.g. 01712345678 — we'll send a code via WhatsApp.
              </p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              onClick={handleSendCode}
              disabled={loading || !phone.trim()}
              className="w-full rounded-full h-11"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                "Send Code"
              )}
            </Button>
          </div>
        ) : (
          // Step 2: Code input
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="otp-code">Verification code</Label>
              <Input
                ref={codeInputRef}
                id="otp-code"
                type="text"
                inputMode="numeric"
                pattern="\d*"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !loading && code.length === 6) handleVerify();
                }}
                className="text-center text-2xl tracking-[0.5em] font-semibold"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              onClick={handleVerify}
              disabled={loading || code.length !== 6}
              className="w-full rounded-full h-11"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Verifying...
                </>
              ) : (
                "Verify & Continue"
              )}
            </Button>

            <div className="flex items-center justify-between text-sm">
              <button
                onClick={() => {
                  setStep(1);
                  setError("");
                  setCode("");
                }}
                className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Change phone
              </button>

              <button
                onClick={handleResend}
                disabled={cooldown > 0 || loading}
                className="text-accent hover:text-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
