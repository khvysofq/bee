import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 工作区包直接消费 TS 源码，交给 Next 编译。
  transpilePackages: ['@bee/db', '@bee/core', '@bee/pipeline'],
  // 截图验收需要干净画面：关闭 dev 模式左下角悬浮指示器（仅影响 dev 展示）。
  devIndicators: false,
};

export default nextConfig;
