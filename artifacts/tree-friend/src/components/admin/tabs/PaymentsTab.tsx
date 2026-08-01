import { PlatformPaymentConfigSection } from "./PlatformPaymentConfigSection";
import { PayoutsSection } from "./PayoutsSection";

/**
 * Admin "Payments" tab -- Part 4 of 4 (see PART4_HANDOFF.md). New tab,
 * did not exist before this part. Groups the two things this part's
 * prompt scoped together: the platform's bKash merchant config (item 1 --
 * "wherever the admin can currently view/set the platform config, which
 * may be minimal or nonexistent, and add a Test Connection button there,
 * creating the surrounding admin UI section if it doesn't exist yet") and
 * seller payout visibility/retry/notes (items 2-3).
 *
 * Verified there was no existing slot for this before creating a new tab
 * (per Part 1's own handoff, which explicitly said this wasn't trivial to
 * slot into SettingsTab.tsx/SellersTab.tsx): SettingsTab.tsx is a static
 * read-only settings display with no form infrastructure, and
 * SellersTab.tsx is scoped to per-SELLER config review, not the platform's
 * own single account. A dedicated tab mirrors how AffiliatesTab.tsx
 * already groups a primary resource (affiliates) with a secondary,
 * related one (CashoutsSection, rendered inside it) -- same shape here,
 * just as its own top-level tab rather than nested in an existing one,
 * since payments/payouts isn't a sub-concern of any existing tab's
 * primary resource.
 */
export function PaymentsTab() {
  return (
    <div className="space-y-8">
      <PlatformPaymentConfigSection />
      <PayoutsSection />
    </div>
  );
}
