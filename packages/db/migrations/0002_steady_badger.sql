-- ============================================================
-- 0002：DAW-34 复审修复（对 DAW-33 修复的第二轮评审阻断项）。
-- 依 ADR-0003「已合并的迁移禁止手改，修正走新迁移」：不改 0000/0001。
-- 全部为手工追加守卫与存量校验，无 drizzle-kit 建模变更（schema TS 不动）。
--  1) 修正链闭合（P0-2 余项）：
--     a. 同 (fetch_id, source_row_index) 仅允许一个未 superseded 的 revision
--        —— 可延迟约束触发器提交时校验，合法写入路径「先插后继、再标记前驱」
--        必须在同一事务内原子完成；
--     b. supersede 守卫补同槽位比较（fetch_id/source_row_index）与
--        「后继不存在」的显式拒绝；
--  2) 存量校验（P0-4 余项）：零贡献 derived_indicator = 迁移失败（不静默通过）；
--  3) region 存量树校验（P0-3 余项）：0000 时代允许的坏树（跳级/孤儿/
--     country 带父/多根）在迁移期显式拒绝，不只约束新写入；
--  4) 台账 INSERT 状态机（P1-7 余项）：run/step 只能以 pending 落库，
--     step 不许挂进已终态的 run —— 裸 INSERT 写 succeeded run / failed step
--     绕过状态机的路径被堵死。
-- ============================================================

-- 1b) supersede 守卫重建：补同槽位与「后继不存在」检查
DROP TRIGGER price_observation_supersede_guard ON price_observation;--> statement-breakpoint
CREATE OR REPLACE FUNCTION bee_supersede_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  succ record;
BEGIN
  IF NEW.superseded_by_id IS NULL THEN
    RETURN NEW; -- 无取代指针，放行（绝大多数观测）
  END IF;
  IF NEW.superseded_by_id = NEW.id THEN
    RAISE EXCEPTION 'supersede violation: superseded_by_id 不允许自指（%）', NEW.id;
  END IF;
  SELECT * INTO succ FROM price_observation WHERE id = NEW.superseded_by_id;
  IF succ.id IS NULL THEN
    RAISE EXCEPTION 'supersede violation: 后继观测 % 不存在 —— 合法顺序是同事务内先插后继、再标记前驱', NEW.superseded_by_id;
  END IF;
  IF succ.fetch_id <> NEW.fetch_id OR succ.source_row_index <> NEW.source_row_index THEN
    RAISE EXCEPTION 'supersede violation: 后继必须同槽位（同 fetch 同 source_row_index）—— 实际 (%) 指向 (fetch %, row %)，修正是一条原始记录的换代，不是跨记录嫁接', NEW.id, succ.fetch_id, succ.source_row_index;
  END IF;
  IF succ.revision <= NEW.revision THEN
    RAISE EXCEPTION 'supersede violation: 后继 revision（%）必须严格大于当前（%）—— 单调递增即物理无环', succ.revision, NEW.revision;
  END IF;
  IF succ.source_id <> NEW.source_id
     OR succ.category_id IS DISTINCT FROM NEW.category_id
     OR succ.spec_id IS DISTINCT FROM NEW.spec_id
     OR succ.region_id IS DISTINCT FROM NEW.region_id
     OR succ.quote_date IS DISTINCT FROM NEW.quote_date
     OR succ.price_type IS DISTINCT FROM NEW.price_type THEN
    RAISE EXCEPTION 'supersede violation: 后继观测必须同源且同维度（品类/规格/地域/日期/价类型），修正不允许跨口径替换';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER price_observation_supersede_guard BEFORE INSERT OR UPDATE OF superseded_by_id ON price_observation
  FOR EACH ROW EXECUTE FUNCTION bee_supersede_guard();--> statement-breakpoint

-- 1a) 同槽位仅一个未 superseded 的 revision —— 可延迟约束触发器（提交时校验）。
-- 为什么不用部分唯一索引：superseded_by_id 的外键是立即检查，合法写入顺序只能
-- 「先插后继、再改前驱指针」；非延迟的唯一索引会在这个顺序的中途状态上误伤合法路径。
-- 触发器推迟到提交：修正两笔写必须同事务，拆成两次提交的「半修正」在此被整体拒绝。
CREATE FUNCTION bee_price_observation_slot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  slot_fetch uuid;
  slot_row int;
  active_count int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    slot_fetch := NEW.fetch_id;
    slot_row := NEW.source_row_index;
  ELSE
    slot_fetch := OLD.fetch_id;
    slot_row := OLD.source_row_index;
  END IF;
  SELECT count(*) INTO active_count
    FROM price_observation
    WHERE fetch_id = slot_fetch
      AND source_row_index = slot_row
      AND superseded_by_id IS NULL;
  IF active_count > 1 THEN
    RAISE EXCEPTION 'supersede violation: 槽位（fetch %, row %）有 % 个未 superseded 的 revision —— 同槽位只允许一个活跃版本；修正必须单事务完成（插入后继 + 标记前驱 superseded），不能分两次提交', slot_fetch, slot_row, active_count;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER price_observation_slot_guard
  AFTER INSERT OR UPDATE OF superseded_by_id ON price_observation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bee_price_observation_slot_guard();--> statement-breakpoint

-- 2) 存量校验：每个 derived_indicator 至少一条贡献明细。
-- 0001 删除 contributing_quote_ids 数组时未回填（DAW-34 阻断项 2）。列已不存在，
-- 0002 无法代为回填：受影响库的恢复路径 = 按 computation_run_id 重放重算，或按
-- method_json 重聚合后在同一事务补写 indicator_contribution。这里把「静默零贡献」
-- 变成迁移期硬失败并给出处置指引 —— 不能静默 DROP，也不能静默通过。
DO $$
DECLARE
  orphan_count int;
  sample text;
  msg text;
BEGIN
  SELECT count(*) INTO orphan_count FROM derived_indicator di
    WHERE NOT EXISTS (SELECT 1 FROM indicator_contribution ic WHERE ic.indicator_id = di.id);
  IF orphan_count > 0 THEN
    SELECT string_agg(id::text, ', ') INTO sample FROM (
      SELECT di.id FROM derived_indicator di
      WHERE NOT EXISTS (SELECT 1 FROM indicator_contribution ic WHERE ic.indicator_id = di.id)
      LIMIT 5
    ) s;
    -- plpgsql 的 RAISE 格式串位置只接受单串字面量，长文案先拼进变量。
    msg :=
      'indicator_contribution 存量校验失败：' || orphan_count || ' 个 derived_indicator 没有任何贡献明细（示例：' ||
      coalesce(sample, '无') || '）。' ||
      '0001 删除 contributing_quote_ids 数组时未回填，本迁移不静默通过。' ||
      '处置：按 computation_run_id 重放重算，或按 method_json 重聚合后在同一事务补写 indicator_contribution，然后重跑迁移。' ||
      '指标行不可删除（溯源锚点，重算 = 更新计算字段 + 同事务换贡献明细）。';
    RAISE EXCEPTION '%', msg;
  END IF;
END
$$;--> statement-breakpoint

-- 3) region 存量树校验：阶梯只约束新写入（0001 起），0000 时代允许的坏树
--    必须在迁移期显式拒绝（DAW-34 阻断项 3）—— 不修数据就不许往前走。
DO $$
DECLARE
  region_total int;
  country_count int;
  country_with_parent int;
  orphan_count int;
  bad_parent_count int;
  sample text;
  msg text;
BEGIN
  SELECT count(*) INTO region_total FROM region;
  SELECT count(*) INTO country_count FROM region WHERE level = 'country';
  -- 空字典 = 全新安装（region 由 seed 在迁移后种下），无存量可校验，放行；
  -- 有任意 region 行却没 country 根，或多根，都是坏树 —— 显式拒绝。
  IF country_count = 0 AND region_total > 0 THEN
    RAISE EXCEPTION 'region tree 存量校验失败：存在 % 行 region 但没有任何 country 根 —— 修 region 字典后重跑迁移', region_total;
  END IF;
  IF country_count > 1 THEN
    RAISE EXCEPTION 'region tree 存量校验失败：country 根节点必须恰好 1 个（实际 %）—— 修 region 字典后重跑迁移', country_count;
  END IF;
  SELECT count(*) INTO country_with_parent FROM region WHERE level = 'country' AND parent_id IS NOT NULL;
  SELECT count(*) INTO orphan_count FROM region WHERE level <> 'country' AND parent_id IS NULL;
  SELECT count(*) INTO bad_parent_count FROM region r
    JOIN region p ON p.id = r.parent_id
    WHERE (r.level = 'market' AND p.level <> 'city')
       OR (r.level = 'city' AND p.level <> 'macro_region')
       OR (r.level = 'macro_region' AND p.level <> 'country');
  IF country_with_parent > 0 OR orphan_count > 0 OR bad_parent_count > 0 THEN
    SELECT string_agg(code, ', ') INTO sample FROM (
      (SELECT code FROM region WHERE level = 'country' AND parent_id IS NOT NULL LIMIT 3)
      UNION ALL
      (SELECT code FROM region WHERE level <> 'country' AND parent_id IS NULL LIMIT 3)
      UNION ALL
      (SELECT r.code FROM region r JOIN region p ON p.id = r.parent_id
       WHERE (r.level = 'market' AND p.level <> 'city')
          OR (r.level = 'city' AND p.level <> 'macro_region')
          OR (r.level = 'macro_region' AND p.level <> 'country')
       LIMIT 3)
    ) s;
    msg :=
      'region tree 存量校验失败：country 带父 ' || country_with_parent || ' 个、非根孤儿 ' || orphan_count ||
      ' 个、跳级挂靠 ' || bad_parent_count || ' 个（示例：' || coalesce(sample, '无') || '）。' ||
      '阶梯规则 market→city→macro_region→country 只约束新写入，存量坏树必须先修数据：' ||
      '把每行改挂到正确层级的父节点（region 被引用时 level/parent 冻结，需先解除事实引用或按口径新建节点），然后重跑迁移。';
    RAISE EXCEPTION '%', msg;
  END IF;
END
$$;--> statement-breakpoint

-- 3b) 修正链存量校验：0001 时期可能已写入「同槽位双活跃」的半修正状态（DAW-34 探针）。
--     触发器只拦新写入，存量违例必须在此显式暴露。
DO $$
DECLARE
  slot_violations int;
  sample text;
  msg text;
BEGIN
  SELECT count(*) INTO slot_violations FROM (
    SELECT fetch_id, source_row_index
    FROM price_observation
    WHERE superseded_by_id IS NULL
    GROUP BY fetch_id, source_row_index
    HAVING count(*) > 1
  ) v;
  IF slot_violations > 0 THEN
    SELECT string_agg(format('(%s, %s)', fetch_id, source_row_index), '; ') INTO sample FROM (
      SELECT fetch_id, source_row_index
      FROM price_observation
      WHERE superseded_by_id IS NULL
      GROUP BY fetch_id, source_row_index
      HAVING count(*) > 1
      LIMIT 3
    ) v;
    msg :=
      'price_observation 存量校验失败：' || slot_violations || ' 个槽位存在多个未 superseded 的 revision（示例：' ||
      coalesce(sample, '无') || '）。' ||
      '处置：每个槽位保留 revision 最高的活跃行，其余行在同事务内置 superseded 并把 superseded_by_id 指向保留行（观测值不可删，只能走指针），然后重跑迁移。';
    RAISE EXCEPTION '%', msg;
  END IF;
END
$$;--> statement-breakpoint

-- 4) 台账 INSERT 状态机：run/step 只能以 pending 落库（DAW-34 阻断项 4）。
--    原有 UPDATE/DELETE 触发器（0001）只挡改与删，裸 INSERT 直接写
--    succeeded/failed 跳过状态机的路径在这里堵死。
CREATE FUNCTION bee_run_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'pending' THEN
    RAISE EXCEPTION 'pipeline_run 台账只能以 pending 落库（收到 %）—— 状态机 pending→running→终态，不允许出生即终态', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER pipeline_run_insert_guard BEFORE INSERT ON pipeline_run
  FOR EACH ROW EXECUTE FUNCTION bee_run_insert_guard();--> statement-breakpoint
CREATE FUNCTION bee_step_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_status text;
BEGIN
  IF NEW.status <> 'pending' THEN
    RAISE EXCEPTION 'pipeline_step 台账只能以 pending 落库（收到 %）—— 状态机 pending→running→终态，不允许出生即终态', NEW.status;
  END IF;
  SELECT status::text INTO run_status FROM pipeline_run WHERE id = NEW.run_id;
  IF run_status IN ('succeeded', 'failed', 'partial') THEN
    RAISE EXCEPTION 'pipeline_step 不许挂进已终态的 run（% 现为 %）—— 终态 run 的台账冻结，事后追加 = 伪造台账', NEW.run_id, run_status;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER pipeline_step_insert_guard BEFORE INSERT ON pipeline_step
  FOR EACH ROW EXECUTE FUNCTION bee_step_insert_guard();
