CREATE TYPE "public"."actor_kind" AS ENUM('rule', 'agent', 'human', 'system');--> statement-breakpoint
CREATE TYPE "public"."check_kind" AS ENUM('cross_source', 'time_series', 'caliber_consistency', 'dedupe', 'threshold_rule', 'llm_judgment', 'human_override');--> statement-breakpoint
CREATE TYPE "public"."dict_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."exception_kind" AS ENUM('validation', 'caliber', 'source', 'pipeline');--> statement-breakpoint
CREATE TYPE "public"."exception_status" AS ENUM('open', 'resolved', 'wont_fix');--> statement-breakpoint
CREATE TYPE "public"."indicator_kind" AS ENUM('national_weighted_avg', 'national_median', 'region_aggregate', 'city_aggregate');--> statement-breakpoint
CREATE TYPE "public"."mapping_status" AS ENUM('proposed', 'active', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."observation_status" AS ENUM('pending_mapping', 'normalized', 'validated', 'isolated', 'needs_human', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."price_type" AS ENUM('purchase', 'sale', 'ex_works', 'indicative');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."quote_method" AS ENUM('single_source', 'median_multi_source', 'weighted_multi_source');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'published', 'retracted', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."region_level" AS ENUM('market', 'city', 'macro_region', 'country');--> statement-breakpoint
CREATE TYPE "public"."robots_status" AS ENUM('allowed', 'disallowed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('daily_collect', 'validate', 'aggregate', 'publish', 'replay', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('active', 'paused', 'retired');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('webpage', 'rss', 'api');--> statement-breakpoint
CREATE TYPE "public"."step_kind" AS ENUM('fetch', 'extract', 'normalize', 'validate', 'aggregate', 'publish', 'notify');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('pass', 'flag', 'isolate', 'needs_human', 'reject');--> statement-breakpoint
CREATE TABLE "caliber_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"question" text NOT NULL,
	"decision" text NOT NULL,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_from" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_cn" text NOT NULL,
	"name_en" text,
	"description" text,
	"status" "dict_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"decided_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_code_unique" UNIQUE("code"),
	CONSTRAINT "category_code_shape" CHECK ("category"."code" ~ '^[a-z0-9-]+$')
);
--> statement-breakpoint
CREATE TABLE "impurity_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid,
	"spec_id" uuid,
	"rule_kind" text NOT NULL,
	"param_json" jsonb NOT NULL,
	"condition_text" text,
	"status" "dict_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"version" integer DEFAULT 1 NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "impurity_rule_scope_valid" CHECK ("impurity_rule"."spec_id" IS NULL OR "impurity_rule"."category_id" IS NOT NULL),
	CONSTRAINT "impurity_rule_kind_domain" CHECK ("impurity_rule"."rule_kind" IN ('weight_percent', 'price_per_ton', 'grade_downgrade'))
);
--> statement-breakpoint
CREATE TABLE "region_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"source_id" uuid,
	"raw_region_text" text NOT NULL,
	"region_id" uuid NOT NULL,
	"confidence" numeric(3, 2),
	"status" "mapping_status" DEFAULT 'proposed' NOT NULL,
	"note" text,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_mapping_scope_source" CHECK (("region_mapping"."scope" = 'global' AND "region_mapping"."source_id" IS NULL) OR ("region_mapping"."scope" = 'source' AND "region_mapping"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "spec_grade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_cn" text NOT NULL,
	"kind" text DEFAULT 'grade' NOT NULL,
	"quality_tier" integer,
	"definition" text,
	"is_core" integer DEFAULT 0 NOT NULL,
	"status" "dict_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_grade_category_code_uq" UNIQUE("category_id","code"),
	CONSTRAINT "spec_grade_kind_domain" CHECK ("spec_grade"."kind" IN ('spec', 'grade'))
);
--> statement-breakpoint
CREATE TABLE "term_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"source_id" uuid,
	"raw_category_text" text NOT NULL,
	"raw_spec_text" text,
	"category_id" uuid NOT NULL,
	"spec_id" uuid,
	"confidence" numeric(3, 2),
	"status" "mapping_status" DEFAULT 'proposed' NOT NULL,
	"note" text,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "term_mapping_scope_source" CHECK (("term_mapping"."scope" = 'global' AND "term_mapping"."source_id" IS NULL) OR ("term_mapping"."scope" = 'source' AND "term_mapping"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_cn" text NOT NULL,
	"is_canonical" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "unit_conversion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_unit_id" uuid NOT NULL,
	"to_unit_id" uuid NOT NULL,
	"factor" numeric(18, 8) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_conversion_from_to_uq" UNIQUE("from_unit_id","to_unit_id")
);
--> statement-breakpoint
CREATE TABLE "region" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" "region_level" NOT NULL,
	"code" text NOT NULL,
	"name_cn" text NOT NULL,
	"parent_id" uuid,
	"status" "dict_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date,
	"note" text,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_code_unique" UNIQUE("code"),
	CONSTRAINT "region_parent_self" CHECK ("region"."parent_id" IS NULL OR "region"."parent_id" <> "region"."id")
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "source_type" NOT NULL,
	"base_url" text NOT NULL,
	"tos_url" text,
	"robots_status" "robots_status" DEFAULT 'unknown' NOT NULL,
	"robots_checked_at" timestamp with time zone,
	"robots_note" text,
	"trust_weight" numeric(4, 1) DEFAULT '50.0' NOT NULL,
	"trust_note" text,
	"crawl_frequency_per_day" integer DEFAULT 1 NOT NULL,
	"rate_limit_seconds" integer DEFAULT 60 NOT NULL,
	"crawl_window_json" jsonb,
	"fetcher_kind" text DEFAULT 'static_html' NOT NULL,
	"fetcher_params" jsonb,
	"status" "source_status" DEFAULT 'paused' NOT NULL,
	"status_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_code_unique" UNIQUE("code"),
	CONSTRAINT "source_trust_range" CHECK ("source"."trust_weight" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "source_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"spec_id" uuid,
	"region_id" uuid,
	"trust_weight_override" numeric(4, 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_coverage_uq" UNIQUE NULLS NOT DISTINCT("source_id","category_id","spec_id","region_id"),
	CONSTRAINT "source_coverage_trust_range" CHECK ("source_coverage"."trust_weight_override" IS NULL OR "source_coverage"."trust_weight_override" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "source_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_invocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"step_id" uuid,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_sha" text,
	"input_json" jsonb NOT NULL,
	"output_json" jsonb NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "run_kind" NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"triggered_by" text NOT NULL,
	"config_json" jsonb,
	"git_sha" text,
	"rules_version" text,
	"dictionary_hash" text,
	"replay_of_run_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_kind" "step_kind" NOT NULL,
	"seq" integer NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"input_refs" jsonb,
	"output_refs" jsonb,
	"log_excerpt" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_fetch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"run_id" uuid,
	"url" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"http_status" integer NOT NULL,
	"content_sha256" char(64) NOT NULL,
	"content_ref" text NOT NULL,
	"content_type" text,
	"content_size_bytes" integer,
	"page_published_at" timestamp with time zone,
	"fetch_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_fetch_content_sha256_unique" UNIQUE("content_sha256")
);
--> statement-breakpoint
CREATE TABLE "price_observation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fetch_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"source_row_index" integer NOT NULL,
	"raw_text" text NOT NULL,
	"raw_value_low" numeric(12, 2),
	"raw_value_high" numeric(12, 2),
	"raw_unit" text,
	"raw_category_text" text NOT NULL,
	"raw_spec_text" text,
	"raw_region_text" text,
	"raw_price_type_text" text,
	"category_id" uuid,
	"spec_id" uuid,
	"region_id" uuid,
	"price_type" "price_type",
	"norm_value_low" numeric(12, 2),
	"norm_value_high" numeric(12, 2),
	"unit_id" uuid,
	"conversion_applied" jsonb,
	"quote_date" date,
	"observed_at" timestamp with time zone,
	"validation_status" "observation_status" DEFAULT 'pending_mapping' NOT NULL,
	"superseded_by_id" uuid,
	"extract_version" text,
	"normalizer_version" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_observation_fetch_row_uq" UNIQUE("fetch_id","source_row_index"),
	CONSTRAINT "price_observation_raw_range" CHECK ("price_observation"."raw_value_low" IS NULL OR "price_observation"."raw_value_high" IS NULL OR "price_observation"."raw_value_low" <= "price_observation"."raw_value_high"),
	CONSTRAINT "price_observation_norm_range" CHECK ("price_observation"."norm_value_low" IS NULL OR "price_observation"."norm_value_high" IS NULL OR "price_observation"."norm_value_low" <= "price_observation"."norm_value_high"),
	CONSTRAINT "price_observation_validated_completeness" CHECK ("price_observation"."validation_status" <> 'validated' OR (
        "price_observation"."category_id" IS NOT NULL AND "price_observation"."spec_id" IS NOT NULL AND "price_observation"."region_id" IS NOT NULL
        AND "price_observation"."price_type" IS NOT NULL AND "price_observation"."quote_date" IS NOT NULL
        AND "price_observation"."norm_value_low" IS NOT NULL AND "price_observation"."norm_value_high" IS NOT NULL AND "price_observation"."unit_id" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "validation_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_id" uuid NOT NULL,
	"check_kind" "check_kind" NOT NULL,
	"verdict" "verdict" NOT NULL,
	"detail" jsonb NOT NULL,
	"performed_by_kind" text NOT NULL,
	"performed_by_ref" text NOT NULL,
	"run_id" uuid,
	"agent_invocation_id" uuid,
	"rules_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"region_id" uuid NOT NULL,
	"quote_date" date NOT NULL,
	"price_type" "price_type" NOT NULL,
	"value_low" numeric(12, 2) NOT NULL,
	"value_high" numeric(12, 2) NOT NULL,
	"value_mid" numeric(12, 2) NOT NULL,
	"method" "quote_method" NOT NULL,
	"contributing_observation_ids" uuid[] NOT NULL,
	"source_count" integer NOT NULL,
	"method_version" text NOT NULL,
	"rules_version" text,
	"computation_run_id" uuid,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"coverage_note" text,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_quote_key_uq" UNIQUE("category_id","spec_id","region_id","quote_date","price_type"),
	CONSTRAINT "daily_quote_range" CHECK ("daily_quote"."value_low" <= "daily_quote"."value_high" AND "daily_quote"."value_mid" BETWEEN "daily_quote"."value_low" AND "daily_quote"."value_high"),
	CONSTRAINT "daily_quote_confidence_domain" CHECK ("daily_quote"."confidence" IN ('high', 'medium', 'low'))
);
--> statement-breakpoint
CREATE TABLE "derived_indicator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "indicator_kind" NOT NULL,
	"category_id" uuid NOT NULL,
	"spec_id" uuid,
	"region_id" uuid NOT NULL,
	"price_type" "price_type",
	"basis_date" date NOT NULL,
	"value" numeric(12, 2) NOT NULL,
	"method_json" jsonb NOT NULL,
	"method_version" text NOT NULL,
	"computation_run_id" uuid,
	"contributing_quote_ids" uuid[] NOT NULL,
	"is_aggregate" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "derived_indicator_key_uq" UNIQUE NULLS NOT DISTINCT("kind","category_id","spec_id","region_id","price_type","basis_date"),
	CONSTRAINT "derived_indicator_is_aggregate" CHECK ("derived_indicator"."is_aggregate" = 1)
);
--> statement-breakpoint
CREATE TABLE "exception_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "exception_kind" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"summary" text NOT NULL,
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"status" "exception_status" DEFAULT 'open' NOT NULL,
	"assigned_to" text DEFAULT 'unassigned' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "impurity_rule" ADD CONSTRAINT "impurity_rule_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impurity_rule" ADD CONSTRAINT "impurity_rule_spec_id_spec_grade_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."spec_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_grade" ADD CONSTRAINT "spec_grade_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_mapping" ADD CONSTRAINT "term_mapping_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_mapping" ADD CONSTRAINT "term_mapping_spec_id_spec_grade_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."spec_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_conversion" ADD CONSTRAINT "unit_conversion_from_unit_id_unit_id_fk" FOREIGN KEY ("from_unit_id") REFERENCES "public"."unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_conversion" ADD CONSTRAINT "unit_conversion_to_unit_id_unit_id_fk" FOREIGN KEY ("to_unit_id") REFERENCES "public"."unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region" ADD CONSTRAINT "region_parent_id_region_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_coverage" ADD CONSTRAINT "source_coverage_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_event" ADD CONSTRAINT "source_event_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD CONSTRAINT "agent_invocation_run_id_pipeline_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD CONSTRAINT "agent_invocation_step_id_pipeline_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."pipeline_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_step" ADD CONSTRAINT "pipeline_step_run_id_pipeline_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_fetch" ADD CONSTRAINT "raw_fetch_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_fetch" ADD CONSTRAINT "raw_fetch_run_id_pipeline_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_fetch_id_raw_fetch_id_fk" FOREIGN KEY ("fetch_id") REFERENCES "public"."raw_fetch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_spec_id_spec_grade_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."spec_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_superseded_by_id_price_observation_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."price_observation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_run_id_pipeline_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_result" ADD CONSTRAINT "validation_result_observation_id_price_observation_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."price_observation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_result" ADD CONSTRAINT "validation_result_run_id_pipeline_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_quote" ADD CONSTRAINT "daily_quote_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_quote" ADD CONSTRAINT "daily_quote_spec_id_spec_grade_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."spec_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_quote" ADD CONSTRAINT "daily_quote_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_quote" ADD CONSTRAINT "daily_quote_computation_run_id_pipeline_run_id_fk" FOREIGN KEY ("computation_run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_indicator" ADD CONSTRAINT "derived_indicator_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_indicator" ADD CONSTRAINT "derived_indicator_spec_id_spec_grade_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."spec_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_indicator" ADD CONSTRAINT "derived_indicator_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_indicator" ADD CONSTRAINT "derived_indicator_computation_run_id_pipeline_run_id_fk" FOREIGN KEY ("computation_run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "caliber_decision_subject_idx" ON "caliber_decision" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "impurity_rule_scope_idx" ON "impurity_rule" USING btree ("category_id","spec_id");--> statement-breakpoint
CREATE INDEX "region_mapping_lookup_idx" ON "region_mapping" USING btree ("source_id","raw_region_text");--> statement-breakpoint
CREATE INDEX "spec_grade_category_idx" ON "spec_grade" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "term_mapping_lookup_idx" ON "term_mapping" USING btree ("source_id","raw_category_text","raw_spec_text");--> statement-breakpoint
CREATE INDEX "term_mapping_status_idx" ON "term_mapping" USING btree ("status");--> statement-breakpoint
CREATE INDEX "region_level_idx" ON "region" USING btree ("level");--> statement-breakpoint
CREATE INDEX "region_parent_idx" ON "region" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "source_status_idx" ON "source" USING btree ("status");--> statement-breakpoint
CREATE INDEX "source_coverage_lookup_idx" ON "source_coverage" USING btree ("category_id","region_id");--> statement-breakpoint
CREATE INDEX "source_event_source_idx" ON "source_event" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_invocation_run_idx" ON "agent_invocation" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_run_kind_idx" ON "pipeline_run" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_run_status_idx" ON "pipeline_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pipeline_step_run_idx" ON "pipeline_step" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "raw_fetch_source_time_idx" ON "raw_fetch" USING btree ("source_id","fetched_at");--> statement-breakpoint
CREATE INDEX "raw_fetch_run_idx" ON "raw_fetch" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "price_observation_key_idx" ON "price_observation" USING btree ("category_id","region_id","quote_date");--> statement-breakpoint
CREATE INDEX "price_observation_status_idx" ON "price_observation" USING btree ("validation_status");--> statement-breakpoint
CREATE INDEX "price_observation_source_date_idx" ON "price_observation" USING btree ("source_id","quote_date");--> statement-breakpoint
CREATE INDEX "validation_result_observation_idx" ON "validation_result" USING btree ("observation_id","created_at");--> statement-breakpoint
CREATE INDEX "validation_result_verdict_idx" ON "validation_result" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX "daily_quote_date_idx" ON "daily_quote" USING btree ("quote_date");--> statement-breakpoint
CREATE INDEX "daily_quote_lookup_idx" ON "daily_quote" USING btree ("category_id","region_id","quote_date");--> statement-breakpoint
CREATE INDEX "derived_indicator_date_idx" ON "derived_indicator" USING btree ("basis_date");--> statement-breakpoint
CREATE INDEX "exception_queue_triage_idx" ON "exception_queue" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "exception_queue_subject_idx" ON "exception_queue" USING btree ("subject_type","subject_id");--> statement-breakpoint

-- ============================================================
-- 以下为手工追加的守卫触发器（P0-1 定稿；非 drizzle-kit 生成内容）。
-- 与 docs/data-model.md 的分层不变量一一对应：
--  1) WORM：存档层 raw_fetch 与运行台账（validation_result / source_event /
--     agent_invocation / caliber_decision）append-only，禁 UPDATE/DELETE；
--  2) 观测值不可变：price_observation 仅 validation_status / superseded_by_id
--     允许 UPDATE，禁 DELETE —— 修正 = 新观测 + supersede 链，绝无原地改值；
--  3) 地域层级守卫：报价只落 market/city；「全国/大区」只能是
--     derived_indicator（country / macro_region / city）。
-- 要改守卫语义 = 新迁移文件内 DROP + 重建，绝不回改本文件。
-- ============================================================

-- 1) WORM：五张 append-only 表
CREATE FUNCTION bee_worm_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WORM violation: % 是 append-only（禁 UPDATE/DELETE），见 docs/data-model.md', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER raw_fetch_worm BEFORE UPDATE OR DELETE ON raw_fetch
  FOR EACH STATEMENT EXECUTE FUNCTION bee_worm_guard();
--> statement-breakpoint
CREATE TRIGGER validation_result_worm BEFORE UPDATE OR DELETE ON validation_result
  FOR EACH STATEMENT EXECUTE FUNCTION bee_worm_guard();
--> statement-breakpoint
CREATE TRIGGER source_event_worm BEFORE UPDATE OR DELETE ON source_event
  FOR EACH STATEMENT EXECUTE FUNCTION bee_worm_guard();
--> statement-breakpoint
CREATE TRIGGER agent_invocation_worm BEFORE UPDATE OR DELETE ON agent_invocation
  FOR EACH STATEMENT EXECUTE FUNCTION bee_worm_guard();
--> statement-breakpoint
CREATE TRIGGER caliber_decision_worm BEFORE UPDATE OR DELETE ON caliber_decision
  FOR EACH STATEMENT EXECUTE FUNCTION bee_worm_guard();
--> statement-breakpoint

-- 2) 观测值不可变（仅校验状态与取代指针可变）
CREATE FUNCTION bee_price_observation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_view jsonb;
  new_view jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'price_observation 不可删除：修正 = 新观测 + superseded_by_id 链，见 docs/data-model.md';
  END IF;
  old_view := to_jsonb(OLD) - '{validation_status,superseded_by_id}'::text[];
  new_view := to_jsonb(NEW) - '{validation_status,superseded_by_id}'::text[];
  IF old_view IS DISTINCT FROM new_view THEN
    RAISE EXCEPTION 'price_observation 值不可变：仅 validation_status / superseded_by_id 允许 UPDATE，改历史值请走重放与 supersede 链（docs/data-model.md）';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_observation_value_guard BEFORE UPDATE OR DELETE ON price_observation
  FOR EACH ROW EXECUTE FUNCTION bee_price_observation_guard();
--> statement-breakpoint

-- 3) 地域层级守卫（触发器参数即允许的层级集合）
CREATE FUNCTION bee_guard_region_level() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lvl text;
BEGIN
  IF NEW.region_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT level::text INTO lvl FROM region WHERE id = NEW.region_id;
  IF lvl IS NULL OR lvl = ANY (TG_ARGV) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'region level guard: % 允许层级为 %，region % 实为 % —— 报价只落具体市场/城市，全国只可能是派生指标（docs/data-model.md §4）',
    TG_TABLE_NAME, array_to_string(TG_ARGV, '/'), NEW.region_id, lvl;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_observation_region_guard BEFORE INSERT OR UPDATE OF region_id ON price_observation
  FOR EACH ROW EXECUTE FUNCTION bee_guard_region_level('market', 'city');
--> statement-breakpoint
CREATE TRIGGER daily_quote_region_guard BEFORE INSERT OR UPDATE OF region_id ON daily_quote
  FOR EACH ROW EXECUTE FUNCTION bee_guard_region_level('market', 'city');
--> statement-breakpoint
CREATE TRIGGER derived_indicator_region_guard BEFORE INSERT OR UPDATE OF region_id ON derived_indicator
  FOR EACH ROW EXECUTE FUNCTION bee_guard_region_level('country', 'macro_region', 'city');
