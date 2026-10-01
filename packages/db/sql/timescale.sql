-- Timescale hypertables for time-series tables (idempotent; safe to re-run after drizzle migrations).
CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable('quotes', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('fills', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('limits', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('oracle_prices', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE);

-- Compression for older chunks (quotes are high-volume).
ALTER TABLE quotes SET (timescaledb.compress, timescaledb.compress_segmentby = 'book_id');
SELECT add_compression_policy('quotes', INTERVAL '7 days', if_not_exists => TRUE);
