// Sliding-window per-identifier rate limiter. Tracks request timestamps per id
// (client IP) and rejects once `max` requests land inside `windowMs`. Mirrors
// the RPM-style limit the Anthropic API enforces, returning a retry-after hint.
//
// Memory is bounded: empty buckets are swept on a timer.

function createLimiter(windowMs, max) {
  const buckets = new Map(); // id -> number[] (timestamps)

  // Periodic sweep of stale buckets so idle IPs don't accumulate.
  const sweep = () => {
    const cutoff = Date.now() - windowMs;
    for (const [id, arr] of buckets) {
      while (arr.length && arr[0] <= cutoff) arr.shift();
      if (arr.length === 0) buckets.delete(id);
    }
  };
  const timer = setInterval(sweep, Math.max(windowMs, 60000));
  if (timer.unref) timer.unref();

  return {
    check(id) {
      const now = Date.now();
      const cutoff = now - windowMs;
      let arr = buckets.get(id);
      if (!arr) { arr = []; buckets.set(id, arr); }
      while (arr.length && arr[0] <= cutoff) arr.shift();
      if (arr.length >= max) {
        const retryMs = arr[0] + windowMs - now;
        return { allowed: false, retryAfter: Math.max(1, Math.ceil(retryMs / 1000)) };
      }
      arr.push(now);
      return { allowed: true, retryAfter: 0 };
    },
    // for tests / introspection
    _buckets: buckets,
  };
}

module.exports = { createLimiter };
