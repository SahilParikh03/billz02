import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @huggingface/transformers (optional, MiniLM embedder) uses native Node
  // features (onnxruntime); keep it out of the Server Components bundle so it
  // loads via native require. Next auto-externalizes it too, but be explicit.
  serverExternalPackages: ["@huggingface/transformers"],

  // Canonical host is app.askbeamr.com. Both the bare apex (askbeamr.com) and
  // www 308 to it, preserving path + query. Vercel edge-redirects the apex to
  // www, so www is the host that actually reaches Next for "plain domain"
  // traffic — match both. Next anchors the host matcher (^...$), and the "app."
  // prefix can't match "(www.)?askbeamr.com", so there's no redirect loop.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "(www\\.)?askbeamr\\.com" }],
        destination: "https://app.askbeamr.com/:path*",
        permanent: true,
        basePath: false,
      },
    ];
  },
};

export default nextConfig;
