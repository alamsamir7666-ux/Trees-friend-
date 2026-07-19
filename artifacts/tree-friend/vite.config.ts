import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5173;

const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: true }),
  ],
  define: {
    'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify(process.env.VITE_CLERK_PUBLISHABLE_KEY ?? ''),
    'import.meta.env.VITE_CLERK_PROXY_URL': JSON.stringify(process.env.VITE_CLERK_PROXY_URL ?? ''),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(process.env.VITE_API_BASE_URL ?? ''),
    'import.meta.env.VITE_GA_ID': JSON.stringify(process.env.VITE_GA_ID ?? ''),
    'import.meta.env.VITE_META_PIXEL_ID': JSON.stringify(process.env.VITE_META_PIXEL_ID ?? ''),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    target: "es2020",
    minify: "esbuild",
    chunkSizeWarningLimit: 600,
        modulePreload: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@clerk")) return "clerk";
            if (id.includes("recharts") || id.includes("d3-")) return "page-admin";
            if (id.includes("@radix-ui")) return "radix";
            if (id.includes("react-dom")) return "react-dom";
            if (id.includes("react") && !id.includes("react-dom")) return "react";
            if (id.includes("@tanstack")) return "tanstack-query";
            if (id.includes("lucide-react")) return "lucide";
            if (id.includes("wouter")) return "router";
            return "vendor";
          }
          if (id.includes("/pages/AdminPage")) return "page-admin";
          if (id.includes("/pages/ProductDetailPage")) return "page-product-detail";
          if (id.includes("/pages/CheckoutPage")) return "page-checkout";
          if (id.includes("/pages/BlogPage") || id.includes("/pages/BlogArticlePage")) return "page-blog";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
    sourcemap: false,
    cssCodeSplit: true,
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "wouter",
      "@tanstack/react-query",
      "lucide-react",
      "@clerk/react",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-select",
    ],
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
