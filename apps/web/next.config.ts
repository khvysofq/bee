import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 工作区包直接消费 TS 源码，交给 Next 编译。
  transpilePackages: ['@bee/db', '@bee/core', '@bee/pipeline'],
};

export default nextConfig;
