CREATE TABLE "engine_price_1m" (
	"market_id" integer NOT NULL,
	"underlying" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"open_wad" numeric(78, 0) NOT NULL,
	"high_wad" numeric(78, 0) NOT NULL,
	"low_wad" numeric(78, 0) NOT NULL,
	"close_wad" numeric(78, 0) NOT NULL,
	"first_at" bigint NOT NULL,
	"last_at" bigint NOT NULL,
	"held" boolean NOT NULL,
	CONSTRAINT "engine_price_1m_market_id_underlying_bucket_pk" PRIMARY KEY("market_id","underlying","bucket")
);
--> statement-breakpoint
CREATE TABLE "engine_trader_events" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"market_id" integer NOT NULL,
	"trader" text NOT NULL,
	"kind" text NOT NULL,
	"size_raw" numeric(78, 0),
	"new_size_raw" numeric(78, 0),
	"price_wad" numeric(78, 0),
	"fee_raw" numeric(78, 0),
	"pnl_raw" numeric(78, 0),
	"margin_delta_raw" numeric(78, 0),
	"funding_raw" numeric(78, 0),
	"bad_debt_raw" numeric(78, 0),
	"counterparty" text,
	CONSTRAINT "engine_trader_events_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE INDEX "engine_price_1m_bucket" ON "engine_price_1m" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "engine_trader_events_trader" ON "engine_trader_events" USING btree ("trader","market_id","block","log_index");