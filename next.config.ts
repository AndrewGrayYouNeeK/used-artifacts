import type { NextConfig } from "next";

// Test previews (scripts/preview-start.sh) sit behind a tunnel or the Codespaces port proxy,
// whose forwarded host differs from the browser's origin.
const appUrl = process.env.APP_URL ? new URL(process.env.APP_URL) : undefined;

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  allowedDevOrigins: appUrl ? [appUrl.hostname] : [],
  partialPrefetching: true,
  experimental: {
    // Listing photos are downscaled in the browser first; this covers up to 8 of them.
    serverActions: { bodySizeLimit: "12mb", allowedOrigins: appUrl ? [appUrl.host] : [] },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
