/**
 * 迁移存量校验测试（DAW-34 复审修复的回归锁）—— 测的是「迁移对存量库的行为」，不是终态 schema。
 *
 * schema.integration.test.ts 锁的是全链应用后的不变量；这里锁的是 0002 的另一半：
 * 迁移期对存量违例 fail-loud，绝不静默通过（DAW-34 阻断项 2/3 的机械化证明）。
 *
 * 方法：每个用例开独立探针库（bee_test_mig_probe_*），不走 drizzle migrate（它按 journal
 * 一次前进到底），而是逐条手放迁移语句（与 migrate 一致的 `--> statement-breakpoint` 切分），
 * 在指定的历史节点插入「那个时代合法、但按新规则违例」的存量，然后要求 0002 显式失败：
 *  - 净库全链一次通过（正控：不误伤干净库）；
 *  - 0000 时代的坏 region 树（market→country、孤儿 city）穿过 0001，在 0002 被拒；
 *  - 0000 时代的 derived_indicator.contributing_quote_ids 数组被 0001 掉列且无回填 ——
 *    0002 对「零贡献指标」拒绝放行（不静默 DROP、也不静默通过）；
 *  - 0001 时代的同槽位双活跃（半修正）—— 0002 存量校验拒绝，必须先闭合再前进；
 *  - 多 country 根（0000 存量）的**释放口径**（DAW-35 R3）：fail-loud 提前发生在 0001
 *    建 `region_single_country_uq` 时（操作层闸门），因此 0002 的 `country_count > 1`
 *    分支在正常迁移链上不可达 —— 它是对绕过 0001 直接上 0002 的库（如手工修补过
 *    迁移历史的库）的纵深防御。两层都拒绝、只是拦截面不同；本套件锁定 0001 这一层。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const TEST_URL = process.env.BEE_TEST_DATABASE_URL ?? '';

describe.skipIf(!TEST_URL)('迁移存量校验：0002 对存量库 fail-loud，不静默通过', () => {
  function rewriteDb(url: string, dbName: string): string {
    const parsed = new URL(url);
    parsed.pathname = `/${dbName}`;
    return parsed.toString();
  }

  /** 开独立探针库（每次运行前先 WITH (FORCE) 清掉旧的）。 */
  async function freshProbe(tag: string): Promise<pg.Client> {
    const admin = new pg.Client({ connectionString: rewriteDb(TEST_URL, 'postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS bee_test_mig_probe_${tag} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE bee_test_mig_probe_${tag}`);
    await admin.end();
    const client = new pg.Client({ connectionString: rewriteDb(TEST_URL, `bee_test_mig_probe_${tag}`) });
    await client.connect();
    return client;
  }

  async function dropProbe(client: pg.Client, tag: string): Promise<void> {
    await client.end();
    const admin = new pg.Client({ connectionString: rewriteDb(TEST_URL, 'postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS bee_test_mig_probe_${tag} WITH (FORCE)`);
    await admin.end();
  }

  /** 逐条执行迁移 SQL —— 与 drizzle migrate 相同的 `--> statement-breakpoint` 切分。 */
  async function apply(client: pg.Client, tag: string): Promise<void> {
    const file = fileURLToPath(new URL(`../migrations/${tag}.sql`, import.meta.url));
    const statements = readFileSync(file, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await client.query(statement);
    }
  }

  /** 断言迁移因存量违例**失败**，且报错带处置指引 —— 静默通过才是失败。 */
  async function applyExpectMessage(client: pg.Client, tag: string, fragment: string): Promise<void> {
    try {
      await apply(client, tag);
    } catch (error) {
      expect((error as Error).message).toContain(fragment);
      return;
    }
    expect.fail(`期望迁移 ${tag} 因存量违例失败（${fragment}），但静默通过了`);
  }

  it('正控：净库全链 0000→0001→0002 一次通过（0002 不误伤干净库）', async () => {
    const client = await freshProbe('clean');
    try {
      await apply(client, '0000_freezing_morph');
      await apply(client, '0001_happy_wallflower');
      await apply(client, '0002_steady_badger');
    } finally {
      await dropProbe(client, 'clean');
    }
  });

  it('0000 时代的坏 region 树：穿过 0001（只修 NULL 父 macro_region），在 0002 显式拒绝（阻断项 3）', async () => {
    const client = await freshProbe('region');
    try {
      await apply(client, '0000_freezing_morph');
      // 0000 允许的坏树：market 直接挂 country + 没挂父的孤儿 city。
      await client.query(
        `INSERT INTO region (level, code, name_cn) VALUES ('country', 'probe-cn', '中国')`,
      );
      const cn = (await client.query<{ id: string }>(`SELECT id FROM region WHERE code = 'probe-cn'`)).rows[0]!.id;
      await client.query(
        `INSERT INTO region (level, code, name_cn, parent_id) VALUES ('market', 'probe-bad-market', '坏市场', $1)`,
        [cn],
      );
      await client.query(`INSERT INTO region (level, code, name_cn) VALUES ('city', 'probe-orphan-city', '孤儿城市')`);
      // 0001 的存量处理只修 NULL 父的 macro_region —— 这两棵坏树原样穿过（这正是 DAW-34 指出的缺口）。
      await apply(client, '0001_happy_wallflower');
      // 0002：region 存量校验显式拒绝 —— 不修数据就不许前进。
      await applyExpectMessage(client, '0002_steady_badger', 'region tree 存量校验失败');
    } finally {
      await dropProbe(client, 'region');
    }
  });

  it('多 country 根（0000 存量）：0001 建 region_single_country_uq 时即被拒 —— 多根的操作层闸门（DAW-35 R3 释放口径）', async () => {
    const client = await freshProbe('multicountry');
    try {
      await apply(client, '0000_freezing_morph');
      // 0000 没有任何单根约束，两个 country 合法并存（正是 reviewer 验证过的字面路径）。
      await client.query(`INSERT INTO region (level, code, name_cn) VALUES ('country', 'probe-cn', '中国')`);
      await client.query(`INSERT INTO region (level, code, name_cn) VALUES ('country', 'probe-us', '美国')`);
      // 释放口径（DAW-35 R3）：多根 fail-loud 提前发生在 0001 —— 部分唯一索引一建即拒，
      // 链执行不到 0002 的 country_count > 1 分支。0001 是多根的操作层闸门；
      // 0002 的同名校验是对「绕过 0001 直接上 0002」的库的纵深防御，见 docs/data-model.md §4。
      await applyExpectMessage(client, '0001_happy_wallflower', 'region_single_country_uq');
    } finally {
      await dropProbe(client, 'multicountry');
    }
  });

  it('0000 时代的指标数组被 0001 掉列：0002 对零贡献指标拒绝放行（阻断项 2，不静默 DROP）', async () => {
    const client = await freshProbe('ind');
    try {
      await apply(client, '0000_freezing_morph');
      await client.query(`INSERT INTO region (level, code, name_cn) VALUES ('country', 'probe-cn', '中国')`);
      const cn = (await client.query<{ id: string }>(`SELECT id FROM region WHERE code = 'probe-cn'`)).rows[0]!.id;
      await client.query(`INSERT INTO category (code, name_cn) VALUES ('probe-cat', '废钢')`);
      const cat = (await client.query<{ id: string }>(`SELECT id FROM category WHERE code = 'probe-cat'`)).rows[0]!.id;
      // 0000 形态：贡献清单是 uuid 数组（contributing_quote_ids NOT NULL），没有明细表。
      await client.query(
        `INSERT INTO derived_indicator
           (kind, category_id, region_id, basis_date, value, method_json, method_version, contributing_quote_ids, is_aggregate)
         VALUES ('national_median', $1, $2, '2026-10-26', '2205.00', '{"formula":"中位数"}', 'v1',
                 ARRAY['44444444-4444-4444-4444-444444444444']::uuid[], 1)`,
        [cat, cn],
      );
      // 0001 掉列成功（列已消失，数组证据无处可去）—— 但贡献明细没有任何回填。
      await apply(client, '0001_happy_wallflower');
      const after1 = await client.query<{ n: string }>(`SELECT count(*) AS n FROM indicator_contribution`);
      expect(after1.rows[0]!.n).toBe('0');
      const indicators = await client.query<{ n: string }>(`SELECT count(*) AS n FROM derived_indicator`);
      expect(indicators.rows[0]!.n).toBe('1');
      // 0002：零贡献指标 = 迁移失败。恢复路径在报错里给出（重放重算 / 按 method_json 重聚合补写）。
      await applyExpectMessage(client, '0002_steady_badger', 'indicator_contribution 存量校验失败');
    } finally {
      await dropProbe(client, 'ind');
    }
  });

  it('0001 时代的同槽位双活跃（半修正）：0002 存量校验拒绝（阻断项 1 的存量面）', async () => {
    const client = await freshProbe('slot');
    try {
      await apply(client, '0000_freezing_morph');
      // 0000 形态的抓取登记（content_sha256 唯一 + content_ref 都在 raw_fetch 上）。
      await client.query(
        `INSERT INTO source (code, name, type, base_url, status, robots_status)
         VALUES ('probe-src', '探针来源', 'webpage', 'https://example.com', 'active', 'allowed')`,
      );
      const src = (await client.query<{ id: string }>(`SELECT id FROM source WHERE code = 'probe-src'`)).rows[0]!.id;
      const sha = 'ab'.repeat(32);
      await client.query(
        `INSERT INTO raw_fetch (source_id, url, fetched_at, http_status, content_sha256, content_ref)
         VALUES ($1, 'https://example.com/p', '2026-10-26T08:00:00Z', 200, $2, 'raw/2026/10/26/probe.bin')`,
        [src, sha],
      );
      const fetch = (await client.query<{ id: string }>(`SELECT id FROM raw_fetch WHERE content_sha256 = $1`, [sha]))
        .rows[0]!.id;
      // 0001：raw_content 回填、唯一键换成 (fetch, row, revision)。
      await apply(client, '0001_happy_wallflower');

      // 铺字典与阶梯（0001 的 region 树守卫要求逐级，观测的地域守卫要求 market|city）。
      await client.query(`INSERT INTO region (level, code, name_cn, parent_id) VALUES ('country', 'probe-cn', '中国', NULL)`);
      const cn = (await client.query<{ id: string }>(`SELECT id FROM region WHERE code = 'probe-cn'`)).rows[0]!.id;
      await client.query(
        `INSERT INTO region (level, code, name_cn, parent_id) VALUES ('macro_region', 'probe-mr', '华东', $1)`,
        [cn],
      );
      const mr = (await client.query<{ id: string }>(`SELECT id FROM region WHERE code = 'probe-mr'`)).rows[0]!.id;
      await client.query(
        `INSERT INTO region (level, code, name_cn, parent_id) VALUES ('city', 'probe-city', '苏州', $1)`,
        [mr],
      );
      const city = (await client.query<{ id: string }>(`SELECT id FROM region WHERE code = 'probe-city'`)).rows[0]!.id;
      await client.query(
        `INSERT INTO region (level, code, name_cn, parent_id) VALUES ('market', 'probe-mkt', '苏州市场', $1)`,
        [city],
      );
      const market = (await client.query<{ id: string }>(`SELECT id FROM region WHERE code = 'probe-mkt'`)).rows[0]!.id;
      await client.query(`INSERT INTO category (code, name_cn) VALUES ('probe-cat', '废钢')`);
      const cat = (await client.query<{ id: string }>(`SELECT id FROM category WHERE code = 'probe-cat'`)).rows[0]!.id;
      await client.query(
        `INSERT INTO spec_grade (category_id, code, name_cn) VALUES ($1, 'probe-heavy', '重废')`,
        [cat],
      );
      const spec = (await client.query<{ id: string }>(`SELECT id FROM spec_grade WHERE code = 'probe-heavy'`)).rows[0]!
        .id;
      await client.query(`INSERT INTO unit (code, name_cn) VALUES ('probe-ton', '元/吨')`);
      const unit = (await client.query<{ id: string }>(`SELECT id FROM unit WHERE code = 'probe-ton'`)).rows[0]!.id;

      // DAW-34 探针路径：0001 允许同槽位两个活跃 revision（rev 1 与 rev 2 都未 superseded）——
      // 拆成两次提交的「半修正」，修正链没有闭合。
      for (const [revision, normLow] of [[1, '2200.00'], [2, '2210.00']] as const) {
        await client.query(
          `INSERT INTO price_observation
             (fetch_id, source_id, fetched_at, source_row_index, revision, raw_text, raw_category_text,
              category_id, spec_id, region_id, price_type, norm_value_low, norm_value_high, unit_id,
              quote_date, validation_status)
           VALUES ($1, $2, '2026-10-26T08:00:00Z', 0, $3, '2200-2210 元/吨', '废钢',
                   $4, $5, $6, 'purchase', $7, $8, $9, '2026-10-26', 'validated')`,
          [fetch, src, revision, cat, spec, market, normLow, normLow, unit],
        );
      }
      // 0002：存量校验拒绝 —— 每个槽位先闭合（保留最高 revision，其余行补指针）再前进。
      await applyExpectMessage(client, '0002_steady_badger', 'price_observation 存量校验失败');
    } finally {
      await dropProbe(client, 'slot');
    }
  });
});
