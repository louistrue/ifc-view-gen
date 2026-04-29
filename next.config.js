const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Parent folders may contain another package-lock.json; pin Turbopack’s root to this app.
  turbopack: {
    root: path.join(__dirname),
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    
    // Ensure jszip is properly resolved (client-side only)
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        stream: false,
      };
    }
    
    return config;
  },
};

module.exports = nextConfig;

