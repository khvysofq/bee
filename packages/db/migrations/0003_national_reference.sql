-- GUA-20：国家统计局旬报是「来源直接发布的全国参考价」，既不是城市观测，也不是本系统按
-- 城市聚合出的全国均价。新增 national_reference 指标类型，仅允许挂 country，方法口径由
-- method_json 明示「直接引用」；不改变 national_weighted_avg / national_median 的语义。
ALTER TYPE "public"."indicator_kind" ADD VALUE IF NOT EXISTS 'national_reference';--> statement-breakpoint
CREATE OR REPLACE FUNCTION bee_guard_indicator_region() RETURNS trigger
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
    WHEN 'national_reference' THEN 'country'
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
