import type { z } from "zod";
import { SourceError } from "./types";

/** Largest answer read from a source. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const USER_AGENT = "Meldgrove-Connector";

/**
 * A JSON request to a source's API with a bearer token. Errors become
 * `SourceError` with a short message (never the token or the body).
 * Redirects are not followed: a moved app is a configuration error.
 */
export async function sourceRequest<T extends z.ZodType>(
  url: string,
  options: {
    token: string | null;
    signal: AbortSignal;
    schema: T;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    /** What to call the app in messages, e.g. "Handbook". */
    app: string;
  },
): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw new SourceError(`${options.app} did not answer in time`);
    throw new SourceError(
      `Could not reach ${options.app} at ${new URL(url).origin}: ${fetchErrorCode(error)}`,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new SourceError(`${options.app} redirected the request; check the address`, response.status);
  }
  const text = await readLimited(response, options.app);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (response.ok)
      throw new SourceError(`${options.app} did not answer with JSON; check the address`, response.status);
  }
  if (!response.ok) {
    const message = errorMessage(data);
    if (response.status === 401) {
      throw new SourceError(`${options.app} refused the credentials${message ? `: ${message}` : ""}`, 401);
    }
    if (response.status === 403) {
      throw new SourceError(`${options.app} does not allow this${message ? `: ${message}` : ""}`, 403);
    }
    if (response.status === 404) throw new SourceError(`${options.app} has no such item`, 404);
    throw new SourceError(
      `${options.app} answered HTTP ${response.status}${message ? `: ${message}` : ""}`,
      response.status,
    );
  }
  const parsed = options.schema.safeParse(data);
  if (!parsed.success) throw new SourceError(`${options.app} sent an answer Connector does not understand`);
  return parsed.data;
}

async function readLimited(response: Response, app: string): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) throw new SourceError(`${app} sent too much data`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new SourceError(`${app} sent too much data`);
  return new TextDecoder().decode(buffer);
}

/**
 * Why a request failed, as a code (ECONNREFUSED, ENOTFOUND, …): never the
 * error's message, which can quote request headers.
 */
export function fetchErrorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : "connection failed";
}

/** The `{ error: { message } }` of a Meldgrove app, shortened. */
function errorMessage(data: unknown): string | null {
  const error = (data as { error?: unknown } | null)?.error;
  const message =
    typeof error === "object" && error !== null ? (error as { message?: unknown }).message : undefined;
  return typeof message === "string" ? message.slice(0, 200) : null;
}
