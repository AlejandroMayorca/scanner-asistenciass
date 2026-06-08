import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['zxing-wasm'],
};

export default nextConfig;
