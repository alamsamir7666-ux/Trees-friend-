import { pathaoAdapter } from "./pathao";
import { steadfastAdapter } from "./steadfast";
import type { CourierAdapter } from "./types";

export * from "./types";

const ADAPTERS: Record<"pathao" | "steadfast", CourierAdapter> = {
  pathao: pathaoAdapter,
  steadfast: steadfastAdapter,
};

/**
 * Returns the adapter for a verified provider, or null for "manual" /
 * unrecognized providers -- callers (routes/orderShipments.ts) treat null
 * as "no API integration, fall back to manual status updates" per plan doc
 * §8, not as an error.
 */
export function getCourierAdapter(provider: string): CourierAdapter | null {
  if (provider === "pathao" || provider === "steadfast") return ADAPTERS[provider];
  return null;
}
