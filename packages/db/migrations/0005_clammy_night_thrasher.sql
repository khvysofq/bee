CREATE TABLE "ingest_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_run_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_ok" boolean DEFAULT false NOT NULL,
	"dedupe_key" text NOT NULL,
	"evidence_ref" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"validator_version" text,
	"accepted_row_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_candidate_dedupe_uq" UNIQUE("dedupe_key"),
	CONSTRAINT "ingest_candidate_kind_domain" CHECK ("ingest_candidate"."kind" IN ('quote', 'series_point', 'news', 'analysis')),
	CONSTRAINT "ingest_candidate_status_domain" CHECK ("ingest_candidate"."status" IN ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "job_def" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"tier" text DEFAULT 'deterministic' NOT NULL,
	"target" jsonb NOT NULL,
	"goal" text NOT NULL,
	"adapter" text,
	"output_schema" jsonb,
	"mapping" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"agent" jsonb,
	"policy" jsonb,
	"priority" integer DEFAULT 5 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_def_code_unique" UNIQUE("code"),
	CONSTRAINT "job_def_type_domain" CHECK ("job_def"."type" IN ('fetch_table', 'fetch_article', 'render_page', 'extract_news', 'analyze', 'healthcheck')),
	CONSTRAINT "job_def_tier_domain" CHECK ("job_def"."tier" IN ('deterministic', 'render', 'agent')),
	CONSTRAINT "job_def_priority_range" CHECK ("job_def"."priority" BETWEEN 1 AND 9)
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_code" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"worker_id" text,
	"tier_used" text,
	"cost_ms" integer,
	"cost_tokens" integer,
	"fetched_bytes" integer,
	"http_status" integer,
	"raw_fetch_id" uuid,
	"error_code" text,
	"error_detail" text,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_run_code_scheduled_uq" UNIQUE("job_code","scheduled_for"),
	CONSTRAINT "job_run_status_domain" CHECK ("job_run"."status" IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'skipped', 'policy_blocked')),
	CONSTRAINT "job_run_attempt_positive" CHECK ("job_run"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "source_policy" (
	"source_code" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"robots_status" text,
	"robots_checked_at" date,
	"tos_note" text,
	"login_wall" boolean DEFAULT false,
	"redistribution" text DEFAULT 'internal_only' NOT NULL,
	"rps_limit" numeric,
	"notes" text,
	CONSTRAINT "source_policy_redistribution_domain" CHECK ("source_policy"."redistribution" IN ('none', 'internal_only', 'attribution', 'licensed')),
	CONSTRAINT "source_policy_rps_positive" CHECK ("source_policy"."rps_limit" IS NULL OR "source_policy"."rps_limit" > 0)
);
--> statement-breakpoint
CREATE INDEX "ingest_candidate_status_idx" ON "ingest_candidate" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ingest_candidate_run_idx" ON "ingest_candidate" USING btree ("job_run_id");--> statement-breakpoint
CREATE INDEX "job_def_enabled_idx" ON "job_def" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "job_def_type_idx" ON "job_def" USING btree ("type");--> statement-breakpoint
CREATE INDEX "job_run_job_idx" ON "job_run" USING btree ("job_code","started_at");--> statement-breakpoint
CREATE INDEX "job_run_status_idx" ON "job_run" USING btree ("status","started_at");