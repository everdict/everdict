// Everdict domain errors — a TS reinterpretation of the AppException/ErrorType idiom.
// Key: HTTP status is not stored on ErrorCode(enum); it derives from the error "subtype".

export const ErrorCode = {
  // generic
  BAD_REQUEST: "The request is invalid.",
  NOT_FOUND: "The requested resource was not found.",
  CONFLICT: "Conflicts with the current state.",
  CANCELLED: "The work was cancelled before it ran.",
  // driver / compute
  DRIVER_PROVISION_FAILED: "Failed to provision the sandbox.",
  COMPUTE_EXEC_FAILED: "Failed to execute the sandbox command.",
  // harness
  HARNESS_INSTALL_FAILED: "Failed to install the harness.",
  HARNESS_RUN_FAILED: "Failed to run the harness.",
  // grader
  GRADER_FAILED: "Grading failed.",
  // trace collection (post-release platform pull)
  TRACE_COLLECT_FAILED: "Failed to collect the trace.",
  // upstream — remap external dependency failures to our errors (so monitoring blames us)
  UPSTREAM_MISCONFIGURED: "The external service is misconfigured.",
  UPSTREAM_ERROR: "The external service returned an error.",
  RATE_LIMITED: "Too many requests.",
  BUDGET_EXCEEDED: "The tenant budget has been exceeded.",
  // auth
  UNAUTHENTICATED: "Authentication is required.",
  FORBIDDEN: "You do not have permission.",
} as const;

export type ErrorCode = keyof typeof ErrorCode;

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  data?: Record<string, unknown>;
}

export abstract class AppError extends Error {
  abstract readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly extra?: Record<string, unknown>,
    message?: string,
  ) {
    super(message ?? ErrorCode[code]);
    this.name = new.target.name;
  }

  toEnvelope(): ErrorEnvelope {
    return { code: this.code, message: this.message, data: this.extra };
  }
}

export class BadRequestError extends AppError {
  readonly status = 400;
}
export class NotFoundError extends AppError {
  readonly status = 404;
}
export class ConflictError extends AppError {
  readonly status = 409;
}
export class UnauthenticatedError extends AppError {
  readonly status = 401;
}
export class ForbiddenError extends AppError {
  readonly status = 403;
}
export class RateLimitError extends AppError {
  readonly status = 429;
}
export class PaymentRequiredError extends AppError {
  readonly status = 402;
}
export class UpstreamError extends AppError {
  readonly status = 502;
}
export class InternalError extends AppError {
  readonly status = 500;
}
