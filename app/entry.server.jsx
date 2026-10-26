import { PassThrough } from "stream";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { safeErrorSummary } from "./utils/storefront-auth.server";
import { traceAppRequest } from "./utils/nav-trace.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          traceAppRequest(request, { status: responseStatusCode, headers: responseHeaders }); // TEMPORARY, see utils/nav-trace.server.js
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}

// TEMPORARY diagnostics (remove after the live 500 is explained): logs every
// unhandled server error with route path only (no query string), a sanitised
// message and the top stack frames, to the console and a temp file.
export function handleError(error, { request }) {
  if (request.signal?.aborted) return;
  const frames = String(error?.stack ?? "").split("\n").slice(1, 5).map((l) => l.trim());
  const line = JSON.stringify({
    at: new Date().toISOString(),
    method: request.method,
    path: new URL(request.url).pathname,
    ...safeErrorSummary(error),
    frames,
  });
  console.error("[server-error]", line);
  try {
    appendFileSync(join(tmpdir(), "kw-error.log"), `${line}\n`);
  } catch {
    /* diagnostics only */
  }
}

// TEMPORARY diagnostics (see utils/nav-trace.server.js): every client-side route-data request (/app/....data) is traced with
// what it carried and how it was answered. The response is returned untouched.
export function handleDataRequest(response, { request }) {
  traceAppRequest(request, response);
  return response;
}
