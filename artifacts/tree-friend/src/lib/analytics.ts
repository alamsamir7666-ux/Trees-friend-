/**
 * Analytics integration - Google Analytics 4 + Meta Pixel
 *
 * Setup:
 * 1. Add VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX to .env
 * 2. Add VITE_META_PIXEL_ID=XXXXXXXXXX to .env
 *
 * Usage:
 *   import { trackEvent, trackPurchase, trackAddToCart } from "@/lib/analytics";
 */

declare global {
  interface Window {
    gtag: (...args: any[]) => void;
    fbq: (...args: any[]) => void;
    dataLayer: any[];
  }
}

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;
const META_ID = import.meta.env.VITE_META_PIXEL_ID as string | undefined;

// ??? Google Analytics 4 ???????????????????????????????????????????????????????
export function initGA() {
  if (!GA_ID || typeof document === "undefined") return;

  const script = document.createElement("script");
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  script.async = true;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function (...args: any[]) { window.dataLayer.push(args); };
  window.gtag("js", new Date());
  window.gtag("config", GA_ID, { anonymize_ip: true });
}

// ??? Meta Pixel ???????????????????????????????????????????????????????????????
export function initMetaPixel() {
  if (!META_ID || typeof document === "undefined") return;

  (function (f: any, b: any, e: any, v: any) {
    if (f.fbq) return;
    const n: any = (f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    });
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = "2.0";
    n.queue = [];
    const t = b.createElement(e) as HTMLScriptElement;
    t.async = true;
    t.src = v;
    const s = b.getElementsByTagName(e)[0];
    s.parentNode?.insertBefore(t, s);
  })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");

  window.fbq("init", META_ID);
  window.fbq("track", "PageView");
}

// ??? Track page view (called on route change) ?????????????????????????????????
export function trackPageView(path: string) {
  if (GA_ID && window.gtag) {
    window.gtag("config", GA_ID, { page_path: path });
  }
  if (META_ID && window.fbq) {
    window.fbq("track", "PageView");
  }
}

// ??? Track custom event ???????????????????????????????????????????????????????
export function trackEvent(name: string, params?: Record<string, any>) {
  if (GA_ID && window.gtag) {
    window.gtag("event", name, params);
  }
}

// ??? E-commerce Events ????????????????????????????????????????????????????????
export function trackAddToCart(product: { id: number; name: string; price: number; categoryId?: number | null }) {
  trackEvent("add_to_cart", {
    currency: "BDT",
    value: product.price,
    items: [{ item_id: product.id, item_name: product.name, item_category: product.categoryId, price: product.price }],
  });
  if (META_ID && window.fbq) {
    window.fbq("track", "AddToCart", { content_ids: [product.id], content_name: product.name, value: product.price, currency: "BDT" });
  }
}

export function trackViewProduct(product: { id: number; name: string; price: number; categoryId?: number | null }) {
  trackEvent("view_item", {
    currency: "BDT",
    value: product.price,
    items: [{ item_id: product.id, item_name: product.name, item_category: product.categoryId, price: product.price }],
  });
  if (META_ID && window.fbq) {
    window.fbq("track", "ViewContent", { content_ids: [product.id], content_name: product.name, value: product.price, currency: "BDT" });
  }
}

export function trackPurchase(order: { id: number; total: number; items: Array<{ productId: number; productName: string; price: number; quantity: number }> }) {
  trackEvent("purchase", {
    transaction_id: order.id,
    currency: "BDT",
    value: order.total,
    items: order.items.map((i) => ({
      item_id: i.productId,
      item_name: i.productName,
      price: i.price,
      quantity: i.quantity,
    })),
  });
  if (META_ID && window.fbq) {
    window.fbq("track", "Purchase", { value: order.total, currency: "BDT", content_ids: order.items.map((i) => i.productId) });
  }
}

export function trackInitiateCheckout(total: number, itemCount: number) {
  trackEvent("begin_checkout", { currency: "BDT", value: total, num_items: itemCount });
  if (META_ID && window.fbq) {
    window.fbq("track", "InitiateCheckout", { value: total, currency: "BDT", num_items: itemCount });
  }
}

export function trackSearch(term: string) {
  trackEvent("search", { search_term: term });
  if (META_ID && window.fbq) {
    window.fbq("track", "Search", { search_string: term });
  }
}

export function trackSignUp() {
  trackEvent("sign_up");
  if (META_ID && window.fbq) {
    window.fbq("track", "CompleteRegistration");
  }
}
