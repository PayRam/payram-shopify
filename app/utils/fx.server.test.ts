/**
 * Tests for fiat → USD conversion.
 *
 * The regression these lock down: a €50 order was being sent to Payram as
 * `amountInUSD: 50`, because the connector passed the order total through
 * verbatim and only the variable name claimed it was USD. Any change that lets
 * a non-USD amount reach Payram unconverted must fail here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { fxRate } = vi.hoisted(() => ({
  fxRate: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("~/db.server", () => ({
  default: { fxRate },
}));

import { convertToUsd, FxRateUnavailableError, FX_SOURCE } from "./fx.server";

/** A successful open.er-api.com response: rates[CUR] = units of CUR per 1 USD. */
function providerOk(rates: Record<string, number>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: "success", base_code: "USD", rates }),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fxRate.findUnique.mockResolvedValue(null);
  fxRate.upsert.mockResolvedValue({});
  vi.stubGlobal("fetch", fetchMock);
  // The module logs provider failures; keep test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("convertToUsd — the €50 regression", () => {
  it("does NOT pass a EUR total through as the same USD number", async () => {
    fetchMock.mockResolvedValue(providerOk({ EUR: 0.9221 }));

    const result = await convertToUsd("50.00", "EUR");

    // The bug: 50 EUR arrived at Payram as 50 USD.
    expect(result.amountInUsd.toFixed(2)).not.toBe("50.00");
    // 1 / 0.9221 = 1.084481… USD per EUR ⇒ 50 EUR = 54.22 USD
    expect(result.amountInUsd.toFixed(2)).toBe("54.22");
    expect(result.currency).toBe("EUR");
    expect(result.originalAmount.toFixed(2)).toBe("50.00");
    expect(result.source).toBe(FX_SOURCE);
  });

  it("reports the rate it used so the merchant can reconcile", async () => {
    fetchMock.mockResolvedValue(providerOk({ EUR: 0.9221 }));

    const result = await convertToUsd("50.00", "EUR");

    expect(result.usdPerUnit.toFixed(6)).toBe("1.084481");
  });
});

describe("convertToUsd — USD orders", () => {
  it("passes USD through without touching the network", async () => {
    const result = await convertToUsd("50.00", "USD");

    expect(result.amountInUsd.toFixed(2)).toBe("50.00");
    expect(result.usdPerUnit.toFixed(0)).toBe("1");
    expect(result.source).toBe("identity");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fxRate.findUnique).not.toHaveBeenCalled();
  });

  it("accepts a lowercase currency code", async () => {
    const result = await convertToUsd("10.00", "usd");
    expect(result.currency).toBe("USD");
  });
});

describe("convertToUsd — caching", () => {
  it("uses a cached rate without calling the provider", async () => {
    fxRate.findUnique.mockResolvedValue({
      currency: "EUR",
      usdPerUnit: "1.1",
      source: FX_SOURCE,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await convertToUsd("100", "EUR");

    expect(result.amountInUsd.toFixed(2)).toBe("110.00");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches once a cached rate has expired", async () => {
    fxRate.findUnique.mockResolvedValue({
      currency: "EUR",
      usdPerUnit: "1.1",
      source: FX_SOURCE,
      fetchedAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    fetchMock.mockResolvedValue(providerOk({ EUR: 0.5 }));

    const result = await convertToUsd("100", "EUR");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.amountInUsd.toFixed(2)).toBe("200.00");
  });

  it("stores a freshly fetched rate for reuse", async () => {
    fetchMock.mockResolvedValue(providerOk({ GBP: 0.8 }));

    await convertToUsd("10", "GBP");

    expect(fxRate.upsert).toHaveBeenCalledTimes(1);
    const call = fxRate.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ currency: "GBP" });
    expect(call.create.usdPerUnit).toBe("1.25");
    expect(call.create.source).toBe(FX_SOURCE);
    expect(call.create.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("convertToUsd — fails closed", () => {
  it("throws when the provider is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(convertToUsd("50", "EUR")).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  });

  it("throws when the provider returns a non-200", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(convertToUsd("50", "EUR")).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  });

  it("throws when the provider returns unparseable JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    await expect(convertToUsd("50", "EUR")).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  });

  it("throws when the requested currency is absent from the rate table", async () => {
    fetchMock.mockResolvedValue(providerOk({ GBP: 0.8 }));

    await expect(convertToUsd("50", "EUR")).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  });

  it.each([0, -1])("throws on a nonsensical rate (%s)", async (rate) => {
    fetchMock.mockResolvedValue(providerOk({ EUR: rate }));

    await expect(convertToUsd("50", "EUR")).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  });

  it("never returns the unconverted amount as a fallback", async () => {
    fetchMock.mockRejectedValue(new Error("provider down"));

    // The whole point: no rate means no payment, not a payment at 1:1.
    await expect(convertToUsd("50", "EUR")).rejects.toThrow();
    expect(fxRate.upsert).not.toHaveBeenCalled();
  });

  it("explains what to do next when it fails", async () => {
    fetchMock.mockRejectedValue(new Error("provider down"));

    await expect(convertToUsd("50", "EUR")).rejects.toThrow(
      /try again|network access/i,
    );
  });
});

describe("convertToUsd — input validation", () => {
  it.each(["", "E", "EURO", "12"])(
    "rejects a malformed currency code (%s)",
    async (code) => {
      await expect(convertToUsd("50", code)).rejects.toThrow(/ISO-4217/);
    },
  );

  it.each(["0", "-1"])("rejects a non-positive total (%s)", async (amount) => {
    await expect(convertToUsd(amount, "USD")).rejects.toThrow(/positive/);
  });
});

describe("convertToUsd — money precision", () => {
  it("rounds half up to cents", async () => {
    fetchMock.mockResolvedValue(providerOk({ EUR: 0.5 })); // ⇒ 2 USD per EUR

    // 0.0625 × 2 = 0.125 exactly — half-up gives 0.13, bankers' would give 0.12.
    const result = await convertToUsd("0.0625", "EUR");

    expect(result.amountInUsd.toFixed(2)).toBe("0.13");
  });

  it("keeps sub-cent accuracy for low-value currencies", async () => {
    // 1 USD = 16,000 IDR ⇒ 1 IDR = 0.0000625 USD
    fetchMock.mockResolvedValue(providerOk({ IDR: 16000 }));

    const result = await convertToUsd("1500000", "IDR");

    expect(result.amountInUsd.toFixed(2)).toBe("93.75");
  });

  it("does not lose precision on a large total", async () => {
    fetchMock.mockResolvedValue(providerOk({ EUR: 0.5 }));

    const result = await convertToUsd("1234567.89", "EUR");

    expect(result.amountInUsd.toFixed(2)).toBe("2469135.78");
  });
});
