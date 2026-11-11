import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "@electric-sql/pglite",
    "pg",
    "youtubei.js",
    "quickjs-emscripten",
    "bgutils-js",
    "jsdom",
  ],
  outputFileTracingIncludes: { "/*": ["./youtube-runtime/*.mjs"] },
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  images: { unoptimized: true },
  async redirects() {
    const legacyPlayerRoutes = [
      "search",
      "library",
      "liked",
      "mix",
      "playlist",
      "album",
      "artist",
      "queue",
      "history",
      "recommendations",
      "import",
      "account",
      "settings",
    ];
    return [
      ...(process.env.APP_URL === "https://aurelia.lattelix.com"
        ? [
            {
              source: "/:path*",
              has: [
                {
                  type: "host" as const,
                  value: "aurelia-music\\.vercel\\.app",
                },
              ],
              destination: "https://aurelia.lattelix.com/:path*",
              permanent: true,
            },
          ]
        : []),
      ...legacyPlayerRoutes.map((route) => ({
        source: `/${route}/:path*`,
        destination: `/app/${route}/:path*`,
        permanent: false,
      })),
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};
export default config;
