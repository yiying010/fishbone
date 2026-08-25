export class RoomCodeError extends Error {}

/** A well-formed code that does not resolve to a live room. */
export class RoomNotFoundError extends Error {}
