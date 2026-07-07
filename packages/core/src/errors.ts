// Everdict 도메인 에러 — AppException/ErrorType 이디엄의 TS 재해석.
// 핵심: HTTP 상태는 ErrorCode(enum)에 넣지 않고, 에러 "서브타입"에서 파생한다.

export const ErrorCode = {
  // generic
  BAD_REQUEST: "요청이 올바르지 않습니다.",
  NOT_FOUND: "대상을 찾을 수 없습니다.",
  CONFLICT: "현재 상태와 충돌합니다.",
  // driver / compute
  DRIVER_PROVISION_FAILED: "샌드박스 프로비저닝에 실패했습니다.",
  COMPUTE_EXEC_FAILED: "샌드박스 명령 실행에 실패했습니다.",
  // harness
  HARNESS_INSTALL_FAILED: "하니스 설치에 실패했습니다.",
  HARNESS_RUN_FAILED: "하니스 실행에 실패했습니다.",
  // grader
  GRADER_FAILED: "채점에 실패했습니다.",
  // upstream — 외부 의존성 실패는 우리 에러로 remap (모니터링이 우리를 탓하게)
  UPSTREAM_MISCONFIGURED: "외부 서비스 설정 오류입니다.",
  UPSTREAM_ERROR: "외부 서비스 오류입니다.",
  RATE_LIMITED: "요청이 너무 많습니다.",
  BUDGET_EXCEEDED: "테넌트 예산을 초과했습니다.",
  // auth
  UNAUTHENTICATED: "인증이 필요합니다.",
  FORBIDDEN: "권한이 없습니다.",
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
