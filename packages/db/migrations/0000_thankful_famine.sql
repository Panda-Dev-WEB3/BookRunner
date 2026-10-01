CREATE TABLE "agent_keys" (
	"book_id" bigint NOT NULL,
	"key" text NOT NULL,
	"operator" text NOT NULL,
	"valid_until" timestamp with time zone,
	"inventory_tier_usd" numeric(38, 6),
	"status" text NOT NULL,
	"registered_tx" text,
	"revoked_tx" text,
	"revoked_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_keys_book_id_key_pk" PRIMARY KEY("book_id","key")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" bigint PRIMARY KEY NOT NULL,
	"charter_id" bigint NOT NULL,
	"senior_addr" text NOT NULL,
	"junior_addr" text NOT NULL,
	"vault_addr" text NOT NULL,
	"venue" smallint NOT NULL,
	"symbol" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"book_addr" text NOT NULL,
	"mandate_addr" text NOT NULL,
	"router_addr" text NOT NULL,
	"desk_addr" text NOT NULL,
	"adapter_addr" text NOT NULL,
	"underlying" text NOT NULL,
	"name" text,
	"state" text DEFAULT 'Subscription' NOT NULL,
	"subscription_ends" timestamp with time zone,
	"senior_nav" numeric(38, 6),
	"junior_nav" numeric(38, 6),
	"nav_usd" numeric(38, 6),
	"last_mark_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_cursor" (
	"name" text PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charters" (
	"id" bigint PRIMARY KEY NOT NULL,
	"sponsor" text NOT NULL,
	"struct_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"jury_cid" text,
	"decided_at" timestamp with time zone,
	"bond_tx" text,
	"underlying" text NOT NULL,
	"symbol" text NOT NULL,
	"venue" smallint NOT NULL,
	"fee_usd" numeric(38, 6),
	"bond_bkrn" numeric(78, 0),
	"filed_at" timestamp with time zone NOT NULL,
	"book_addr" text,
	"meta" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "committee" (
	"member" text PRIMARY KEY NOT NULL,
	"bond" numeric(78, 0) DEFAULT '0' NOT NULL,
	"votes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seat" smallint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"book_id" bigint,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"book_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"side" text NOT NULL,
	"qty" double precision NOT NULL,
	"px" double precision NOT NULL,
	"fee_usd" double precision NOT NULL,
	"venue_trade_id" text NOT NULL,
	"maker" boolean DEFAULT true NOT NULL,
	"trader" text
);
--> statement-breakpoint
CREATE TABLE "hedges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"asset" text NOT NULL,
	"qty_raw" numeric(78, 0) NOT NULL,
	"px" double precision NOT NULL,
	"mult" double precision NOT NULL,
	"tx_hash" text NOT NULL,
	"venue" text DEFAULT 'UNIV3' NOT NULL,
	"value_usd" numeric(38, 6)
);
--> statement-breakpoint
CREATE TABLE "jury_verdicts" (
	"id" serial PRIMARY KEY NOT NULL,
	"charter_id" bigint NOT NULL,
	"cid" text NOT NULL,
	"digest" text NOT NULL,
	"recommend_approve" boolean NOT NULL,
	"verdict" jsonb NOT NULL,
	"posted_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"breaches" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"tx_hashes" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "limits" (
	"book_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"inventory_util" double precision NOT NULL,
	"skew_util" double precision NOT NULL,
	"hedge_ratio" double precision,
	"drawdown_bps" double precision NOT NULL,
	"state" text NOT NULL,
	"off_hours" boolean DEFAULT false NOT NULL,
	"breaches" jsonb,
	"net_exposure_usd" double precision,
	"live_nav_usd" double precision
);
--> statement-breakpoint
CREATE TABLE "marks" (
	"id" bigint PRIMARY KEY NOT NULL,
	"book_id" bigint NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"nav_usd" numeric(38, 6) NOT NULL,
	"senior_nav" numeric(38, 6),
	"junior_nav" numeric(38, 6),
	"pnl_json" jsonb NOT NULL,
	"receipts_root" text NOT NULL,
	"tx_hash" text NOT NULL,
	"inventory_root" text NOT NULL,
	"pnl_json_hash" text NOT NULL,
	"deployed_value_usd" numeric(38, 6) NOT NULL,
	"flow_nonce" bigint NOT NULL,
	"signer" text NOT NULL,
	"signature" text NOT NULL,
	"applied_tx" text,
	"senior_price" double precision,
	"junior_price" double precision,
	"pnl_usd" numeric(38, 6),
	"committed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oracle_prices" (
	"price_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"price" double precision NOT NULL,
	"held" boolean NOT NULL,
	"source_count" integer NOT NULL,
	"sources" jsonb NOT NULL,
	"sources_hash" text NOT NULL,
	"signature" text NOT NULL,
	"pushed_tx" text
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"book_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"bid" double precision,
	"ask" double precision,
	"size" double precision NOT NULL,
	"inventory_usd" double precision NOT NULL,
	"skew_bps" double precision NOT NULL,
	"mid" double precision,
	"oracle" double precision,
	"width_bps" double precision
);
--> statement-breakpoint
CREATE TABLE "receipt_roots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" bigint NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"root" text NOT NULL,
	"leaf_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" bigint NOT NULL,
	"kind" smallint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"hour_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redemptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" bigint NOT NULL,
	"tranche" text NOT NULL,
	"wallet" text NOT NULL,
	"shares" numeric(38, 6) NOT NULL,
	"notice_at" timestamp with time zone NOT NULL,
	"honoured_mark_id" bigint,
	"request_id" text NOT NULL,
	"eligible_at" timestamp with time zone NOT NULL,
	"assets" numeric(38, 6),
	"claimed_at" timestamp with time zone,
	"request_tx" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"gross_usd" numeric(38, 6) NOT NULL,
	"expenses_usd" numeric(38, 6) DEFAULT '0' NOT NULL,
	"carry_usd" numeric(38, 6) DEFAULT '0' NOT NULL,
	"senior_usd" numeric(38, 6) DEFAULT '0' NOT NULL,
	"junior_usd" numeric(38, 6) DEFAULT '0' NOT NULL,
	"period" bigint,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" bigint NOT NULL,
	"tranche" text NOT NULL,
	"wallet" text NOT NULL,
	"shares" numeric(38, 6) DEFAULT '0' NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"assets" numeric(38, 6) DEFAULT '0' NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_accounts" (
	"book_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"account_id" text NOT NULL,
	"key_prefix" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "venue_accounts_book_id_kind_account_id_pk" PRIMARY KEY("book_id","kind","account_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"subscription_id" integer NOT NULL,
	"event_id" bigint NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types" text[] NOT NULL,
	"book_id" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "charters_status_idx" ON "charters" USING btree ("status");--> statement-breakpoint
CREATE INDEX "events_type_created" ON "events" USING btree ("type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_dedupe" ON "events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_book_trade_ts" ON "fills" USING btree ("book_id","venue_trade_id","ts");--> statement-breakpoint
CREATE INDEX "fills_book_ts" ON "fills" USING btree ("book_id","ts");--> statement-breakpoint
CREATE INDEX "hedges_book_ts" ON "hedges" USING btree ("book_id","ts");--> statement-breakpoint
CREATE INDEX "limits_book_ts" ON "limits" USING btree ("book_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "marks_book_period" ON "marks" USING btree ("book_id","period_end");--> statement-breakpoint
CREATE INDEX "oracle_prices_id_ts" ON "oracle_prices" USING btree ("price_id","ts");--> statement-breakpoint
CREATE INDEX "quotes_book_ts" ON "quotes" USING btree ("book_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_roots_book_hour" ON "receipt_roots" USING btree ("book_id","hour_start");--> statement-breakpoint
CREATE INDEX "receipts_book_hour" ON "receipts" USING btree ("book_id","hour_start");--> statement-breakpoint
CREATE UNIQUE INDEX "redemptions_tx_log" ON "redemptions" USING btree ("request_tx","log_index");--> statement-breakpoint
CREATE INDEX "redemptions_book_bucket" ON "redemptions" USING btree ("book_id","tranche","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_tx_log" ON "settlements" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "settlements_book_ts" ON "settlements" USING btree ("book_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_tx_log" ON "subscriptions" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "subscriptions_book_wallet" ON "subscriptions" USING btree ("book_id","wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_sub_event" ON "webhook_deliveries" USING btree ("subscription_id","event_id");