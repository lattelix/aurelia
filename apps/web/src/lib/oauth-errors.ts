import * as oidc from "openid-client";

const diagnosticCodes = new Set([
  "OAUTH_TIMEOUT", "OAUTH_ABORT", "OAUTH_DECRYPTION_FAILED",
  "OAUTH_WWW_AUTHENTICATE_CHALLENGE", "OAUTH_RESPONSE_BODY_ERROR",
  "OAUTH_UNSUPPORTED_OPERATION", "OAUTH_AUTHORIZATION_RESPONSE_ERROR",
  "OAUTH_JWT_USERINFO_EXPECTED", "OAUTH_PARSE_ERROR", "OAUTH_INVALID_RESPONSE",
  "OAUTH_INVALID_REQUEST", "OAUTH_RESPONSE_IS_NOT_JSON", "OAUTH_RESPONSE_IS_NOT_CONFORM",
  "OAUTH_HTTP_REQUEST_FORBIDDEN", "OAUTH_REQUEST_PROTOCOL_FORBIDDEN",
  "OAUTH_JWT_TIMESTAMP_CHECK_FAILED", "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
  "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED", "OAUTH_KEY_SELECTION_FAILED",
  "OAUTH_MISSING_SERVER_METADATA", "OAUTH_INVALID_SERVER_METADATA",
  "ERR_INVALID_ARG_VALUE", "ERR_INVALID_ARG_TYPE",
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_DESTROYED",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const oauthErrors = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "access_denied", "server_error",
  "temporarily_unavailable", "login_required", "interaction_required", "consent_required",
  "account_selection_required", "invalid_token", "insufficient_scope", "use_dpop_nonce",
]);
const diagnosticClaims = new Set(["iss", "aud", "sub", "nonce", "iat", "exp", "nbf", "azp", "auth_time"]);

export interface OAuthErrorDiagnostics {
  type: "oidc-client" | "provider-response" | "authorization-response" | "provider-challenge" | "type-error" | "unknown";
  code?: string;
  causeCodes?: string[];
  oauthError?: string;
  status?: number;
  claim?: string;
  reason?: "missing-claim" | "claim-type" | "signature-verification";
}

/** Only fixed protocol identifiers may reach logs; messages, JWTs and provider bodies never do. */
export function oauthErrorDiagnostics(error: unknown): OAuthErrorDiagnostics {
  const result: OAuthErrorDiagnostics = {
    type: error instanceof oidc.ClientError ? "oidc-client"
      : error instanceof oidc.ResponseBodyError ? "provider-response"
        : error instanceof oidc.AuthorizationResponseError ? "authorization-response"
          : error instanceof oidc.WWWAuthenticateChallengeError ? "provider-challenge"
            : error instanceof TypeError ? "type-error" : "unknown",
  };
  const seen = new Set<unknown>();
  const causeCodes = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current);
    const details = current as Record<string, unknown>;
    if (typeof details.code === "string" && diagnosticCodes.has(details.code)) {
      if (depth === 0) result.code = details.code;
      else if (details.code !== result.code) causeCodes.add(details.code);
    }
    if (!result.oauthError && typeof details.error === "string" && oauthErrors.has(details.error))
      result.oauthError = details.error;
    // Telegram can return HTTP200 with an OAuth error body. oauth4webapi then
    // rejects a missing access_token and retains that body only in its cause.
    // Read only the finite protocol error identifier; never serialize the body.
    if (!result.oauthError && details.body && typeof details.body === "object") {
      const bodyError = (details.body as Record<string, unknown>).error;
      if (typeof bodyError === "string" && oauthErrors.has(bodyError)) result.oauthError = bodyError;
    }
    if (!result.claim && typeof details.claim === "string" && diagnosticClaims.has(details.claim))
      result.claim = details.claim;
    // Match only library-generated templates and emit fixed categories, never their messages.
    if (!result.reason && typeof details.message === "string") {
      const missing = /^JWT "([a-z_]+)" \([a-z ]+\) claim missing$/.exec(details.message);
      const wrongType = /^unexpected JWT "([a-z_]+)" \([a-z ]+\) claim type$/.exec(details.message);
      const claim = missing?.[1] ?? wrongType?.[1];
      if (claim && diagnosticClaims.has(claim)) {
        result.claim ??= claim;
        result.reason = missing ? "missing-claim" : "claim-type";
      } else if (details.message === "JWT signature verification failed") {
        result.reason = "signature-verification";
      }
    }
    const status = current instanceof Response ? current.status
      : details.response instanceof Response ? details.response.status : details.status;
    if (!result.status && typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
      result.status = status;
    current = details.cause;
  }
  if (causeCodes.size) result.causeCodes = [...causeCodes];
  return result;
}
