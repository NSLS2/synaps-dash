import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ['knex', 'pg', 'better-sqlite3'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'tiled.nsls2.bnl.gov',
      },
    ],
  },
};

export default nextConfig;
