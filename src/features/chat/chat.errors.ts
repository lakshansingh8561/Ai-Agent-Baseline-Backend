export class ChatError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ChatError";
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ChatLockConflictError extends ChatError {
  constructor(message = "A generation is already in progress for this conversation") {
    super(message, 409);
    this.name = "ChatLockConflictError";
  }
}

export class ConversationLockLostError extends ChatError {
  constructor(message = "Conversation lock was lost or stolen by a newer request") {
    super(message, 409);
    this.name = "ConversationLockLostError";
  }
}

export class IdempotencyConflictError extends ChatError {
  constructor(message = "An operation is already in progress for this idempotency key") {
    super(message, 409);
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyPayloadMismatchError extends ChatError {
  constructor(message = "Idempotency key reused with different request payload") {
    super(message, 422);
    this.name = "IdempotencyPayloadMismatchError";
  }
}

export class IdempotencyUnresolvedRecoveryError extends ChatError {
  constructor(message = "Idempotency operation with unresolved reservation is pending recovery") {
    super(message, 409);
    this.name = "IdempotencyUnresolvedRecoveryError";
  }
}
