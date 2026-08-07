import { isBotRequest, injectMeta, SITE_BASE, API_BASE } from "./_og.js";

interface Product {
  id: number;
  name: string;
  description: string;
  images: string[];
  price: number;
  discountPrice?: number | null;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userAgent = request.headers.get("user-agent");

    const match = url.pathname.match(/^\/products\/(\d+)/);
    const id = match?.[1];

    const indexHtml = await fetch(`${url.origin}/index.html`).then((r) => r.text());

    if (!isBotRequest(userAgent) || !id) {
      return new Response(indexHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    try {
      const res = await fetch(`${API_BASE}/api/products/${id}`);
      if (!res.ok) {
        return new Response(indexHtml, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const product = (await res.json()) as Product;
      const price = product.discountPrice ?? product.price;

      const html = injectMeta(indexHtml, {
        title: product.name,
        description: product.description,
        image: product.images?.[0] ?? "/opengraph.jpg",
        url: `${SITE_BASE}/products/${product.id}`,
        type: "product",
        priceAmount: price,
        priceCurrency: "BDT",
      });

      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300, s-maxage=600",
        },
      });
    } catch (err) {
      console.error("[og-product] failed:", err);
      return new Response(indexHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  },
};
