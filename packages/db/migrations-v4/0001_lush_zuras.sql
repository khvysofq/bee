CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"category_id" uuid NOT NULL,
	"region_id" uuid NOT NULL,
	"type" text NOT NULL,
	"scale" text,
	"main_products" text,
	"description" text,
	"contact_name" text,
	"contact_phone" text,
	"verified" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_name_region_uq" UNIQUE("name","region_id"),
	CONSTRAINT "company_type_chk" CHECK ("company"."type" IN ('recycler', 'smelter', 'trader', 'end_user', 'supplier')),
	CONSTRAINT "company_status_chk" CHECK ("company"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "opportunity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"region_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"quantity" numeric(14, 2),
	"unit" text,
	"price_min" numeric(14, 2),
	"price_max" numeric(14, 2),
	"currency" text DEFAULT 'CNY' NOT NULL,
	"deadline" date,
	"contact_name" text,
	"contact_phone" text,
	"status" text DEFAULT 'open' NOT NULL,
	"is_demo" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_kind_chk" CHECK ("opportunity"."kind" IN ('purchase', 'supply', 'cooperation')),
	CONSTRAINT "opportunity_status_chk" CHECK ("opportunity"."status" IN ('open', 'closed')),
	CONSTRAINT "opportunity_price_range_chk" CHECK ("opportunity"."price_min" IS NULL OR "opportunity"."price_max" IS NULL OR "opportunity"."price_min" <= "opportunity"."price_max")
);
--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_category_region_idx" ON "company" USING btree ("category_id","region_id");--> statement-breakpoint
CREATE INDEX "company_region_idx" ON "company" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "opportunity_category_region_kind_published_idx" ON "opportunity" USING btree ("category_id","region_id","kind","published_at" DESC);--> statement-breakpoint
CREATE INDEX "opportunity_company_idx" ON "opportunity" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "opportunity_status_published_idx" ON "opportunity" USING btree ("status","published_at" DESC);