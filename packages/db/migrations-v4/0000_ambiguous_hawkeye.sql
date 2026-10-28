CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_cn" text NOT NULL,
	"name_en" text,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_code_unique" UNIQUE("code"),
	CONSTRAINT "category_status_chk" CHECK ("category"."status" IN ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "region" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"level" text NOT NULL,
	"parent_id" uuid,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "region_code_unique" UNIQUE("code"),
	CONSTRAINT "region_level_chk" CHECK ("region"."level" IN ('global', 'country', 'province', 'city', 'market'))
);
--> statement-breakpoint
CREATE TABLE "spec" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"tier" integer,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "spec_category_code_uq" UNIQUE("category_id","code"),
	CONSTRAINT "spec_status_chk" CHECK ("spec"."status" IN ('active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "price_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"spec_id" uuid,
	"region_id" uuid NOT NULL,
	"price_date" date NOT NULL,
	"price_type" text DEFAULT 'market' NOT NULL,
	"value_low" numeric(14, 2),
	"value_high" numeric(14, 2),
	"value_mid" numeric(14, 2) NOT NULL,
	"unit" text DEFAULT '元/吨' NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"source_id" uuid,
	"raw_url" text,
	"captured_at" timestamp with time zone,
	"status" text DEFAULT 'published' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_daily_key_uq" UNIQUE NULLS NOT DISTINCT("category_id","spec_id","region_id","price_date","price_type"),
	CONSTRAINT "price_daily_type_chk" CHECK ("price_daily"."price_type" IN ('market', 'purchase', 'sale', 'ex_works', 'indicative')),
	CONSTRAINT "price_daily_status_chk" CHECK ("price_daily"."status" IN ('draft', 'published', 'retracted')),
	CONSTRAINT "price_daily_range_chk" CHECK (("price_daily"."value_low" IS NULL OR "price_daily"."value_mid" >= "price_daily"."value_low") AND ("price_daily"."value_high" IS NULL OR "price_daily"."value_mid" <= "price_daily"."value_high"))
);
--> statement-breakpoint
CREATE TABLE "content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"region_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body_md_key" text,
	"body_sha256" char(64),
	"assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_date" date NOT NULL,
	"period_start" date,
	"period_end" date,
	"source_id" uuid,
	"url" text,
	"url_hash" char(64),
	"license" text DEFAULT 'internal_only' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"run_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_kind_chk" CHECK ("content"."kind" IN ('news_item', 'news_digest', 'analysis', 'forecast')),
	CONSTRAINT "content_license_chk" CHECK ("content"."license" IN ('none', 'internal_only', 'attribution', 'licensed')),
	CONSTRAINT "content_visibility_chk" CHECK ("content"."visibility" IN ('internal', 'public')),
	CONSTRAINT "content_status_chk" CHECK ("content"."status" IN ('draft', 'published', 'hidden')),
	CONSTRAINT "content_forecast_period_chk" CHECK (("content"."kind" <> 'forecast') OR ("content"."period_start" IS NOT NULL AND "content"."period_end" IS NOT NULL AND "content"."period_end" >= "content"."period_start"))
);
--> statement-breakpoint
CREATE TABLE "admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"category_id" uuid,
	"source_id" uuid,
	"kind" text NOT NULL,
	"schedule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_code_unique" UNIQUE("code"),
	CONSTRAINT "job_kind_chk" CHECK ("job"."kind" IN ('fetch_price', 'fetch_news', 'digest', 'analysis', 'forecast'))
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_run_status_chk" CHECK ("job_run"."status" IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "job_run_attempt_chk" CHECK ("job_run"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"base_url" text,
	"robots_status" text DEFAULT 'unknown' NOT NULL,
	"redistribution" text DEFAULT 'none' NOT NULL,
	"rate_limit_seconds" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_code_unique" UNIQUE("code"),
	CONSTRAINT "source_type_chk" CHECK ("source"."type" IN ('price', 'news', 'analysis', 'mixed')),
	CONSTRAINT "source_robots_status_chk" CHECK ("source"."robots_status" IN ('allowed', 'disallowed', 'unknown')),
	CONSTRAINT "source_redistribution_chk" CHECK ("source"."redistribution" IN ('none', 'internal_only', 'attribution', 'licensed')),
	CONSTRAINT "source_rate_limit_chk" CHECK ("source"."rate_limit_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "region" ADD CONSTRAINT "region_parent_id_region_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec" ADD CONSTRAINT "spec_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_daily" ADD CONSTRAINT "price_daily_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_daily" ADD CONSTRAINT "price_daily_spec_id_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."spec"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_daily" ADD CONSTRAINT "price_daily_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_daily" ADD CONSTRAINT "price_daily_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content" ADD CONSTRAINT "content_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content" ADD CONSTRAINT "content_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content" ADD CONSTRAINT "content_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "region_parent_idx" ON "region" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "region_level_idx" ON "region" USING btree ("level");--> statement-breakpoint
CREATE INDEX "price_daily_category_region_date_idx" ON "price_daily" USING btree ("category_id","region_id","price_date" desc);--> statement-breakpoint
CREATE INDEX "price_daily_category_date_idx" ON "price_daily" USING btree ("category_id","price_date" desc);--> statement-breakpoint
CREATE INDEX "price_daily_spec_idx" ON "price_daily" USING btree ("spec_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_news_item_url_uq" ON "content" USING btree ("source_id","url_hash") WHERE "content"."kind" = 'news_item' AND "content"."url_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "content_news_digest_uq" ON "content" USING btree ("category_id","region_id","content_date") NULLS NOT DISTINCT WHERE "content"."kind" = 'news_digest';--> statement-breakpoint
CREATE UNIQUE INDEX "content_analysis_uq" ON "content" USING btree ("category_id","region_id","content_date") NULLS NOT DISTINCT WHERE "content"."kind" = 'analysis';--> statement-breakpoint
CREATE UNIQUE INDEX "content_forecast_uq" ON "content" USING btree ("category_id","region_id","content_date","period_start","period_end") NULLS NOT DISTINCT WHERE "content"."kind" = 'forecast';--> statement-breakpoint
CREATE INDEX "content_kind_category_date_idx" ON "content" USING btree ("kind","category_id","content_date" desc);--> statement-breakpoint
CREATE INDEX "content_category_region_kind_date_idx" ON "content" USING btree ("category_id","region_id","kind","content_date" desc);--> statement-breakpoint
CREATE INDEX "content_status_published_idx" ON "content" USING btree ("status","published_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "job_run_scheduled_uq" ON "job_run" USING btree ("job_id","scheduled_for") WHERE "job_run"."scheduled_for" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "job_run_job_started_idx" ON "job_run" USING btree ("job_id","started_at" desc);--> statement-breakpoint
CREATE INDEX "job_run_status_idx" ON "job_run" USING btree ("status");