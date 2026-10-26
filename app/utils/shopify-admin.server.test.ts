/**
 * Admin API request tests.
 *
 * Two regressions locked down here:
 *  - The version in the URL. The app once pinned 2025-01 here while the library
 *    used its own constant; once 2025-01 retired, Shopify silently served these
 *    calls from whichever version was oldest. Every call must use the one
 *    version shopify.server.ts declares.
 *  - The giftCardCreate input. It sent `recipientAttributes.recipient`, a field
 *    GiftCardRecipientInput does not have, so Shopify rejected every gift card
 *    for an order with a customer, and the rejection looked like an ambiguous
 *    failure, so the fallback never ran. It also sent `initialValue`, which
 *    2026-07 deprecated in favour of `initialAmount` (amount + currency).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiVersion } from "@shopify/shopify-api";

vi.mock("~/db.server", () => ({
  default: { paymentMapping: { update: vi.fn() } },
}));
vi.mock("~/shopify.server", async () => ({
  apiVersion: (await import("@shopify/shopify-api")).ApiVersion.October26,
  sessionStorage: { findSessionsByShop: vi.fn() },
}));

import {
  addOrderTags,
  createGiftCard,
  fetchOrderTotal,
  findGiftCardsByNote,
  GiftCardOutcomeUnknownError,
  markOrderPaid,
  tagShopifyOrderPaid,
} from "./shopify-admin.server";

const SHOP = "acme.myshopify.com";
const CUSTOMER = "gid://shopify/Customer/5";

type Sent = { url: string; query: string; variables: Record<string, any> };
let sent: Sent[];
let replies: unknown[];

function reply(data: unknown) {
  replies.push({ data });
}

beforeEach(() => {
  sent = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push({ url, query: body.query, variables: body.variables });
      const next = replies.shift() ?? { data: {} };
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const giftCard = {
  giftCardCreate: {
    giftCard: {
      id: "gid://shopify/GiftCard/9",
      lastCharacters: "4f2a",
      balance: { amount: "5.33", currencyCode: "EUR" },
    },
    userErrors: [],
  },
};

describe("Admin API version", () => {
  it("sends every call to the 2026-10 endpoint", async () => {
    reply({
      order: {
        name: "#1001",
        totalOutstandingSet: { presentmentMoney: { amount: "50.00", currencyCode: "EUR" } },
      },
    });
    await fetchOrderTotal(SHOP, "token", "1001");
    reply({ tagsAdd: { userErrors: [] } });
    await addOrderTags(SHOP, "token", "1001", ["payram_paid"]);
    reply({ tagsAdd: { node: { id: "gid://shopify/Order/1001" }, userErrors: [] } });
    await tagShopifyOrderPaid(SHOP, "token", "1001", "map_1");
    reply({ orderMarkAsPaid: { order: { displayFinancialStatus: "PAID" }, userErrors: [] } });
    await markOrderPaid(SHOP, "token", "1001");
    reply(giftCard);
    await createGiftCard(SHOP, "token", {
      amount: "5.33",
      currencyCode: "EUR",
      customerId: null,
      note: "n",
    });

    expect(sent).toHaveLength(5);
    expect(ApiVersion.October26).toBe("2026-10");
    for (const call of sent) {
      expect(call.url).toBe(`https://${SHOP}/admin/api/2026-10/graphql.json`);
    }
  });
});

describe("createGiftCard", () => {
  it("sends initialAmount with its currency, and the recipient as recipientAttributes.id", async () => {
    reply(giftCard);
    const card = await createGiftCard(SHOP, "token", {
      amount: "5.33",
      currencyCode: "EUR",
      customerId: CUSTOMER,
      note: "Payram overpayment refund",
      message: "Here is the difference.",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].variables.input).toEqual({
      initialAmount: { amount: "5.33", currencyCode: "EUR" },
      note: "Payram overpayment refund",
      customerId: CUSTOMER,
      recipientAttributes: { id: CUSTOMER, message: "Here is the difference." },
    });
    expect(card).toEqual({
      id: "gid://shopify/GiftCard/9",
      lastCharacters: "4f2a",
      amount: "5.33",
      currencyCode: "EUR",
      notified: true,
    });
  });

  it("never sends the deprecated or invalid fields", async () => {
    reply(giftCard);
    await createGiftCard(SHOP, "token", {
      amount: "5.33",
      currencyCode: "EUR",
      customerId: CUSTOMER,
      note: "n",
    });
    const input = sent[0].variables.input;
    expect(input).not.toHaveProperty("initialValue");
    expect(input.recipientAttributes).not.toHaveProperty("recipient");
  });

  it("falls back to a card without a recipient when Shopify refuses the recipient", async () => {
    reply({
      giftCardCreate: {
        giftCard: null,
        userErrors: [{ field: ["input", "recipientAttributes"], message: "Recipient not allowed" }],
      },
    });
    reply(giftCard);

    const card = await createGiftCard(SHOP, "token", {
      amount: "5.33",
      currencyCode: "EUR",
      customerId: CUSTOMER,
      note: "n",
      message: "m",
    });

    expect(sent).toHaveLength(2);
    expect(sent[1].variables.input).toEqual({
      initialAmount: { amount: "5.33", currencyCode: "EUR" },
      note: "n",
      customerId: CUSTOMER,
    });
    expect(card.notified).toBe(false);
  });

  it("sends a single attempt with no customer fields for a guest order", async () => {
    reply(giftCard);
    await createGiftCard(SHOP, "token", {
      amount: "5.33",
      currencyCode: "USD",
      customerId: null,
      note: "n",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].variables.input).toEqual({
      initialAmount: { amount: "5.33", currencyCode: "USD" },
      note: "n",
    });
  });

  it("does not retry after an ambiguous failure, so a card is never minted twice", async () => {
    replies.push({ errors: [{ message: "Internal error" }] });
    await expect(
      createGiftCard(SHOP, "token", {
        amount: "5.33",
        currencyCode: "EUR",
        customerId: CUSTOMER,
        note: "n",
      }),
    ).rejects.toThrow(/unclear whether Shopify created one/);
    expect(sent).toHaveLength(1);
  });

  it("marks an unclear failure as such, so settlement looks before it ever retries", async () => {
    replies.push({ errors: [{ message: "Internal error" }] });
    const err = await createGiftCard(SHOP, "token", {
      amount: "5.33",
      currencyCode: "EUR",
      customerId: null,
      note: "n",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GiftCardOutcomeUnknownError);
  });

  it("a refusal Shopify states is not marked unclear", async () => {
    reply({
      giftCardCreate: { giftCard: null, userErrors: [{ message: "Gift cards are not enabled" }] },
    });
    const err = await createGiftCard(SHOP, "token", {
      amount: "5.33",
      currencyCode: "EUR",
      customerId: null,
      note: "n",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GiftCardOutcomeUnknownError);
    expect(String(err)).toMatch(/Gift card could not be created: Gift cards are not enabled/);
  });
});

describe("findGiftCardsByNote", () => {
  const since = new Date("2026-10-20T08:00:00Z");
  const page = (
    nodes: { id: string; note: string | null; last?: string }[],
    next: string | null = null,
  ) => ({
    giftCards: {
      nodes: nodes.map((n) => ({
        id: n.id,
        lastCharacters: n.last ?? "abcd",
        note: n.note,
        initialValue: { amount: "5.33", currencyCode: "EUR" },
      })),
      pageInfo: { hasNextPage: next !== null, endCursor: next },
    },
  });

  it("returns only cards whose note carries the marker, created since the given time", async () => {
    reply(
      page([
        { id: "gid://shopify/GiftCard/1", note: "Birthday card" },
        { id: "gid://shopify/GiftCard/2", note: "Payram overpayment refund for order #12. [Payram order 12]" },
        { id: "gid://shopify/GiftCard/3", note: "Payram overpayment refund for order #123. [Payram order 123]", last: "zzzz" },
        { id: "gid://shopify/GiftCard/4", note: null },
      ]),
    );

    const found = await findGiftCardsByNote(SHOP, "token", {
      noteIncludes: "[Payram order 123]",
      createdSince: since,
    });

    expect(found).toEqual([
      { id: "gid://shopify/GiftCard/3", lastCharacters: "zzzz", amount: "5.33", currencyCode: "EUR" },
    ]);
    expect(sent[0].variables.query).toBe("created_at:>='2026-10-20T08:00:00.000Z'");
    expect(sent[0].query).toMatch(/sortKey: CREATED_AT/);
  });

  it("reads every page before saying there is none", async () => {
    reply(page([{ id: "gid://shopify/GiftCard/1", note: "other" }], "cursor-1"));
    reply(page([{ id: "gid://shopify/GiftCard/2", note: "x [Payram order 9]" }]));

    const found = await findGiftCardsByNote(SHOP, "token", {
      noteIncludes: "[Payram order 9]",
      createdSince: since,
    });

    expect(found.map((c) => c.id)).toEqual(["gid://shopify/GiftCard/2"]);
    expect(sent[1].variables.after).toBe("cursor-1");
  });

  it("never answers 'none' from an incomplete read", async () => {
    for (let i = 0; i < 5; i += 1) reply(page([], `cursor-${i}`));
    await expect(
      findGiftCardsByNote(SHOP, "token", { noteIncludes: "[Payram order 9]", createdSince: since }),
    ).rejects.toThrow(/Too many gift cards/);

    replies.length = 0;
    reply({});
    await expect(
      findGiftCardsByNote(SHOP, "token", { noteIncludes: "[Payram order 9]", createdSince: since }),
    ).rejects.toThrow(/no gift card list/);

    replies.push({ errors: [{ message: "Access denied for giftCards field." }] });
    await expect(
      findGiftCardsByNote(SHOP, "token", { noteIncludes: "[Payram order 9]", createdSince: since }),
    ).rejects.toThrow();
  });
});
