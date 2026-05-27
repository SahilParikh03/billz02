import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @huggingface/transformers (optional, MiniLM embedder) uses native Node
  // features (onnxruntime); keep it out of the Server Components bundle so it
  // loads via native require. Next auto-externalizes it too, but be explicit.
  serverExternalPackages: ["@huggingface/transformers"],
};

export default nextConfig;
