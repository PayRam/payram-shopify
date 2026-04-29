import type { LoaderFunctionArgs } from "@remix-run/node";
import { login } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return login(request);
};
