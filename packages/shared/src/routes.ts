/**
 * Node ⇄ server HTTP API. All requests: JSON, `Authorization: Bearer <node token>`.
 * Responses: 2xx JSON, or `{ error: string }` with 4xx/5xx. 401 = token revoked → stop and say so.
 *
 *   POST {NODE.heartbeat}                 NodeHeartbeat        → NodeHeartbeatResponse   (every heartbeatIntervalSec; registers the node on first call)
 *   POST {NODE.usage}                     UsageReport          → { accepted: number }
 *   POST {NODE.claim}                     ClaimRequest         → ClaimResponse           (empty turns = nothing to do)
 *   POST {NODE.lease(jobId)}              LeaseRenewRequest    → LeaseRenewResponse      (every ~1/3 of lease; 409 = lease lost → stop worker)
 *   POST {NODE.events(jobId)}             JobEventsRequest     → { lastSeq: number }     (idempotent by seq; 409 = lease lost)
 *   POST {NODE.external}                  ExternalWorkReport   → { accepted: number }
 */
export const NODE = {
  heartbeat: "/api/node/heartbeat",
  usage: "/api/node/usage",
  claim: "/api/node/jobs/claim",
  lease: (jobId: string) => `/api/node/jobs/${jobId}/lease`,
  events: (jobId: string) => `/api/node/jobs/${jobId}/events`,
  external: "/api/node/external",
} as const;

export const LEASE_SECONDS = 120;
export const DEFAULT_USAGE_INTERVAL_SEC = 300;
export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 30;
