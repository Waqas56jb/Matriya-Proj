/**
 * Scope 3 – Observability: in-memory metrics and latency (no dashboard UI).
 * Counts requests by path, errors by path, and latency samples for health/ops.
 */
const MAX_LATENCY_SAMPLES = 200;

const byPath = new Map(); // path -> { requests, errors, latencies: number[] }

function getOrCreate(path) {
  if (!byPath.has(path)) {
    byPath.set(path, { requests: 0, errors: 0, latencies: [] });
  }
  return byPath.get(path);
}

export function recordRequest(path, latencyMs, isError = false) {
  const p = path || '/';
  const rec = getOrCreate(p);
  rec.requests += 1;
  if (isError) rec.errors += 1;
  if (typeof latencyMs === 'number' && latencyMs >= 0) {
    rec.latencies.push(latencyMs);
    if (rec.latencies.length > MAX_LATENCY_SAMPLES) rec.latencies.shift();
  }
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function getMetrics() {
  const routes = {};
  let totalRequests = 0;
  let totalErrors = 0;
  const allLatencies = [];
  for (const [path, rec] of byPath) {
    totalRequests += rec.requests;
    totalErrors += rec.errors;
    rec.latencies.forEach(l => allLatencies.push(l));
    routes[path] = {
      requests: rec.requests,
      errors: rec.errors,
      latency_p50: percentile(rec.latencies, 50),
      latency_p99: percentile(rec.latencies, 99)
    };
  }
  return {
    total_requests: totalRequests,
    total_errors: totalErrors,
    latency_p50: percentile(allLatencies, 50),
    latency_p99: percentile(allLatencies, 99),
    by_path: routes
  };
}

export function metricsMiddleware(req, res, next) {
  const start = Date.now();
  const path = (req.route && req.route.path) ? req.baseUrl + req.route.path : req.path || req.url?.split('?')[0] || '/';
  res.on('finish', () => {
    const latencyMs = Date.now() - start;
    const isError = res.statusCode >= 400;
    recordRequest(path, latencyMs, isError);
  });
  next();
}
