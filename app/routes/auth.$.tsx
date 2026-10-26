import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect("/app");
};

// Every route that calls authenticate.admin must pass Shopify's response
// headers through: with single fetch, a route without a headers export drops
// the headers the auth helpers set on thrown responses.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
