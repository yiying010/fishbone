export class RoomCodeError extends Error {}

/**
 * The room code is well formed but no such room exists. Distinct from
 * RoomCodeError because the client has to react differently: a malformed code
 * is worth reporting to the student, a missing room means the room was deleted
 * or has passed its retention period and this client must stop syncing.
 */
export class RoomNotFoundError extends Error {}
