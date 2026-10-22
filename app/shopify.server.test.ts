/**
 * Shopify app configuration tests.
 *
 * The property protected here: `SHOP_CUSTOM_DOMAIN` must accept and reject the
 * same shops it did before the move off the Remix package. That package took it
 * as `customShopDomains`, which @shopify/shopify-api 13 removed; it is now an
 * identity domain transformation. The checks run through the real shopify-api
 * validators, so a transformation that silently stopped matching — or started
 * rewriting shops — fails here rather than at a merchant's login.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { ApiVersion, shopifyApi } from "@shopify/shopify-api";

vi.hoisted(() => {
  // shopify.server.ts configures the app at import time.
  process.env.SHOPIFY_API_KEY = "test-client-id";
  process.env.SHOPIFY_API_SECRET = "test-client-secret";
  process.env.SHOPIFY_APP_URL = "https://connector.example.test";
  process.env.SCOPES = "read_orders,write_orders";
});

vi.mock("~/db.server", () => ({
  // PrismaSessionStorage polls for its table on construction.
  default: { session: { count: async () => 0 } },
}));

let customShopDomainTransformations: typeof import("./shopify.server").customShopDomainTransformations;
let apiVersion: typeof import("./shopify.server").apiVersion;

beforeAll(async () => {
  ({ customShopDomainTransformations, apiVersion } = await import("./shopify.server"));
});

describe("Admin API version", () => {
  it("is 2026-10, the latest stable version (supported until 2027-10-16)", () => {
    // Bumping this is a deliberate act: check the release notes for every call
    // in utils/shopify-admin.server.ts first, then change this test with it.
    expect(apiVersion).toBe("2026-10");
  });
});

function validatorsFor(domain: string | undefined) {
  const transformations = customShopDomainTransformations(domain);
  const api = shopifyApi({
    apiKey: "test-client-id",
    apiSecretKey: "test-client-secret",
    hostName: "connector.example.test",
    apiVersion: ApiVersion.October26,
    isEmbeddedApp: true,
    ...(transformations.length ? { domainTransformations: transformations } : {}),
    logger: { level: 0 },
  });
  return api.utils;
}

const encodeHost = (host: string) => Buffer.from(host).toString("base64").replace(/=+$/, "");

describe("SHOP_CUSTOM_DOMAIN", () => {
  it("adds nothing when unset or blank", () => {
    expect(customShopDomainTransformations(undefined)).toEqual([]);
    expect(customShopDomainTransformations("   ")).toEqual([]);
  });

  it("keeps accepting ordinary myshopify.com shops", () => {
    const utils = validatorsFor("shops.example.com");
    expect(utils.sanitizeShop("acme.myshopify.com")).toBe("acme.myshopify.com");
  });

  it("accepts shops on the custom domain without rewriting them", () => {
    const utils = validatorsFor("shops.example.com");
    expect(utils.sanitizeShop("acme.shops.example.com")).toBe("acme.shops.example.com");
  });

  it("rejects look-alike domains", () => {
    const utils = validatorsFor("shops.example.com");
    // Deliberately stricter than before: customShopDomains spliced the domain
    // into a regex unescaped, so its dots matched any character and this shop
    // was accepted. A domain setting should mean that domain.
    expect(utils.sanitizeShop("acme.shopsXexample.com")).toBeNull();
    expect(utils.sanitizeShop("acme.shops.example.com.evil.test")).toBeNull();
    expect(utils.sanitizeShop("acme.evil.test")).toBeNull();
  });

  it("rejects custom-domain shops when the variable is unset", () => {
    const utils = validatorsFor(undefined);
    expect(utils.sanitizeShop("acme.shops.example.com")).toBeNull();
  });

  it("does not widen the host check, which customShopDomains never covered", () => {
    const utils = validatorsFor("shops.example.com");
    expect(utils.sanitizeHost(encodeHost("admin.shopify.com/store/acme"))).not.toBeNull();
    expect(utils.sanitizeHost(encodeHost("acme.shops.example.com/admin"))).toBeNull();
  });
});
