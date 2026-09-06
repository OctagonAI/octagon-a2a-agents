import { ServerCallContext, type ServerCallContextBuilder } from "@a2a-js/sdk/server";

/** Key under which the caller's Authorization header is carried. */
export const AUTHORIZATION_STATE_KEY = "octagon.authorization";

/**
 * Carry the caller's `Authorization` header through to the executor.
 *
 * The express handler hands the request headers to the context builder, but the
 * default `ServerCallContext` drops them — it keeps only user, tenant, version
 * and extensions. This service forwards the caller's own Octagon credential, so
 * it needs the raw header, and `state` is the sanctioned per-call slot for it.
 * Doing this with a module-level variable would cross-contaminate concurrent
 * requests; the context is per-call, so it cannot.
 */
export const octagonContextBuilder: ServerCallContextBuilder = (options) => {
  const context = new ServerCallContext({
    requestedExtensions: options.extensions,
    user: options.user,
    tenant: options.tenant,
    requestedVersion: options.requestedVersion,
  });
  const header = options.headers?.["authorization"] ?? options.headers?.["Authorization"];
  if (typeof header === "string") context.state.set(AUTHORIZATION_STATE_KEY, header);
  return context;
};
