/**
 * Provisions an isolated test database and seeds it before the integration
 * suite runs, so tests exercise the same schema, the same seed data and the
 * same orchestrator the application uses — not a hand-built fixture that
 * could drift from reality.
 *
 * The database is dropped and recreated rather than reset in place: an empty
 * database plus `db push` is the same end state, and it keeps the destructive
 * step confined to a database whose name this file chose.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Vitest does not read .env the way Next.js does, so load it here before
// deriving the test database URL from DATABASE_URL.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Malformed or unreadable — fall through to the default below.
    }
  }
}

const BASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost:5432/sales_engine";
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  BASE_URL.replace(/\/([^/?]+)(\?|$)/, "/sales_engine_test$2");

const TEST_DB_NAME = new URL(TEST_URL).pathname.slice(1);

function sql(adminUrl: string, statement: string, allowFailure = false) {
  try {
    execFileSync("npx", ["prisma", "db", "execute", "--url", adminUrl, "--stdin"], {
      input: statement,
      stdio: ["pipe", "ignore", allowFailure ? "ignore" : "inherit"],
    });
  } catch (error) {
    if (!allowFailure) throw error;
  }
}

/**
 * Guard against two integration runs at once.
 *
 * The suite drops and recreates its database, so a second concurrent run
 * destroys the first one's schema mid-test and both fail in confusing ways.
 * A lock turns that into one clear message instead of two mysteries.
 */
function acquireLock(): () => void {
  const lockPath = join(tmpdir(), `sales-engine-integration-${TEST_DB_NAME}.lock`);
  if (existsSync(lockPath)) {
    const raw = Number(readFileSync(lockPath, "utf8").trim());
    const alive = Number.isFinite(raw) && isRunning(raw);
    if (alive) {
      throw new Error(
        `Another integration test run (pid ${raw}) is already using "${TEST_DB_NAME}". ` +
          `Wait for it to finish, or remove ${lockPath} if that process is gone.`,
      );
    }
    // Stale lock from a killed run.
    rmSync(lockPath, { force: true });
  }
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(lockPath, String(process.pid));
  return () => rmSync(lockPath, { force: true });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export default async function setup() {
  if (!/test/.test(TEST_DB_NAME)) {
    throw new Error(
      `Refusing to run integration tests against "${TEST_DB_NAME}" — the test database name must contain "test".`,
    );
  }

  const releaseLock = acquireLock();
  process.env.DATABASE_URL = TEST_URL;
  const adminUrl = TEST_URL.replace(`/${TEST_DB_NAME}`, "/postgres");

  sql(adminUrl, `DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE);`, true);
  sql(adminUrl, `CREATE DATABASE "${TEST_DB_NAME}";`);

  const env = { ...process.env, DATABASE_URL: TEST_URL };
  execFileSync("npx", ["prisma", "db", "push", "--accept-data-loss", "--skip-generate"], {
    env,
    stdio: "ignore",
  });
  execFileSync("npx", ["tsx", "prisma/seed.ts"], { env, stdio: "ignore" });

  // Vitest calls the returned teardown after the suite finishes.
  return releaseLock;
}
