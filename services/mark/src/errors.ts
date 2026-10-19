/** A mark attempt refused for now (nothing committed); the mark job retries it with backoff. */
export class RetryableMarkError extends Error {}
