import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../supabase/migrations/20260905112025_phase1_accuracy_security.sql", import.meta.url);

function saleFigures({ value, payments = [], cashRefunds = [], adjustments = [], cancelled = false }) {
  const paid = payments.filter((payment) => payment.status === "valid").reduce((sum, payment) => sum + payment.amount, 0);
  const cashRefunded = cashRefunds.reduce((sum, amount) => sum + amount, 0);
  const adjusted = adjustments.reduce((sum, amount) => sum + amount, 0);
  return {
    orderValue: cancelled ? 0 : value,
    collected: paid,
    refunded: cashRefunded,
    outstanding: cancelled ? 0 : Math.max(value - paid - adjusted, 0),
    netCollected: paid - cashRefunded,
  };
}

test("unpaid, partial, full, reversed, refunded, adjusted, and cancelled sales follow policy", () => {
  assert.deepEqual(saleFigures({ value: 1000 }), { orderValue: 1000, collected: 0, refunded: 0, outstanding: 1000, netCollected: 0 });
  assert.equal(saleFigures({ value: 1000, payments: [{ amount: 400, status: "valid" }] }).outstanding, 600);
  assert.equal(saleFigures({ value: 1000, payments: [{ amount: 1000, status: "valid" }] }).outstanding, 0);
  assert.equal(saleFigures({ value: 1000, payments: [{ amount: 1000, status: "reversed" }] }).outstanding, 1000);
  assert.deepEqual(saleFigures({ value: 1000, payments: [{ amount: 1000, status: "valid" }], cashRefunds: [250] }), { orderValue: 1000, collected: 1000, refunded: 250, outstanding: 0, netCollected: 750 });
  assert.equal(saleFigures({ value: 1000, payments: [{ amount: 400, status: "valid" }], adjustments: [100] }).outstanding, 500);
  assert.equal(saleFigures({ value: 1000, payments: [{ amount: 400, status: "valid" }], cancelled: true }).orderValue, 0);
});

test("SQL uses event dates, full histories, archive-preserving policy, and demo exclusion", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /p\.payment_date>=b\.m0/);
  assert.match(sql, /r\.occurred_on>=b\.m0/);
  assert.match(sql, /WHERE p\.sale_id=s\.id AND p\.status='valid'/);
  assert.match(sql, /refund_type='balance_adjustment'/);
  assert.match(sql, /WHERE NOT is_demo AND payment_status<>'cancelled'/);
  assert.doesNotMatch(sql, /booked AS \([^\n]*archived_at IS NULL/);
});

test("renewal completion is locked, linked, and idempotent", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /WHERE id=p_renewal_id FOR UPDATE/);
  assert.match(sql, /linked_new_sale_id IS NOT NULL/);
  assert.match(sql, /current_sale_id=v_sale_id/);
  assert.match(sql, /completion_idempotency_key=p_idempotency_key/);
  assert.match(sql, /renewals_subscription_due_unique/);
  assert.match(sql, /INSERT INTO public\.renewals[\s\S]*ON CONFLICT DO NOTHING/);
});
