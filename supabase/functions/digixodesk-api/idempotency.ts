// Idempotency-Key header validation helper.
// Only validates the header format — the database owns request hashing.
// Returns the raw key string or null if missing/invalid.

export function extractIdempotencyKey(req: Request): string | null {
  const key = req.headers.get("Idempotency-Key");
  if (!key || key.trim() === "") return null;
  if (key.length > 200) return null;
  return key.trim();
}
