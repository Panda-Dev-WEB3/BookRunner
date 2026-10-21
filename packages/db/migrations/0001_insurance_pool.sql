CREATE TABLE "pool_books" (
	"book_id" bigint PRIMARY KEY NOT NULL,
	"market" text NOT NULL,
	"allocation" numeric(38, 6) NOT NULL,
	"claim" numeric(38, 6) NOT NULL,
	"loss_first_loss" numeric(38, 6) DEFAULT '0' NOT NULL,
	"loss_depositors" numeric(38, 6) DEFAULT '0' NOT NULL,
	"premiums_usd" numeric(38, 6) DEFAULT '0' NOT NULL,
	"last_mark_at" timestamp with time zone,
	"active" boolean NOT NULL,
	"allocated_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_deposits" (
	"id" bigint PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"assets" numeric(38, 6) NOT NULL,
	"epoch" bigint NOT NULL,
	"status" text NOT NULL,
	"shares_raw" numeric(78, 0),
	"requested_at" timestamp with time zone NOT NULL,
	"request_tx" text NOT NULL,
	"closed_at" timestamp with time zone,
	"close_tx" text
);
--> statement-breakpoint
CREATE TABLE "pool_epochs" (
	"epoch" bigint PRIMARY KEY NOT NULL,
	"ends_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"process_tx" text,
	"deposit_assets" numeric(38, 6) DEFAULT '0' NOT NULL,
	"deposit_shares_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"stale_books" integer DEFAULT 0 NOT NULL,
	"filled_shares_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"filled_assets" numeric(38, 6) DEFAULT '0' NOT NULL,
	"complete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_flows" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"book_id" bigint,
	"amount" numeric(38, 6) NOT NULL,
	"first_loss_part" numeric(38, 6) DEFAULT '0' NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_snapshots" (
	"block_number" bigint PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"pool_assets" numeric(38, 6) NOT NULL,
	"depositor_assets" numeric(38, 6) NOT NULL,
	"total_supply_raw" numeric(78, 0) NOT NULL,
	"share_price" numeric(38, 6) NOT NULL,
	"first_loss" numeric(38, 6) NOT NULL,
	"free_liquidity" numeric(38, 6) NOT NULL,
	"claims" numeric(38, 6) NOT NULL,
	"utilisation_bps" integer NOT NULL,
	"premiums_total" numeric(38, 6) NOT NULL,
	"losses_total" numeric(38, 6) NOT NULL,
	"deposits_pending" numeric(38, 6) NOT NULL,
	"pending_shares_raw" numeric(78, 0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_withdrawals" (
	"id" bigint PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"shares_raw" numeric(78, 0) NOT NULL,
	"epoch" bigint NOT NULL,
	"epoch_ends_at" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"request_tx" text NOT NULL,
	"claimed_assets" numeric(38, 6) DEFAULT '0' NOT NULL,
	"last_claim_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "premium_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE INDEX "pool_books_market" ON "pool_books" USING btree ("market");--> statement-breakpoint
CREATE INDEX "pool_deposits_owner" ON "pool_deposits" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "pool_deposits_epoch" ON "pool_deposits" USING btree ("epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_flows_tx_log" ON "pool_flows" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "pool_flows_kind_ts" ON "pool_flows" USING btree ("kind","ts");--> statement-breakpoint
CREATE INDEX "pool_withdrawals_owner" ON "pool_withdrawals" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "pool_withdrawals_epoch" ON "pool_withdrawals" USING btree ("epoch");