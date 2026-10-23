CREATE TABLE "engine_positions" (
	"market_id" integer NOT NULL,
	"trader" text NOT NULL,
	"size_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"last_block" bigint NOT NULL,
	"last_log_index" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engine_positions_market_id_trader_pk" PRIMARY KEY("market_id","trader")
);
