export class ApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Server request failed");
    this.status = status;
  }
}

export function nodeApi(serverUrl: string, token: string, transport: typeof fetch,
  signal: AbortSignal, revoked: () => void) {
  const base = new URL(serverUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("Enter an HTTP or HTTPS server URL without credentials.");
  }
  return async function post(path: string, payload: unknown, localSignal?: AbortSignal): Promise<unknown> {
    const abort = AbortSignal.any([signal, AbortSignal.timeout(10_000), ...(localSignal ? [localSignal] : [])]);
    const response = await transport(new URL(path, base), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: abort, redirect: "error",
    });
    if (response.status === 401) revoked();
    if (!response.ok) throw new ApiError(response.status);
    return response.json();
  };
}

export type Post = ReturnType<typeof nodeApi>;
