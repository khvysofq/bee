CREATE TABLE "raw_content" (
	"content_sha256" char(64) PRIMARY KEY NOT NULL,
	"content_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- 存量兼容：把既有 raw_fetch 的内容登记回填到 raw_content（新库为空时无操作）。
-- 必须在 raw_fetch DROP COLUMN content_ref 与 ADD raw_fetch→raw_content 外键之前执行。
INSERT INTO "raw_content" ("content_sha256", "content_ref", "created_at")
SELECT r.content_sha256, MIN(r.content_ref), MIN(r.created_at)
FROM "raw_fetch" r
GROUP BY r.content_sha256
ON CONFLICT (content_sha256) DO NOTHING;
--> statement-breakpoint
-- 存量兼容（region 树守卫生效前的数据修复）：macro_region 行补挂 country 根节点。
UPDATE "region" SET "parent_id" = (SELECT id FROM "region" WHERE level = 'country' LIMIT 1)
WHERE level = 'macro_region' AND parent_id IS NULL;
--> statement-breakpoint
CREATE TABLE "indicator_contribution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"indicator_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"value_at_aggregation" numeric(12, 2) NOT NULL,
	"weight" numeric(8, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indicator_contribution_uq" UNIQUE("indicator_id","quote_id"),
	CONSTRAINT "indicator_contribution_weight_positive" CHECK ("indicator_contribution"."weight" IS NULL OR "indicator_contribution"."weight" > 0)
);
--> statement-breakpoint
ALTER TABLE "raw_fetch" DROP CONSTRAINT "raw_fetch_content_sha256_unique";--> statement-breakpoint
ALTER TABLE "price_observation" DROP CONSTRAINT "price_observation_fetch_row_uq";--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "pipeline_step" ADD COLUMN "step_version" text;--> statement-breakpoint
ALTER TABLE "price_observation" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- 复合外键引用的 UNIQUE 约束必须先于 FK 创建（drizzle-kit 生成的段序不保证这一点）。
ALTER TABLE "spec_grade" ADD CONSTRAINT "spec_grade_category_id_uq" UNIQUE("category_id","id");--> statement-breakpoint
ALTER TABLE "pipeline_step" ADD CONSTRAINT "pipeline_step_run_id_uq" UNIQUE("run_id","id");--> statement-breakpoint
ALTER TABLE "raw_fetch" ADD CONSTRAINT "raw_fetch_id_source_uq" UNIQUE("id","source_id");--> statement-breakpoint
ALTER TABLE "raw_fetch" ADD CONSTRAINT "raw_fetch_id_fetched_at_uq" UNIQUE("id","fetched_at");--> statement-breakpoint
ALTER TABLE "indicator_contribution" ADD CONSTRAINT "indicator_contribution_indicator_id_derived_indicator_id_fk" FOREIGN KEY ("indicator_id") REFERENCES "public"."derived_indicator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicator_contribution" ADD CONSTRAINT "indicator_contribution_quote_id_daily_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."daily_quote"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "indicator_contribution_quote_idx" ON "indicator_contribution" USING btree ("quote_id");--> statement-breakpoint
ALTER TABLE "impurity_rule" ADD CONSTRAINT "impurity_rule_category_spec_fk" FOREIGN KEY ("category_id","spec_id") REFERENCES "public"."spec_grade"("category_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region_mapping" ADD CONSTRAINT "region_mapping_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_mapping" ADD CONSTRAINT "term_mapping_category_spec_fk" FOREIGN KEY ("category_id","spec_id") REFERENCES "public"."spec_grade"("category_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_spec_id_spec_grade_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."spec_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_category_spec_fk" FOREIGN KEY ("category_id","spec_id") REFERENCES "public"."spec_grade"("category_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD CONSTRAINT "agent_invocation_run_step_fk" FOREIGN KEY ("run_id","step_id") REFERENCES "public"."pipeline_step"("run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_replay_of_run_id_pipeline_run_id_fk" FOREIGN KEY ("replay_of_run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_fetch" ADD CONSTRAINT "raw_fetch_content_sha256_raw_content_content_sha256_fk" FOREIGN KEY ("content_sha256") REFERENCES "public"."raw_content"("content_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_fetch_source_fk" FOREIGN KEY ("fetch_id","source_id") REFERENCES "public"."raw_fetch"("id","source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_fetch_time_fk" FOREIGN KEY ("fetch_id","fetched_at") REFERENCES "public"."raw_fetch"("id","fetched_at") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_category_spec_fk" FOREIGN KEY ("category_id","spec_id") REFERENCES "public"."spec_grade"("category_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_result" ADD CONSTRAINT "validation_result_agent_invocation_id_agent_invocation_id_fk" FOREIGN KEY ("agent_invocation_id") REFERENCES "public"."agent_invocation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_quote" ADD CONSTRAINT "daily_quote_category_spec_fk" FOREIGN KEY ("category_id","spec_id") REFERENCES "public"."spec_grade"("category_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_indicator" ADD CONSTRAINT "derived_indicator_category_spec_fk" FOREIGN KEY ("category_id","spec_id") REFERENCES "public"."spec_grade"("category_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "raw_fetch_content_idx" ON "raw_fetch" USING btree ("content_sha256");--> statement-breakpoint
ALTER TABLE "raw_fetch" DROP COLUMN "content_ref";--> statement-breakpoint
ALTER TABLE "derived_indicator" DROP COLUMN "contributing_quote_ids";--> statement-breakpoint
ALTER TABLE "pipeline_step" ADD CONSTRAINT "pipeline_step_run_seq_uq" UNIQUE("run_id","seq");--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_fetch_row_uq" UNIQUE("fetch_id","source_row_index","revision");--> statement-breakpoint
ALTER TABLE "impurity_rule" ADD CONSTRAINT "impurity_rule_period_valid" CHECK ("impurity_rule"."effective_to" IS NULL OR "impurity_rule"."effective_from" IS NULL OR "impurity_rule"."effective_to" >= "impurity_rule"."effective_from");--> statement-breakpoint
ALTER TABLE "unit_conversion" ADD CONSTRAINT "unit_conversion_factor_positive" CHECK ("unit_conversion"."factor" > 0);--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_active_requires_robots_allowed" CHECK ("source"."status" <> 'active' OR "source"."robots_status" = 'allowed');--> statement-breakpoint
ALTER TABLE "pipeline_step" ADD CONSTRAINT "pipeline_step_seq_positive" CHECK ("pipeline_step"."seq" >= 1);--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_revision_positive" CHECK ("price_observation"."revision" >= 1);--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_superseded_points" CHECK ("price_observation"."superseded_by_id" IS NULL OR "price_observation"."validation_status" = 'superseded');--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_superseded_complete" CHECK ("price_observation"."validation_status" <> 'superseded' OR "price_observation"."superseded_by_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "daily_quote" ADD CONSTRAINT "daily_quote_has_contributions" CHECK (array_length("daily_quote"."contributing_observation_ids", 1) >= 1);--> statement-breakpoint
ALTER TABLE "daily_quote" ADD CONSTRAINT "daily_quote_source_count_positive" CHECK ("daily_quote"."source_count" >= 1);--> statement-breakpoint

-- ============================================================
-- 以下为 DAW-33 评审修复的手工追加守卫（非 drizzle-kit 生成内容）。
-- 与 0000 约定一致：要改守卫语义 = 未来新迁移内 DROP + 重建，绝不回改历史文件。
-- 覆盖：
--  1) TRUNCATE 拒绝 —— 0000 的 WORM 是行级 BEFORE UPDATE/DELETE 触发器，
--     TRUNCATE 不触发行级守卫，可整表清空绕过 append-only（评审 P0-1）；
--  2) supersede 链一致性 —— 后继 revision 严格更大（单调递增 = 物理无环）
--     且同源同维度，禁止跨口径替换（评审 P0-2）；
--  3) region 树阶梯（market→city→macro_region→country 逐级上行 = 物理无环）
--     + country 单根 + 引用冻结（评审 P0-3）；
--  4) derived_indicator kind↔region 层级绑定（评审 P0-3）；
--  5) indicator_contribution 维度一致 / 写定冻结 / 每指标至少一条（评审 P0-4）；
--  6) daily_quote 定档贡献一致性：观测存在 / 全部 validated / 来源数核对；
--  7) pipeline_run / pipeline_step 台账状态机 + 终态冻结 + append-only（评审 P1-7）；
--  8) 映射确定性：term/region active 部分唯一索引；单位单 canonical；run 幂等键唯一。
-- ============================================================

-- 1) TRUNCATE 拒绝（statement 级，覆盖所有带 UPDATE/DELETE/TRUNCATE 限制的表）
CREATE FUNCTION bee_truncate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE violation: % 是不可变/台账表，禁止清空（WORM/审计），见 docs/data-model.md', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER raw_content_truncate_guard BEFORE TRUNCATE ON raw_content
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER raw_fetch_truncate_guard BEFORE TRUNCATE ON raw_fetch
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER price_observation_truncate_guard BEFORE TRUNCATE ON price_observation
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER validation_result_truncate_guard BEFORE TRUNCATE ON validation_result
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER source_event_truncate_guard BEFORE TRUNCATE ON source_event
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER agent_invocation_truncate_guard BEFORE TRUNCATE ON agent_invocation
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER caliber_decision_truncate_guard BEFORE TRUNCATE ON caliber_decision
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER derived_indicator_truncate_guard BEFORE TRUNCATE ON derived_indicator
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER indicator_contribution_truncate_guard BEFORE TRUNCATE ON indicator_contribution
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER pipeline_run_truncate_guard BEFORE TRUNCATE ON pipeline_run
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER pipeline_step_truncate_guard BEFORE TRUNCATE ON pipeline_step
  FOR EACH STATEMENT EXECUTE FUNCTION bee_truncate_guard();
--> statement-breakpoint

-- raw_content 加入 WORM（内容寻址行：登记后不允许改）
CREATE TRIGGER raw_content_worm BEFORE UPDATE OR DELETE ON raw_content
  FOR EACH STATEMENT EXECUTE FUNCTION bee_worm_guard();
--> statement-breakpoint

-- 2) supersede 链一致性：后继必须 revision 更大且同源同维度
CREATE FUNCTION bee_supersede_guard() RETURNS trigger
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
$$;
--> statement-breakpoint
CREATE TRIGGER price_observation_supersede_guard BEFORE INSERT OR UPDATE OF superseded_by_id ON price_observation
  FOR EACH ROW EXECUTE FUNCTION bee_supersede_guard();
--> statement-breakpoint

-- 3) region 树阶梯：每层必须挂在「正好高一级」的父节点上（物理无环），country 为根
CREATE FUNCTION bee_region_tree_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_level text;
  expected_parent text;
BEGIN
  IF NEW.level = 'country' THEN
    IF NEW.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'region tree: country 必须是根节点（parent_id 必须为空）';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_id IS NULL THEN
    RAISE EXCEPTION 'region tree: % 层级必须挂父节点（market→city→macro_region→country 逐级上行）', NEW.level;
  END IF;
  expected_parent := CASE NEW.level
    WHEN 'market' THEN 'city'
    WHEN 'city' THEN 'macro_region'
    WHEN 'macro_region' THEN 'country'
  END;
  SELECT level::text INTO parent_level FROM region WHERE id = NEW.parent_id;
  IF parent_level IS NULL THEN
    RAISE EXCEPTION 'region tree: 父节点 % 不存在', NEW.parent_id;
  END IF;
  IF parent_level <> expected_parent THEN
    RAISE EXCEPTION 'region tree: % 层级的父节点必须是 %，实际为 % —— 阶梯规则防插错/防环', NEW.level, expected_parent, parent_level;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER region_tree_guard BEFORE INSERT OR UPDATE OF level, parent_id ON region
  FOR EACH ROW EXECUTE FUNCTION bee_region_tree_guard();
--> statement-breakpoint
-- country 单根：partial unique（level 列在过滤集内恒等，两行 country 即冲突）
CREATE UNIQUE INDEX region_single_country_uq ON region (level) WHERE level = 'country';
--> statement-breakpoint

-- 3b) 引用冻结：被观测/报价/指标/映射/覆盖/子节点引用的 region，level 与 parent 冻结、禁删
CREATE FUNCTION bee_region_referenced_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rid uuid;
BEGIN
  rid := COALESCE(NEW.id, OLD.id);
  IF TG_OP = 'UPDATE'
     AND OLD.level IS NOT DISTINCT FROM NEW.level
     AND OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id THEN
    RETURN NEW; -- 层级/父节点未动（改名等），放行
  END IF;
  IF EXISTS (
    SELECT 1 FROM price_observation WHERE region_id = rid
    UNION ALL SELECT 1 FROM daily_quote WHERE region_id = rid
    UNION ALL SELECT 1 FROM derived_indicator WHERE region_id = rid
    UNION ALL SELECT 1 FROM region_mapping WHERE region_id = rid
    UNION ALL SELECT 1 FROM source_coverage WHERE region_id = rid
    UNION ALL SELECT 1 FROM region WHERE parent_id = rid
  ) THEN
    RAISE EXCEPTION 'region % 已被引用（观测/报价/指标/映射/覆盖/子节点）：level 与 parent 冻结、禁止删除 —— 维度参与事实后不可改', rid;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER region_referenced_guard BEFORE UPDATE OF level, parent_id OR DELETE ON region
  FOR EACH ROW EXECUTE FUNCTION bee_region_referenced_guard();
--> statement-breakpoint

-- 4) derived_indicator kind ↔ region 层级绑定（替换 0000 的层级集合守卫）
DROP TRIGGER IF EXISTS derived_indicator_region_guard ON derived_indicator;
--> statement-breakpoint
CREATE FUNCTION bee_guard_indicator_region() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lvl text;
  expected text;
BEGIN
  IF NEW.region_id IS NULL THEN
    RETURN NEW;
  END IF;
  expected := CASE NEW.kind
    WHEN 'national_weighted_avg' THEN 'country'
    WHEN 'national_median' THEN 'country'
    WHEN 'region_aggregate' THEN 'macro_region'
    WHEN 'city_aggregate' THEN 'city'
  END;
  SELECT level::text INTO lvl FROM region WHERE id = NEW.region_id;
  IF lvl IS NULL OR lvl = expected THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'indicator region guard: kind % 的 region 必须是 % 层级，实际为 % —— kind 与层级绑定，见 docs/data-model.md', NEW.kind, expected, lvl;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER derived_indicator_region_guard BEFORE INSERT OR UPDATE OF region_id, kind ON derived_indicator
  FOR EACH ROW EXECUTE FUNCTION bee_guard_indicator_region();
--> statement-breakpoint

-- 4b) derived_indicator：维度字段冻结（仅 value/method_json/method_version/computation_run_id 可随重算更新）+ 禁 DELETE
CREATE FUNCTION bee_derived_indicator_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_view jsonb;
  new_view jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'derived_indicator 不可删除：指标是溯源锚点，重算 = 更新计算字段（value/method_json/method_version/computation_run_id）';
  END IF;
  old_view := to_jsonb(OLD) - '{value,method_json,method_version,computation_run_id}'::text[];
  new_view := to_jsonb(NEW) - '{value,method_json,method_version,computation_run_id}'::text[];
  IF old_view IS DISTINCT FROM new_view THEN
    RAISE EXCEPTION 'derived_indicator 维度字段（kind/category/spec/region/price_type/basis_date/is_aggregate）冻结，仅 value/method_json/method_version/computation_run_id 可随重算更新';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER derived_indicator_guard BEFORE UPDATE OR DELETE ON derived_indicator
  FOR EACH ROW EXECUTE FUNCTION bee_derived_indicator_guard();
--> statement-breakpoint

-- 5) indicator_contribution：维度一致 + 聚合时值快照落在 quote 区间内
CREATE FUNCTION bee_indicator_contribution_dim_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ind record;
  q record;
  qlvl int;
  ilvl int;
BEGIN
  SELECT * INTO ind FROM derived_indicator WHERE id = NEW.indicator_id;
  SELECT * INTO q FROM daily_quote WHERE id = NEW.quote_id;
  IF q.category_id <> ind.category_id
     OR (ind.spec_id IS NOT NULL AND q.spec_id <> ind.spec_id)
     OR (ind.price_type IS NOT NULL AND q.price_type <> ind.price_type)
     OR q.quote_date <> ind.basis_date THEN
    RAISE EXCEPTION 'indicator contribution: 贡献 quote 与指标维度不一致（category/spec/price_type/quote_date 必须对齐 basis_date）';
  END IF;
  qlvl := CASE (SELECT level::text FROM region WHERE id = q.region_id)
    WHEN 'market' THEN 1 WHEN 'city' THEN 2 WHEN 'macro_region' THEN 3 ELSE 4 END;
  ilvl := CASE (SELECT level::text FROM region WHERE id = ind.region_id)
    WHEN 'market' THEN 1 WHEN 'city' THEN 2 WHEN 'macro_region' THEN 3 ELSE 4 END;
  IF qlvl >= ilvl THEN
    RAISE EXCEPTION 'indicator contribution: 贡献报价地域层级必须严格低于指标层级（聚合只能自下而上）';
  END IF;
  IF NEW.value_at_aggregation < q.value_low OR NEW.value_at_aggregation > q.value_high THEN
    RAISE EXCEPTION 'indicator contribution: value_at_aggregation 必须落在该 quote 的 [value_low, value_high] 区间内（快照防篡改）';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER indicator_contribution_dim_guard BEFORE INSERT ON indicator_contribution
  FOR EACH ROW EXECUTE FUNCTION bee_indicator_contribution_dim_guard();
--> statement-breakpoint
-- 行写定即冻结：禁 UPDATE；重算 = 同事务内 DELETE 旧行 + INSERT 新行
CREATE FUNCTION bee_indicator_contribution_freeze_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'indicator_contribution 写入即冻结：禁 UPDATE；重算 = 同事务内删旧插新（提交时校验每指标至少一条贡献）';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER indicator_contribution_freeze_guard BEFORE UPDATE ON indicator_contribution
  FOR EACH ROW EXECUTE FUNCTION bee_indicator_contribution_freeze_guard();
--> statement-breakpoint
-- 每指标至少一条贡献（可延迟到提交）：挂在本表与 derived_indicator 上双保险
-- —— 只挂本表会漏掉「插入指标但一条贡献都不写」的路径。
CREATE FUNCTION bee_indicator_contribution_nonempty() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ind_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'indicator_contribution' THEN
    ind_id := COALESCE(NEW.indicator_id, OLD.indicator_id);
  ELSE
    ind_id := NEW.id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM indicator_contribution WHERE indicator_id = ind_id) THEN
    RAISE EXCEPTION 'indicator contribution: 指标 % 必须至少保留一条贡献明细（重算 = 同事务内删旧插新，不许清空）', ind_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER indicator_contribution_nonempty
  AFTER INSERT OR DELETE ON indicator_contribution
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bee_indicator_contribution_nonempty();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER derived_indicator_nonempty_contribution
  AFTER INSERT ON derived_indicator
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bee_indicator_contribution_nonempty();
--> statement-breakpoint

-- 6) daily_quote 定档贡献一致性（可延迟到提交）：
--    贡献观测必须全部存在、全部 validated，且 source_count = 贡献观测的去重来源数
CREATE FUNCTION bee_daily_quote_contributions_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad_count int;
  distinct_sources int;
BEGIN
  SELECT count(*) INTO bad_count FROM unnest(NEW.contributing_observation_ids) AS t(oid)
    WHERE NOT EXISTS (SELECT 1 FROM price_observation o WHERE o.id = t.oid);
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'daily_quote: contributing_observation_ids 里有 % 个不存在的观测 id', bad_count;
  END IF;
  SELECT count(*) INTO bad_count FROM price_observation o
    WHERE o.id = ANY (NEW.contributing_observation_ids) AND o.validation_status <> 'validated';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'daily_quote: 参与定档的观测必须全部是 validated（当前有 % 条不是）', bad_count;
  END IF;
  SELECT count(DISTINCT o.source_id) INTO distinct_sources FROM price_observation o
    WHERE o.id = ANY (NEW.contributing_observation_ids);
  IF distinct_sources <> NEW.source_count THEN
    RAISE EXCEPTION 'daily_quote: source_count（%）必须等于贡献观测的去重来源数（%）', NEW.source_count, distinct_sources;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER daily_quote_contributions_check
  AFTER INSERT OR UPDATE ON daily_quote
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bee_daily_quote_contributions_check();
--> statement-breakpoint

-- 7) run 台账：状态机 + 终态冻结 + append-only
CREATE FUNCTION bee_run_ledger_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pipeline_run 台账不可删除（append-only）';
  END IF;
  IF OLD.status IN ('succeeded', 'failed', 'partial') THEN
    RAISE EXCEPTION 'pipeline_run % 已终态（%），台账冻结：不可再改、不可重复 finish', OLD.id, OLD.status;
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('pending', 'running', 'succeeded', 'failed', 'partial'))
    OR (OLD.status = 'running' AND NEW.status IN ('running', 'succeeded', 'failed', 'partial'))
  ) THEN
    RAISE EXCEPTION 'pipeline_run 状态机违规：% → % 不允许（pending→running→succeeded|failed|partial，终态冻结）', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pipeline_run_ledger_guard BEFORE UPDATE OR DELETE ON pipeline_run
  FOR EACH ROW EXECUTE FUNCTION bee_run_ledger_guard();
--> statement-breakpoint
-- step 台账：同构状态机（终态 succeeded|failed|skipped 冻结）+ append-only
CREATE FUNCTION bee_step_ledger_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pipeline_step 台账不可删除（append-only）';
  END IF;
  IF OLD.status IN ('succeeded', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'pipeline_step % 已终态（%），台账冻结：不可再改、不可重复 finish', OLD.id, OLD.status;
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('pending', 'running', 'succeeded', 'failed', 'skipped'))
    OR (OLD.status = 'running' AND NEW.status IN ('running', 'succeeded', 'failed', 'skipped'))
  ) THEN
    RAISE EXCEPTION 'pipeline_step 状态机违规：% → % 不允许（pending→running→succeeded|failed|skipped，终态冻结）', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pipeline_step_ledger_guard BEFORE UPDATE OR DELETE ON pipeline_step
  FOR EACH ROW EXECUTE FUNCTION bee_step_ledger_guard();
--> statement-breakpoint

-- 8) 确定性索引
-- 幂等键唯一（pg-boss at-least-once 重投复用既有 run）
CREATE UNIQUE INDEX pipeline_run_idempotency_uq ON pipeline_run (idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
-- 同一 (scope, source, 原文) 只允许一条 active 映射（NULL source 归一为零 uuid）
-- 查询契约：source 专属 active 行优先于 global active 行（P0-3 实现必须遵守）
CREATE UNIQUE INDEX term_mapping_active_uq
  ON term_mapping (scope, COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid), raw_category_text, COALESCE(raw_spec_text, ''))
  WHERE status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX region_mapping_active_uq
  ON region_mapping (scope, COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid), raw_region_text)
  WHERE status = 'active';
--> statement-breakpoint
-- 单 canonical 单位：partial unique（is_canonical 过滤集内恒为 1，两行即冲突）
CREATE UNIQUE INDEX unit_single_canonical_uq ON unit (is_canonical) WHERE is_canonical = 1;