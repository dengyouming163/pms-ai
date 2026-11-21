import type { NextConfig } from 'next';

const PMS_SERVER_URL = process.env.PMS_SERVER_URL || 'http://localhost:9090';
const PMS_AI_URL = process.env.PMS_AI_URL || 'http://localhost:9091';

const nextConfig: NextConfig = {
  allowedDevOrigins: ['*.dev.coze.site'],
  turbopack: {
    root: '..',
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
  async redirects() {
    return [
      {
        source: '/',
        destination: '/rooms',
        permanent: false,
      },
      {
        source: '/data-center',
        destination: '/ai-workspace',
        permanent: false,
      },
      {
        source: '/stores',
        destination: '/staff',
        permanent: false,
      },
      {
        source: '/stores/:path*',
        destination: '/staff',
        permanent: false,
      },
      {
        source: '/brands',
        destination: '/staff',
        permanent: false,
      },
    ];
  },
  // /api/* 由 Next.js 反向代理到 pms-server；本地 compose 与生产前置 nginx 均可复用
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${PMS_SERVER_URL}/api/:path*`,
      },
      {
        source: '/uploads/:path*',
        destination: `${PMS_SERVER_URL}/uploads/:path*`,
      },
    ];
  },
};

export default nextConfig;
