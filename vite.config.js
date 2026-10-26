import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Related: https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
// Replace the HOST env var with SHOPIFY_APP_URL so that it doesn't break the Vite server.
// The CLI will eventually stop passing in HOST,
// so we can remove this workaround after the next major release.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

// The Wishlist Settings preview draws the real storefront stylesheet, which lives in the theme extension. It must NOT be
// imported by its path: Vite would serve it at /extensions/konvert-wishlist/..., and Shopify CLI's dev proxy (and so the
// tunnel Shopify Admin uses) reserves /extensions/* for extension assets and answers 404 "Extension with id ... not found".
// A failed import of that file made the whole app/routes/app.wishlist-settings.jsx module fail to load in Admin, and React
// Router answered by reloading the page. This virtual module hands the same file's text over under a URL the proxy forwards.
const STOREFRONT_CSS = fileURLToPath(new URL("./extensions/konvert-wishlist/assets/konvert-wishlist.css", import.meta.url));
const RESOLVED = "\0virtual:konvert-storefront-css";
const storefrontCss = () => ({
  name: "konvert-storefront-css",
  resolveId: (source) => (source === "virtual:konvert-storefront-css" ? RESOLVED : null),
  load(id) {
    if (id !== RESOLVED) return null;
    this.addWatchFile(STOREFRONT_CSS);
    return `export default ${JSON.stringify(fs.readFileSync(STOREFRONT_CSS, "utf8"))};`;
  },
});

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;
let hmrConfig;

if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT) || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    // Bind IPv4 loopback explicitly. Vite's default "localhost" resolves to ::1 first on Node 17+/Windows, so the server
    // listened on [::1] only while Shopify CLI's dev proxy forwards to 127.0.0.1 (ECONNREFUSED -> blank app in Admin).
    // The port still comes from the CLI-assigned PORT; nothing here is hardcoded to a port or tunnel.
    host: "127.0.0.1",
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      // See https://vitejs.dev/config/server-options.html#server-fs-allow for more information
      allow: ["app", "node_modules"],
    },
  },
  plugins: [storefrontCss(), reactRouter(), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
});
