import { defineEventHandler, getRequestURL, proxyRequest } from "h3";

// Same-origin proxy to the NestJS API — issue 0016.
//
// The browser only ever talks to the Nuxt origin: composables call
// `/api/proxy/...` (the runtimeConfig.public.apiBaseUrl default), the
// request lands here, the Nitro server forwards it to the upstream API
// with an `Authorization: Bearer <secret>` header that lives only in
// server-side runtimeConfig. The bearer secret never reaches the client
// bundle.
//
// Streaming is preserved (h3's proxyRequest pipes the upstream response
// body straight to the client), which keeps the NDJSON history export
// working unchanged.

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const upstream = String(config.apiUpstream || "http://localhost:4000");
  const secret = String(config.apiSecret || "");

  const url = getRequestURL(event);
  // /api/proxy[/...path] → strip the prefix to get the upstream path.
  const subpath = url.pathname.replace(/^\/api\/proxy\/?/, "");
  const target = `${upstream.replace(/\/$/, "")}/${subpath}${url.search}`;

  const headers: Record<string, string> = {};
  if (secret.length > 0) {
    headers.Authorization = `Bearer ${secret}`;
  }

  return proxyRequest(event, target, { headers });
});
