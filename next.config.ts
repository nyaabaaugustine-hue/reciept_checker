import type { NextConfig } from 'next';

// #70 — Warn at build time if GROQ_API_KEY is missing
if (!process.env.GROQ_API_KEY) {
  console.warn(
    '\n⚠️  WARNING: GROQ_API_KEY is not set.\n' +
    '   Invoice scanning will fail at runtime.\n' +
    '   Add it to your .env.local file:\n' +
    '   GROQ_API_KEY=gsk_...\n'
  );
}


const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'placehold.co', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'images.unsplash.com', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'picsum.photos', port: '', pathname: '/**' },
    ],
  },
  // Expose non-secret env vars to the client if needed
  env: {
    NEXT_PUBLIC_APP_VERSION: '2.0.0',
  },
};

export default nextConfig;
