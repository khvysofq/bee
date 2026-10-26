import { LandingView } from '@/components/LandingView';
import { loadLandingData } from '@/lib/landing-data';

export const dynamic = 'force-dynamic';

/**
 * 面向最终用户的 MVP 落地页（GUA-26 / P0-6）。
 * 原「数据底座状态页」迁移至 /status；本页所有数字来自 daily_quote / derived_indicator
 * （loadLandingData 复用 P0-4 briefing 查询逻辑），禁止手写价格。
 */
export default async function HomePage() {
  let data: Awaited<ReturnType<typeof loadLandingData>> | null = null;
  let error: string | null = null;
  try {
    data = await loadLandingData();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (error) {
    return (
      <main className="container container-narrow">
        <h1>bee · 再生材料行情每日简报</h1>
        <div className="error">
          <p>行情数据读取失败：{error}</p>
          <p>
            本地起库并生成 P0-3 fixture 数据链：
            <code>docker compose up -d postgres && pnpm db:migrate && pnpm db:seed && pnpm data:fixture</code>
          </p>
        </div>
      </main>
    );
  }

  if (!data) return null;

  return <LandingView data={data} />;
}
