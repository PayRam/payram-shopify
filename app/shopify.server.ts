import "@shopify/shopify-app-react-router/adapters/node";
import { config as loadDotenv } from "dotenv";
// Ensure .env is loaded regardless of how the process was started
loadDotenv();
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "~/db.server";

/**
 * `SHOP_CUSTOM_DOMAIN` lets the app accept shops served from one extra domain
 * besides *.myshopify.com (for example a Shopify-hosted dev domain).
 *
 * The Remix package took this as `customShopDomains`, which only widened shop
 * validation. @shopify/shopify-api 13 removed that option; its replacement is a
 * domain transformation. An identity transform (`$1.<domain>` back to itself)
 * reproduces the old behaviour: the shop is accepted, not rewritten.
 * `includeHost: false` keeps the `host` parameter check as strict as before —
 * `customShopDomains` never applied to it. One deliberate difference: the
 * domain is now matched literally. customShopDomains spliced it into a regex
 * unescaped, so `shops.example.com` also accepted `acme.shopsXexample.com`.
 */
export function customShopDomainTransformations(domain: string | undefined) {
  const trimmed = domain?.trim();
  if (!trimmed) return [];
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    {
      match: new RegExp(`^([a-zA-Z0-9][a-zA-Z0-9-_]*)\\.${escaped}$`),
      transform: `$1.${trimmed}`,
      includeHost: false,
    },
  ];
}

const domainTransformations = customShopDomainTransformations(
  process.env.SHOP_CUSTOM_DOMAIN,
);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || process.env.APP_URL || process.env.HOST || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  ...(domainTransformations.length ? { domainTransformations } : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
