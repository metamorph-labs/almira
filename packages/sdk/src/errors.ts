import type { UuidV7 } from "./types.js";

export class AlmiraApiError extends Error {
  readonly code: string;
  readonly requestId: UuidV7;
  readonly retryAfterMilliseconds: number | null;
  readonly status: number;

  constructor(
    code: string,
    requestId: UuidV7,
    status: number,
    retryAfterMilliseconds: number | null,
  ) {
    super(code);
    this.name = "AlmiraApiError";
    this.code = code;
    this.requestId = requestId;
    this.status = status;
    this.retryAfterMilliseconds = retryAfterMilliseconds;
  }
}

export class AlmiraClientError extends Error {
  readonly code:
    | "ALMIRA_CLIENT_ABORTED"
    | "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE"
    | "ALMIRA_CLIENT_INPUT_INVALID"
    | "ALMIRA_CLIENT_NETWORK"
    | "ALMIRA_CLIENT_RESPONSE_INVALID";

  constructor(code: AlmiraClientError["code"]) {
    super(code);
    this.name = "AlmiraClientError";
    this.code = code;
  }
}
