import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

// How long a streamed response may wait on pending loader promises before
// React Router rejects them. Replaces Remix's `abortDelay` prop on RemixServer.
export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  // Bypass ngrok browser-warning interstitial for all responses (harmless on production)
  responseHeaders.set("ngrok-skip-browser-warning", "1");
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
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
      }
    );
    // Abort the render one second after streamTimeout, so React has time to
    // flush the rejected boundaries down before the stream is cut.
    setTimeout(abort, streamTimeout + 1_000);
  });
}

export function handleDataRequest(response: Response) {
  response.headers.set("ngrok-skip-browser-warning", "1");
  return response;
}
