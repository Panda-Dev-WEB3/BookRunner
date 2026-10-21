ALTER TABLE "pool_books" ADD COLUMN "stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pool_snapshots" ADD COLUMN "stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "pool_snapshots_ts" ON "pool_snapshots" USING btree ("ts");