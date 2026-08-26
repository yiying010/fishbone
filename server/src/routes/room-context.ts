import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.ts";
import { withoutNul } from "../domain/snapshot.ts";
import type { RateLimiter } from "../rate-limit.ts";
import { normalizeRoomCode } from "../rooms/codes.ts";
import type { RoomNotifier } from "../rooms/notifier.ts";
import { RoomCodeError } from "../rooms/errors.ts";
import type { AuthenticatedMember, RoomStore } from "../rooms/store.ts";
import type { AiReviewService } from "../ai/review.ts";

export interface Limiters {
  /** Everything under /api, per client address. Generous; only bounds a single source. */
  requests: RateLimiter | null;
  /** Failed room lookups, per client address. This is the one that stops enumeration. */
  lookupFailures: RateLimiter | null;
  /** Room creation, per client address. */
  roomCreates: RateLimiter | null;
}

export interface RoomRouteDeps {
  config: AppConfig;
  store: RoomStore;
  notifier: RoomNotifier;
  limiters: Limiters;
  /** Null when AI_ENABLED is false or no credential is configured; the route registers but always answers 503. */
  aiService: AiReviewService | null;
}

export const ROOM_NOT_FOUND = Object.freeze({ error: "room_not_found" });

const MAX_DISPLAY_NAME = 64;

export function requestBody(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RoomCodeError("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function roomStep(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.min(19, Math.max(0, parsed)) : 0;
}

export function displayName(value: unknown): string {
  return typeof value === "string" ? withoutNul(value).trim().slice(0, MAX_DISPLAY_NAME) : "";
}

export function bearerToken(request: FastifyRequest): string {
  const header = request.headers["authorization"];
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function rateLimited(reply: FastifyReply, retryAfterSeconds: number): object {
  reply.code(429).header("retry-after", String(retryAfterSeconds)).header("cache-control", "no-store");
  return { error: "rate_limited", retryAfterSeconds };
}

/**
 * Applies the common request and failed-lookup budgets before a database read.
 * Valid sessions are not blocked by another student behind the same NAT.
 */
export function gateRoomRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  limiters: Limiters,
): object | null {
  const overall = limiters.requests?.take(request.ip);
  if (overall && !overall.allowed) return rateLimited(reply, overall.retryAfterSeconds);
  if (bearerToken(request) === "") {
    const failures = limiters.lookupFailures?.peek(request.ip);
    if (failures && !failures.allowed) return rateLimited(reply, failures.retryAfterSeconds);
  }
  return null;
}

/** The deliberately indistinguishable response for a missing room or invalid session. */
export function roomNotFound(request: FastifyRequest, reply: FastifyReply, limiters: Limiters): object {
  const spent = limiters.lookupFailures?.take(request.ip);
  if (spent && !spent.allowed) return rateLimited(reply, spent.retryAfterSeconds);
  reply.code(404).header("cache-control", "no-store");
  return ROOM_NOT_FOUND;
}

/**
 * Resolves the room code and the caller's session together, because every
 * failure among them has to look the same from outside.
 */
export async function authenticateRoom(
  request: FastifyRequest,
  deps: RoomRouteDeps,
): Promise<{ roomCode: string; member: AuthenticatedMember } | null> {
  const roomCode = normalizeRoomCode((request.params as { code?: string }).code);
  const member = await deps.store.authenticate(roomCode, bearerToken(request), deps.config.sessionTtlHours);
  return member === null ? null : { roomCode, member };
}
