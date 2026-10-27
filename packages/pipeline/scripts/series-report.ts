/**
 * 三层数据体检：每层多少序列、多少点、覆盖到哪一天、主力合约是谁。
 *
 * 用法：pnpm series:report
 */
import { sql } from 'drizzle-orm';
import { createDb, resolveDatabaseUrl } from '@bee/db';

async function main(): Promise<void> {
  const url = resolveDatabaseUrl();
  if (!url) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }
  const db = createDb(url);
  try {
    const layers = await db.execute(sql`
      select s.layer::text as layer,
             s.kind::text as kind,
             count(distinct s.id)::int as series,
             count(p.id)::int as points,
             min(p.obs_date)::text as first_date,
             max(p.obs_date)::text as last_date
        from market_series s
        left join series_point p on p.series_id = s.id
       group by 1, 2
       order by 1, 2
    `);
    console.log('== 三层数据总览 ==');
    for (const r of layers.rows as Array<Record<string, unknown>>) {
      console.log(
        `${String(r.layer).padEnd(14)} ${String(r.kind).padEnd(10)} 序列 ${String(r.series).padStart(5)}` +
          `  点数 ${String(r.points).padStart(7)}  ${r.first_date ?? '-'} → ${r.last_date ?? '-'}`,
      );
    }

    const mains = await db.execute(sql`
      select s.venue, s.instrument_code, s.name_cn, p.obs_date::text as obs_date, p.value::text as value, p.open_interest::text as oi
        from market_series s
        join series_point p on p.series_id = s.id
       where p.obs_date = (select max(obs_date) from series_point)
         and p.open_interest is not null
         and s.layer = 'national'
       order by p.open_interest desc
       limit 8
    `);
    console.log('\n== 最新交易日主力合约（按持仓量）==');
    for (const r of mains.rows as Array<Record<string, unknown>>) {
      console.log(
        `${String(r.obs_date)}  ${String(r.venue).padEnd(5)} ${String(r.name_cn).padEnd(22)} 结算 ${String(r.value).padStart(10)}  持仓 ${r.oi}`,
      );
    }

    const intl = await db.execute(sql`
      select s.code, s.name_cn, p.obs_date::text as obs_date, p.value::text as value
        from market_series s
        join series_point p on p.series_id = s.id
       where s.layer = 'international'
         and p.obs_date = (select max(p2.obs_date) from series_point p2 where p2.series_id = s.id)
       order by s.code
    `);
    console.log('\n== 国际层最新值 ==');
    for (const r of intl.rows as Array<Record<string, unknown>>) {
      console.log(`${String(r.obs_date)}  ${String(r.code).padEnd(18)} ${String(r.value).padStart(12)}  ${r.name_cn}`);
    }
  } finally {
    await db.$client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});