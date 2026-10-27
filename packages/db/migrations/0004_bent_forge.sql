CREATE TYPE "public"."data_layer" AS ENUM('international', 'national', 'regional');--> statement-breakpoint
CREATE TYPE "public"."series_frequency" AS ENUM('daily', 'weekly', 'monthly', 'quarterly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."series_kind" AS ENUM('futures', 'index', 'inventory', 'macro');--> statement-breakpoint
ALTER TYPE "public"."indicator_kind" ADD VALUE IF NOT EXISTS 'national_reference';--> statement-breakpoint
CREATE TABLE "market_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_cn" text NOT NULL,
	"layer" "data_layer" NOT NULL,
	"kind" "series_kind" NOT NULL,
	"frequency" "series_frequency" NOT NULL,
	"source_id" uuid NOT NULL,
	"category_id" uuid,
	"region_id" uuid,
	"instrument_code" text NOT NULL,
	"venue" text,
	"unit_id" uuid,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"external_ref" text,
	"display_allowed" boolean DEFAULT true NOT NULL,
	"summary" text,
	"status" "dict_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_series_code_unique" UNIQUE("code"),
	CONSTRAINT "market_series_id_source_uq" UNIQUE("id","source_id"),
	CONSTRAINT "market_series_international_region" CHECK ("market_series"."layer" <> 'international' OR "market_series"."region_id" IS NULL),
	CONSTRAINT "market_series_regional_region" CHECK ("market_series"."layer" <> 'regional' OR "market_series"."region_id" IS NOT NULL),
	CONSTRAINT "market_series_currency_shape" CHECK ("market_series"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "series_point" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"obs_date" date NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"open_price" numeric(18, 4),
	"high_price" numeric(18, 4),
	"low_price" numeric(18, 4),
	"close_price" numeric(18, 4),
	"settle_price" numeric(18, 4),
	"volume" numeric(20, 2),
	"open_interest" numeric(20, 2),
	"turnover" numeric(20, 2),
	"detail" jsonb,
	"fetch_id" uuid NOT NULL,
	"source_row_index" integer DEFAULT 0 NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_point_key_uq" UNIQUE("series_id","obs_date","revision"),
	CONSTRAINT "series_point_revision_positive" CHECK ("series_point"."revision" >= 1),
	CONSTRAINT "series_point_high_low" CHECK ("series_point"."high_price" IS NULL OR "series_point"."low_price" IS NULL OR "series_point"."high_price" >= "series_point"."low_price")
);
--> statement-breakpoint
ALTER TABLE "market_series" ADD CONSTRAINT "market_series_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_series" ADD CONSTRAINT "market_series_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_series" ADD CONSTRAINT "market_series_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_series" ADD CONSTRAINT "market_series_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_point" ADD CONSTRAINT "series_point_series_id_market_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."market_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_point" ADD CONSTRAINT "series_point_fetch_id_raw_fetch_id_fk" FOREIGN KEY ("fetch_id") REFERENCES "public"."raw_fetch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_point" ADD CONSTRAINT "series_point_run_id_pipeline_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_point" ADD CONSTRAINT "series_point_series_source_fk" FOREIGN KEY ("series_id","source_id") REFERENCES "public"."market_series"("id","source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_point" ADD CONSTRAINT "series_point_fetch_source_fk" FOREIGN KEY ("fetch_id","source_id") REFERENCES "public"."raw_fetch"("id","source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_series_layer_idx" ON "market_series" USING btree ("layer","kind");--> statement-breakpoint
CREATE INDEX "market_series_source_idx" ON "market_series" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "series_point_date_idx" ON "series_point" USING btree ("obs_date");--> statement-breakpoint
CREATE INDEX "series_point_series_date_idx" ON "series_point" USING btree ("series_id","obs_date");

--> statement-breakpoint
-- =====================================================================================
-- 时序层守卫（与 price_observation 同一纪律：值写入即冻结；修正 = 新 revision）
-- =====================================================================================

-- 1) 时序点不可变：禁 UPDATE / DELETE / TRUNCATE。修正 = 同序列同日期 revision+1 的新行。
CREATE FUNCTION bee_series_point_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'series_point 不可删除：修正 = 同序列同日期新 revision + 旧值保留，见 docs/data-model.md §9';
  END IF;
  RAISE EXCEPTION 'series_point 值不可变：修正请写 revision+1 的新行（docs/data-model.md §9）';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER series_point_immutable BEFORE UPDATE OR DELETE ON series_point
  FOR EACH ROW EXECUTE FUNCTION bee_series_point_guard();
--> statement-breakpoint
CREATE TRIGGER series_point_truncate_guard BEFORE TRUNCATE ON series_point
  FOR EACH STATEMENT EXECUTE FUNCTION bee_worm_guard();
--> statement-breakpoint

-- 2) 序列层级 ↔ 地域层级绑定：国际不挂地域、区域必须挂到具体市场/城市/大区、
--    全国只能挂 country（或留空）。「全国均价」不可能被塞进一条区域序列。
CREATE FUNCTION bee_guard_series_region() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lvl text;
BEGIN
  IF NEW.region_id IS NULL THEN
    IF NEW.layer = 'international' THEN
      RETURN NEW;
    END IF;
    RETURN NEW;
  END IF;
  SELECT level::text INTO lvl FROM region WHERE id = NEW.region_id;
  IF lvl IS NULL THEN
    RAISE EXCEPTION 'series region guard: region % 不存在', NEW.region_id;
  END IF;
  IF NEW.layer = 'national' AND lvl <> 'country' THEN
    RAISE EXCEPTION 'series region guard: 全国层序列只能挂 country，实际为 %（docs/data-model.md §9）', lvl;
  END IF;
  IF NEW.layer = 'regional' AND lvl NOT IN ('city', 'market', 'macro_region') THEN
    RAISE EXCEPTION 'series region guard: 区域层序列必须挂 city/market/macro_region，实际为 %（docs/data-model.md §9）', lvl;
  END IF;
  IF NEW.layer = 'international' THEN
    RAISE EXCEPTION 'series region guard: 国际层序列不得挂地域节点（docs/data-model.md §9）';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER market_series_region_guard BEFORE INSERT OR UPDATE OF layer, region_id ON market_series
  FOR EACH ROW EXECUTE FUNCTION bee_guard_series_region();
