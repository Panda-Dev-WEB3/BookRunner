-- Timescale hypertables for time-series tables (idempotent; safe to re-run after drizzle migrations).
CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable('quotes', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('fills', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('limits', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('oracle_prices', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);

-- Compression for older chunks (quotes are high-volume).
ALTER TABLE quotes SET (timescaledb.compress, timescaledb.compress_segmentby = 'book_id');
SELECT add_compression_policy('quotes', INTERVAL '7 days', if_not_exists => TRUE);

-- oracle_prices: one row per price id every push interval (~50 MB/day on mainnet), insert-only; the API
-- reads only the latest row per price id from the last 7 days (latestOraclePrices), so older chunks compress.
ALTER TABLE oracle_prices SET (timescaledb.compress, timescaledb.compress_segmentby = 'price_id', timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('oracle_prices', INTERVAL '7 days', if_not_exists => TRUE);
