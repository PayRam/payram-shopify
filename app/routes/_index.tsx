import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // Pass along shop/host/session params so authenticate.admin can use them
  const qs = url.searchParams.toString();
  throw redirect(qs ? `/app?${qs}` : "/app");
};
