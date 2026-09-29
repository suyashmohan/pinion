import type { NextConfig } from "next";

// LAN device origins allowed to reach Next.js dev resources (HMR) while
// running `bun run dev`. Empty by default — loopback always works. Set
// PINION_ALLOWED_DEV_ORIGINS="host1,host2" when testing from a phone/tablet.
const allowedDevOrigins = (process.env.PINION_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
  // No serverExternalPackages needed: sqlite comes from the Bun runtime
  // itself (`bun:sqlite`), not from a native npm addon.
};

export default nextConfig;
