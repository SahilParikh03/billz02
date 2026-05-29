import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @huggingface/transformers (optional, MiniLM embedder) uses native Node
  // features (onnxruntime); keep it out of the Server Components bundle so it
  // loads via native require. Next auto-externalizes it too, but be explicit.
  serverExternalPackages: ["@huggingface/transformers"],
  // The backend serves only app.askbeamr.com. The bare apex + www serve the
  // marketing FE (separate Vercel project), so no host redirect lives here.
};

export default nextConfig;
