import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // Pass along shop/host/session params so authenticate.admin can use them
  const qs = url.searchParams.toString();
  throw redirect(qs ? `/app?${qs}` : "/app");
};
