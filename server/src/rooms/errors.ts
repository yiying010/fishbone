export class RoomCodeError extends Error {}

/**
 * The room code is well formed but no such room exists. Distinct from
 * RoomCodeError because the client has to react differently: a malformed code
 * is worth reporting to the student, a missing room means the room was deleted
 * or has passed its retention period and this client must stop syncing.
 */
export class RoomNotFoundError extends Error {}

/**
 * A join asked for a member id that another browser session already holds, and
 * could not present that session's token. The member id travels in the shared
 * snapshot, so it identifies a collaborator but cannot authorise acting as one.
 */
export class MemberIdentityError extends Error {}
