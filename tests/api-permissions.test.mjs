import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const edgePath = new URL("../supabase/functions/digixodesk-api/index.ts", import.meta.url);
const migrationPath = new URL("../supabase/migrations/20260905112025_phase1_accuracy_security.sql", import.meta.url);

test("every authenticated Edge route declares a permission decision", async () => {
  const source = await readFile(edgePath, "utf8");
  const routes = source.split("\n").filter((line) => line.includes("requiresAuth: true"));
  assert.ok(routes.length >= 20);
  for (const route of routes) assert.match(route, /requiredPermission: (null|"[a-z]+:(read|write)")/);
  assert.equal(routes.filter((line) => line.includes("requiredPermission: null")).length, 1, "only whoami may authenticate without a resource scope");
  assert.doesNotMatch(source, /permissions:\s*data\.permissions\s*\?\?\s*\["\*"\]/);
});

test("API permission allowlist matches every route scope", async () => {
  const [edge, migration] = await Promise.all([readFile(edgePath, "utf8"), readFile(migrationPath, "utf8")]);
  const scopes = [...edge.matchAll(/requiredPermission: "([a-z]+:(?:read|write))"/g)].map((match) => match[1]);
  for (const scope of new Set(scopes)) assert.match(migration, new RegExp(`'${scope.replace(":", "\\:")}'`));
  assert.match(migration, /permissions SET DEFAULT '\[\]'::jsonb/);
  assert.match(migration, /jsonb_array_length\(v\.permissions\)=0/);
});

test("report API applies inclusive from/to parameters to the financial RPC", async () => {
  const source = await readFile(edgePath, "utf8");
  assert.match(source, /financial_report_summary/);
  assert.match(source, /p_from: fromDate, p_to_exclusive: toExclusive/);
});
