import type { NextConfig } from 'next';

const PMS_SERVER_URL = process.env.PMS_SERVER_URL || 'http://132.232.166.40:20002';
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
  // 生产环境由 nginx 反向代理处理 /api/* → pms-server:20002
  // 本地开发通过 rewrite 转发到后端
  async rewrites() {
    if (process.env.NODE_ENV === 'development') {
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
    }
    return [];
  },
};

export default nextConfig;
