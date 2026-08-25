/**
 * Environment parsing. Every variable is resolved once at startup and any
 * problem aborts the process: a room server that boots with a half-valid
 * configuration is worse than one that refuses to start.
 *
 * See docs/deployment.md for the documented list.
 */

import { DEFAULT_CODE_LENGTH, MAX_CODE_LENGTH, MIN_CODE_LENGTH } from "./rooms/codes.ts";

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  dbPoolMax: number;
  dbConnectTimeoutMs: number;
  migrateOnStart: boolean;
  /**
   * Hard-required. Student submissions are personal data, so the operator has
   * to state the retention period explicitly rather than inherit a number
   * nobody chose.
   */
  dataRetentionDays: number;
  retentionSweepIntervalMinutes: number;
  /**
   * A sweep deleting more than this share of all rooms, and at least
   * `retentionBulkDeleteMinimum` of them, refuses to run. Guards against a
   * mistyped retention period wiping years of rooms seconds after a restart.
   */
  retentionBulkDeleteFraction: number;
  retentionBulkDeleteMinimum: number;
  retentionConfirmBulkDelete: boolean;
  longPollMs: number;
  maxSnapshotBytes: number;
  bodyLimitBytes: number;
  /** Length of newly generated codes. Existing shorter codes still resolve. */
  roomCodeLength: number;
  /** How long a member's session token stays valid, refreshed on every request. */
  sessionTtlHours: number;
  rateLimitEnabled: boolean;
  /**
   * Failed room lookups per address per minute. This is the budget that stops
   * code enumeration, so it is deliberately far tighter than the overall
   * request limit; ordinary use spends it only on typos.
   */
  rateLimitLookupFailuresPerMinute: number;
  rateLimitRoomCreatesPerHour: number;
  /**
   * Everything under /api per address per minute. A whole class shares one
   * school NAT address, so this has to stay generous: it exists to bound a
   * single source, not to shape normal traffic.
   */
  rateLimitRequestsPerMinute: number;
  maxArtifactBytes: number;
  trustProxy: boolean;
  /** When null the admin export/delete routes are not registered at all. */
  adminToken: string | null;
  publicDir: string;
}

class ConfigError extends Error {}

function raw(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requiredString(name: string): string {
  const value = raw(name);
  if (value === undefined) throw new ConfigError(`${name} is required but not set`);
  return value;
}

function integer(name: string, value: string, min: number, max: number): number {
  if (!/^-?\d+$/.test(value)) throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(value)}`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function requiredInteger(name: string, min: number, max: number): number {
  return integer(name, requiredString(name), min, max);
}

function optionalInteger(name: string, fallback: number, min: number, max: number): number {
  const value = raw(name);
  return value === undefined ? fallback : integer(name, value, min, max);
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got ${JSON.stringify(value)}`);
}

export function loadConfig(publicDir: string): AppConfig {
  const problems: string[] = [];
  const collect = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      problems.push(error instanceof ConfigError ? error.message : String(error));
      return fallback;
    }
  };

  const config: AppConfig = {
    host: raw("HOST") ?? "0.0.0.0",
    port: collect(() => optionalInteger("PORT", 3000, 1, 65535), 3000),
    logLevel: raw("LOG_LEVEL") ?? "info",
    databaseUrl: collect(() => requiredString("DATABASE_URL"), ""),
    dbPoolMax: collect(() => optionalInteger("DB_POOL_MAX", 10, 1, 200), 10),
    dbConnectTimeoutMs: collect(() => optionalInteger("DB_CONNECT_TIMEOUT_MS", 10_000, 100, 120_000), 10_000),
    migrateOnStart: collect(() => optionalBoolean("MIGRATE_ON_START", true), true),
    // 3650 days = 10 years. Deliberately no default: see the interface comment.
    dataRetentionDays: collect(() => requiredInteger("DATA_RETENTION_DAYS", 1, 36_500), 1),
    retentionSweepIntervalMinutes: collect(
      () => optionalInteger("RETENTION_SWEEP_INTERVAL_MINUTES", 60, 1, 10_080),
      60,
    ),
    // Expressed in percent so the variable takes an integer like every other one.
    retentionBulkDeleteFraction: collect(
      () => optionalInteger("RETENTION_BULK_DELETE_PERCENT", 25, 1, 100) / 100,
      0.25,
    ),
    retentionBulkDeleteMinimum: collect(() => optionalInteger("RETENTION_BULK_DELETE_MINIMUM", 10, 1, 100_000), 10),
    retentionConfirmBulkDelete: collect(() => optionalBoolean("RETENTION_CONFIRM_BULK_DELETE", false), false),
    longPollMs: collect(() => optionalInteger("SYNC_LONG_POLL_MS", 20_000, 0, 120_000), 20_000),
    maxSnapshotBytes: collect(() => optionalInteger("MAX_SNAPSHOT_BYTES", 1_048_576, 1024, 33_554_432), 1_048_576),
    bodyLimitBytes: collect(() => optionalInteger("BODY_LIMIT_BYTES", 4_194_304, 4096, 67_108_864), 4_194_304),
    roomCodeLength: collect(
      () => optionalInteger("ROOM_CODE_LENGTH", DEFAULT_CODE_LENGTH, MIN_CODE_LENGTH, MAX_CODE_LENGTH),
      DEFAULT_CODE_LENGTH,
    ),
    sessionTtlHours: collect(() => optionalInteger("SESSION_TTL_HOURS", 24, 1, 8_760), 24),
    rateLimitEnabled: collect(() => optionalBoolean("RATE_LIMIT_ENABLED", true), true),
    rateLimitLookupFailuresPerMinute: collect(
      () => optionalInteger("RATE_LIMIT_LOOKUP_FAILURES_PER_MINUTE", 60, 1, 100_000),
      60,
    ),
    rateLimitRoomCreatesPerHour: collect(() => optionalInteger("RATE_LIMIT_ROOM_CREATES_PER_HOUR", 60, 1, 100_000), 60),
    rateLimitRequestsPerMinute: collect(
      () => optionalInteger("RATE_LIMIT_REQUESTS_PER_MINUTE", 3_000, 10, 10_000_000),
      3_000,
    ),
    maxArtifactBytes: collect(() => optionalInteger("MAX_ARTIFACT_BYTES", 4_194_304, 1024, 33_554_432), 4_194_304),
    trustProxy: collect(() => optionalBoolean("TRUST_PROXY", true), true),
    adminToken: raw("ADMIN_TOKEN") ?? null,
    publicDir,
  };

  if (config.adminToken !== null && config.adminToken.length < 24) {
    problems.push("ADMIN_TOKEN must be at least 24 characters, or unset to disable the admin routes");
  }

  if (config.bodyLimitBytes < config.maxSnapshotBytes) {
    problems.push("BODY_LIMIT_BYTES must be >= MAX_SNAPSHOT_BYTES, otherwise valid snapshots are rejected by the HTTP layer");
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }

  return config;
}
