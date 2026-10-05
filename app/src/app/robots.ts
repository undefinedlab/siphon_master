import type { MetadataRoute } from "next";
import { ROBOTS_DISALLOW_AGENTS } from "@/lib/botProtection";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: ROBOTS_DISALLOW_AGENTS.map((userAgent) => ({
      userAgent,
      disallow: "/",
    })),
  };
}
