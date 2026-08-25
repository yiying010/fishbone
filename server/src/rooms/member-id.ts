import { RoomCodeError } from "./errors.ts";

export function normalizeMemberId(input: unknown): string {
  if (typeof input !== "string") throw new RoomCodeError("memberId must be a string");
  const id = input.trim();
  if (id === "") throw new RoomCodeError("memberId must not be empty");
  if (id.length > 128) throw new RoomCodeError("memberId must be at most 128 characters");
  return id;
}
