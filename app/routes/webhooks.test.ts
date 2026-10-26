/**
 * Shopify webhook handler tests.
 *
 * The case worth protecting is APP_SCOPES_UPDATE. Under token exchange it is
 * the only thing that refreshes the stored scope, and the settings page reads
 * that scope to decide whether overpayment gift cards can be issued. A stale
 * scope means a merchant who granted write_gift_cards is still told they have
 * not.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { prisma, webhook } = vi.hoisted(() => ({
  prisma: {
    session: { deleteMany: vi.fn(), update: vi.fn() },
    paymentMapping: { deleteMany: vi.fn() },
    merchantConfig: { deleteMany: vi.fn() },
  },
  webhook: vi.fn(),
}));

vi.mock("~/db.server", () => ({ default: prisma }));
vi.mock("~/shopify.server", () => ({ authenticate: { webhook } }));

import { action } from "./webhooks";

const shop = "acme.myshopify.com";
const offlineSession = { id: `offline_${shop}`, shop, isOnline: false };

async function deliver() {
  try {
    await action({
      request: new Request("https://connector.example.test/webhooks", { method: "POST" }),
      params: {},
      context: {},
    } as Parameters<typeof action>[0]);
  } catch (thrown) {
    // The route answers by throwing a Response, as it always has.
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error("webhook action returned instead of answering");
}

beforeEach(() => vi.clearAllMocks());

describe("APP_SCOPES_UPDATE", () => {
  it("stores the scopes the merchant granted on the offline session", async () => {
    webhook.mockResolvedValue({
      topic: "APP_SCOPES_UPDATE",
      shop,
      session: offlineSession,
      payload: {
        previous: ["read_orders", "write_orders"],
        current: ["read_orders", "write_orders", "write_gift_cards"],
      },
    });

    const res = await deliver();

    expect(res.status).toBe(200);
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: offlineSession.id },
      data: { scope: "read_orders,write_orders,write_gift_cards" },
    });
  });

  it("does nothing when the app has no session for the shop (already uninstalled)", async () => {
    webhook.mockResolvedValue({
      topic: "APP_SCOPES_UPDATE",
      shop,
      session: undefined,
      payload: { current: ["read_orders"] },
    });

    const res = await deliver();

    expect(res.status).toBe(200);
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it("ignores a payload without a scope list rather than blanking the scope", async () => {
    webhook.mockResolvedValue({
      topic: "APP_SCOPES_UPDATE",
      shop,
      session: offlineSession,
      payload: {},
    });

    const res = await deliver();

    expect(res.status).toBe(200);
    expect(prisma.session.update).not.toHaveBeenCalled();
  });
});

describe("APP_UNINSTALLED", () => {
  it("still deletes the shop's sessions", async () => {
    webhook.mockResolvedValue({ topic: "APP_UNINSTALLED", shop, session: offlineSession, payload: {} });

    const res = await deliver();

    expect(res.status).toBe(200);
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { shop } });
  });
});

describe("unknown topics", () => {
  it("answers 404", async () => {
    webhook.mockResolvedValue({ topic: "ORDERS_CREATE", shop, session: offlineSession, payload: {} });

    const res = await deliver();

    expect(res.status).toBe(404);
  });
});
