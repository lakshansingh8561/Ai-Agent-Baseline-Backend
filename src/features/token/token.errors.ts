export class TokenError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = "TokenError";
    this.statusCode = statusCode;
  }
}

export class InsufficientTokensError extends TokenError {
  constructor(message: string = "Token balance exhausted") {
    super(message, 402);
    this.name = "InsufficientTokensError";
  }
}

export class TokenWalletNotFoundError extends TokenError {
  constructor(message: string = "Token wallet not found") {
    super(message, 404);
    this.name = "TokenWalletNotFoundError";
  }
}

export class TokenWalletCorruptedError extends TokenError {
  constructor(
    message: string = "Token wallet is temporarily unavailable due to state verification failure. Please contact support."
  ) {
    super(message, 503);
    this.name = "TokenWalletCorruptedError";
  }
}

export class TokenInvariantViolationError extends TokenError {
  constructor(message: string = "Token accounting invariant violation") {
    super(message, 500);
    this.name = "TokenInvariantViolationError";
  }
}

export class ReservationStateConflictError extends TokenError {
  constructor(message: string = "Token reservation state or version conflict") {
    super(message, 409);
    this.name = "ReservationStateConflictError";
  }
}

export class InvalidUsageMetadataError extends TokenError {
  constructor(message: string = "Invalid or corrupted usage metadata") {
    super(message, 422);
    this.name = "InvalidUsageMetadataError";
  }
}

export class UncertainTransactionCommitError extends TokenError {
  constructor(message: string = "Transaction commit outcome is unknown") {
    super(message, 500);
    this.name = "UncertainTransactionCommitError";
  }
}
