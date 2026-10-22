import { forwardRef } from "react";
import type {
  HeadersFunction,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import type {
  LinkLikeComponent,
  LinkLikeComponentProps,
} from "@shopify/polaris/build/ts/src/utilities/link";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "~/shopify.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY ?? "" };
};

/** Polaris React renders its links through React Router, as the Remix package did. */
const PolarisLink = forwardRef<HTMLAnchorElement, LinkLikeComponentProps>(
  function PolarisLink({ url, ...rest }, ref) {
    return <Link {...rest} to={url} ref={ref} />;
  },
) as LinkLikeComponent;

/**
 * Two providers, because the admin UI is still Polaris React.
 *
 * The React Router package's AppProvider only loads App Bridge (and the Polaris
 * web components script). Unlike the Remix one it no longer sets up Polaris
 * React, so Polaris's own AppProvider goes inside it — exactly what the Remix
 * AppProvider rendered, with the same English translations and link component.
 * https://github.com/Shopify/shopify-app-template-react-router/wiki/Using-both-Polaris-web-components--Polaris-React
 */
export default function AdminLayout() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider apiKey={apiKey}>
      <PolarisAppProvider i18n={polarisTranslations} linkComponent={PolarisLink}>
        <Outlet />
      </PolarisAppProvider>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
