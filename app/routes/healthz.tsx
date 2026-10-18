/**
 * GET /healthz
 *
 * Answers one question: is the thing on the other end of this URL actually the
 * Payram Shopify connector?
 *
 * WHY THIS EXISTS
 * ---------------
 * A merchant points a hostname at this container through their own reverse
 * proxy, and nothing used to confirm that the hostname arrived. On a server that
 * already runs the Payram dashboard, nginx serves any unmatched `Host` from its
 * default server block, so a missing vhost does not fail — it quietly answers
 * with the dashboard instead. Every connector route then returns that app's 404,
 * and the first person to notice is a buyer at checkout.
 *
 * A dead container gives a 502, which is legible. Being handed someone else's
 * 404 is not, so the installer needs a positive signal: this reply, with this
 * `app` marker, can only come from the connector.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No database call, so it still answers the routing question when the database
 * is the thing that is broken, and nothing can make it hang. No version, commit,
 * or shop data: this endpoint is public, and a self-hosted payments component
 * should not fingerprint itself to anyone who asks. The dashboard already shows
 * the running version to the merchant, who is authenticated.
 */
import { json } from "@remix-run/node";

/** Stable marker. The installer greps for this exact string — do not reword. */
export const HEALTH_MARKER = "payram-shopify-connector";

export const loader = () =>
  json(
    { app: HEALTH_MARKER, ok: true },
    // A cached 200 from a proxy would make a broken route look alive.
    { headers: { "Cache-Control": "no-store" } },
  );
