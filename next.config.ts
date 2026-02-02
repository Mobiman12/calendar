import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const remoteImageHosts = [
  { protocol: "http", hostname: "localhost", port: "3003" },
  { protocol: "http", hostname: "127.0.0.1", port: "3003" },
  { protocol: "http", hostname: "localhost", port: "3002" },
  { protocol: "http", hostname: "127.0.0.1", port: "3002" },
];

const controlPlaneUrl = process.env.CONTROL_PLANE_URL?.trim();
if (controlPlaneUrl) {
  try {
    const parsed = new URL(controlPlaneUrl);
    remoteImageHosts.push({
      protocol: parsed.protocol.replace(":", ""),
      hostname: parsed.hostname,
      ...(parsed.port ? { port: parsed.port } : {}),
    });
  } catch {
    // Ignore invalid URLs to keep Next config stable.
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  images: {
    remotePatterns: remoteImageHosts,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
