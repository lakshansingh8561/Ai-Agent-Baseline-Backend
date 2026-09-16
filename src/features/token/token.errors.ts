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

export class TokenInvariantViolationError extends TokenError {
  constructor(message: string = "Token accounting invariant violation") {
    super(message, 500);
    this.name = "TokenInvariantViolationError";
  }
}
