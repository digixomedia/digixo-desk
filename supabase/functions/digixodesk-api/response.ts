// Consistent JSON response helpers for the DigiXO Desk API.
// Never includes raw keys, hashes, SQL errors, or stack traces in error bodies.

export interface SuccessResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    request_id: string;
  };
}

export function success<T>(data: T, meta?: Record<string, unknown>): { body: SuccessResponse<T>; status: number } {
  return { body: { success: true, data, ...(meta ? { meta } : {}) }, status: 200 };
}

export function errorResponse(code: string, message: string, requestId: string, status: number): { body: ErrorResponse; status: number } {
  return {
    body: {
      success: false,
      error: { code, message, request_id: requestId },
    },
    status,
  };
}

export function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
