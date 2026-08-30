// Rate limiting using a durable fixed-window counter stored in the database.
// Edge Function instances share no memory, so all state must be in the database.

import { createClient } from "npm:@supabase/supabase-js@2.112.0";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

function getMinuteWindow(): string {
  return Math.floor(Date.now() / MINUTE_MS).toString();
}

function getMinuteWindowStart(): string {
  return new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS).toISOString();
}

export async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  bucketId: string,
  limit: number
): Promise<RateLimitResult> {
  const windowKey = getMinuteWindow();
  const bucketKey = `${bucketId}:${windowKey}`;
  const windowStart = getMinuteWindowStart();

  // Atomic upsert: increment count, or insert new row
  const { data, error } = await supabase.rpc("increment_rate_limit", {
    p_bucket_key: bucketKey,
    p_window_start: windowStart,
    p_limit: limit,
  });

  if (error || !data) {
    // If the RPC doesn't exist or fails, allow the request (fail-open for availability)
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }

  const count = (data as { count: number }).count;
  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);
  const retryAfter = allowed ? 0 : 60;

  return { allowed, remaining, retryAfter };
}

// Low-frequency cleanup: runs at most once per hour by checking a timestamp in the database.
// This avoids per-request deletion while keeping the table small.
export async function maybeCleanupRateLimits(
  supabase: ReturnType<typeof createClient>
): Promise<void> {
  // Use a special bucket key to track last cleanup time
  const { data } = await supabase
    .from("api_rate_limits")
    .select("window_start")
    .eq("bucket_key", "__last_cleanup__")
    .maybeSingle();

  const now = Date.now();
  const lastCleanup = data?.window_start ? new Date(data.window_start).getTime() : 0;

  if (now - lastCleanup < HOUR_MS) {
    return; // Not yet time to clean up
  }

  // Update the cleanup marker
  await supabase
    .from("api_rate_limits")
    .upsert({
      bucket_key: "__last_cleanup__",
      window_start: new Date(now).toISOString(),
      count: 0,
      limit_value: 0,
    });

  // Run cleanup
  await supabase.rpc("cleanup_rate_limits");
}
