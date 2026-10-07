import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';
import { securityHeaderEntries } from './lib/botProtection';

const withMDX = createMDX();

const config: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaderEntries(),
      },
    ];
  },
};

export default withMDX(config);
