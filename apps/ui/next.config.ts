import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @trade-bot/shared is a workspace package with no build step (its
  // package.json points main/types straight at src/*.ts) — Next.js
  // doesn't transpile TS inside node_modules-resolved packages by default,
  // this opts it in. See CLAUDE.md Phase 0's note-to-self on this.
  transpilePackages: ["@trade-bot/shared"],
};

export default nextConfig;
