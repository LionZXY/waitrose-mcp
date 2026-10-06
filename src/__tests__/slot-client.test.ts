import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WaitroseClient from "../waitrose.js";

vi.mock("../metrics.js", () => ({
  reauthsTotal: { inc: vi.fn() },
  toolCallsTotal: { inc: vi.fn() },
  toolCallDuration: { startTimer: vi.fn(() => vi.fn()) },
  upstreamCallsTotal: { inc: vi.fn() },
  sessionAuthenticated: { set: vi.fn() },
  registry: { metrics: vi.fn(async () => ""), contentType: "text/plain" },
}));

vi.mock("../audit.js", () => ({
  redactArgs: vi.fn((_, args) => args),
  auditLog: vi.fn(),
}));

function sessionPayload(expiresIn = 900) {
  return {
    data: {
      generateSession: {
        accessToken: "tok",
        refreshToken: "ref",
        customerId: "cust-1",
        customerOrderId: "order-1",
        customerOrderState: "PENDING",
        defaultBranchId: "100",
        expiresIn,
        failures: null,
      },
    },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * Install a fetch stub. `respond` gets each non-login call and returns the
 * JSON body; login (generateSession) calls are answered automatically.
 */
function stubFetch(respond: (call: Call) => unknown, expiresIn = 900): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts: RequestInit = {}) => {
      const call: Call = {
        url,
        method: opts.method ?? "GET",
        headers: (opts.headers ?? {}) as Record<string, string>,
        body: opts.body ? JSON.parse(opts.body as string) : undefined,
      };
      calls.push(call);
      const isLogin = typeof call.body?.query === "string" && call.body.query.includes("generateSession");
      const json = isLogin ? sessionPayload(expiresIn) : respond(call);
      return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) } as Response;
    }),
  );
  return calls;
}

async function loggedInClient(): Promise<WaitroseClient> {
  const client = new WaitroseClient();
  await client.login("user@example.com", "pw");
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WaitroseClient slots", () => {
  let calls: Call[];

  describe("bookSlot", () => {
    beforeEach(() => {
      calls = stubFetch(() => ({
        data: {
          bookSlot: {
            slotExpiryDateTime: "2026-10-06T16:40:19+01:00",
            orderCutoffDateTime: "2026-10-12T23:00:00+01:00",
            amendOrderCutoffDateTime: null,
            shopByDateTime: null,
            failures: null,
            variant: "UNKNOWN",
          },
        },
      }));
    });

    it("sends a delivery BookSlotInput keyed by time + address with the expected charge", async () => {
      const client = await loggedInClient();
      const result = await client.bookSlot({
        slotType: "DELIVERY",
        startDateTime: "2026-10-12T08:00:00+01:00",
        endDateTime: "2026-10-12T09:00:00+01:00",
        addressId: "addr-1",
        branchId: "200",
        expectedSlotCharge: { amount: 4, currencyCode: "GBP" },
        slotGridType: "DEFAULT_GRID",
        greenSlot: false,
      });
      const call = calls[calls.length - 1];
      expect(call.body.query).toContain("bookSlot(bookSlotInput: $input)");
      expect(call.body.variables.input).toEqual({
        slotType: "DELIVERY",
        customerOrderId: "order-1",
        customerId: "cust-1",
        startDateTime: "2026-10-12T08:00:00+01:00",
        endDateTime: "2026-10-12T09:00:00+01:00",
        addressId: "addr-1",
        expectedSlotCharge: { amount: 4, currencyCode: "GBP" },
        slotGridType: "DEFAULT_GRID",
        greenSlot: false,
      });
      expect(call.headers.Authorization).toBe("Bearer tok");
      expect(result.slotExpiryDateTime).toBe("2026-10-06T16:40:19+01:00");
    });

    it("sends branchId (defaulting to the session branch) for collection", async () => {
      const client = await loggedInClient();
      await client.bookSlot({
        slotType: "GROCERY_COLLECTION",
        startDateTime: "2026-10-13T14:00:00+01:00",
        endDateTime: "2026-10-13T15:00:00+01:00",
        expectedSlotCharge: null,
      });
      const input = calls[calls.length - 1].body.variables.input;
      expect(input.branchId).toBe("100");
      expect(input).not.toHaveProperty("addressId");
    });

    it("throws on API failures", async () => {
      calls = stubFetch(() => ({
        data: { bookSlot: { failures: [{ type: "CONFLICT", message: "Required slot is fully booked" }] } },
      }));
      const client = await loggedInClient();
      await expect(
        client.bookSlot({ slotType: "DELIVERY", startDateTime: "a", endDateTime: "b", addressId: "x" }),
      ).rejects.toThrow("Book slot failed: Required slot is fully booked");
    });
  });

  describe("cancelSlot", () => {
    it("sends the reservation id", async () => {
      calls = stubFetch(() => ({ data: { cancelSlot: { failures: null } } }));
      const client = await loggedInClient();
      await client.cancelSlot("res-1");
      const call = calls[calls.length - 1];
      expect(call.body.query).toContain("cancelSlot(slotReservationId: $slotReservationId)");
      expect(call.body.variables).toEqual({ slotReservationId: "res-1" });
    });

    it("throws on API failures", async () => {
      stubFetch(() => ({ data: { cancelSlot: { failures: [{ type: "NOT_FOUND", message: "No reservation" }] } } }));
      const client = await loggedInClient();
      await expect(client.cancelSlot("res-1")).rejects.toThrow("Cancel slot failed: NOT_FOUND: No reservation");
    });
  });

  describe("getCurrentSlot", () => {
    it("sends customerOrderId/customerId and returns the slot with its reservation id", async () => {
      calls = stubFetch(() => ({
        data: { currentSlot: { slotType: "DELIVERY", startDateTime: "s", slotReservationId: "res-1" } },
      }));
      const client = await loggedInClient();
      const slot = await client.getCurrentSlot();
      expect(calls[calls.length - 1].body.variables.input).toEqual({ customerOrderId: "order-1", customerId: "cust-1" });
      expect(slot?.slotReservationId).toBe("res-1");
    });

    it("normalises an all-null slot object to null", async () => {
      stubFetch(() => ({ data: { currentSlot: { slotType: null, startDateTime: null, slotReservationId: null } } }));
      const client = await loggedInClient();
      expect(await client.getCurrentSlot()).toBeNull();
    });
  });

  describe("getSlotDays / getSlotDates", () => {
    beforeEach(() => {
      calls = stubFetch((call) =>
        call.body.query.includes("slotDays")
          ? { data: { slotDays: { content: [], failures: null } } }
          : { data: { slotDates: { content: null, failures: null } } },
      );
    });

    it("delivery: sends addressId and size, and does not force the default (collection) branch", async () => {
      const client = await loggedInClient();
      await client.getSlotDays("DELIVERY", "2026-10-12", undefined, "addr-1", 3);
      expect(calls[calls.length - 1].body.variables.slotDaysInput).toEqual({
        slotType: "DELIVERY",
        customerOrderId: "order-1",
        addressId: "addr-1",
        fromDate: "2026-10-12",
        size: 3,
      });
    });

    it("collection: defaults to the session branch", async () => {
      const client = await loggedInClient();
      await client.getSlotDays("GROCERY_COLLECTION", "2026-10-12");
      expect(calls[calls.length - 1].body.variables.slotDaysInput).toEqual({
        slotType: "GROCERY_COLLECTION",
        customerOrderId: "order-1",
        branchId: "100",
        fromDate: "2026-10-12",
      });
    });

    it("returns [] when content is null", async () => {
      const client = await loggedInClient();
      expect(await client.getSlotDates("GROCERY_COLLECTION")).toEqual([]);
    });

    it("throws on failures", async () => {
      stubFetch(() => ({ data: { slotDays: { content: null, failures: [{ type: "VALIDATION_ERROR", message: "Address Id is required" }] } } }));
      const client = await loggedInClient();
      await expect(client.getSlotDays("DELIVERY", "2026-10-12")).rejects.toThrow("Address Id is required");
    });
  });
});

describe("WaitroseClient addresses and branches", () => {
  it("getAddresses returns the address list", async () => {
    stubFetch(() => ({ data: { addresses: [{ id: "a1", postalCode: "SW1A 1AA" }] } }));
    const client = await loggedInClient();
    expect(await client.getAddresses()).toEqual([{ id: "a1", postalCode: "SW1A 1AA" }]);
  });

  it("findBranches calls the branch REST API and flattens the response", async () => {
    const calls = stubFetch(() => ({
      totalCount: 1,
      branches: [
        {
          branch: {
            id: 753,
            name: "St Katharine Docks",
            type: "STANDARD_BRANCH",
            services: ["GROCERY"],
            contactDetails: { address1: "Thomas More Street", city: "London", postcode: "E1W 1YY", phone: "0207" },
          },
          defaultBranch: true,
          distance: 3.2,
          carParkCollectionEnabled: false,
        },
      ],
    }));
    const client = new WaitroseClient();
    const branches = await client.findBranches("SW1A 1AA");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/branch-prod/v4/branches");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fulfilment_type: "COLLECTION",
      location: "SW1A 1AA",
      service_type: "GROCERY",
    });
    expect(calls[0].headers.Authorization).toBe("Bearer unauthenticated");
    expect(branches).toEqual([
      {
        id: "753",
        name: "St Katharine Docks",
        type: "STANDARD_BRANCH",
        defaultBranch: true,
        distance: 3.2,
        carParkCollectionEnabled: false,
        services: ["GROCERY"],
        address: { address1: "Thomas More Street", address2: undefined, city: "London", county: undefined, postcode: "E1W 1YY" },
        phone: "0207",
      },
    ]);
  });

  it("findBranches omits service_type for DELIVERY", async () => {
    const calls = stubFetch(() => ({ branches: [] }));
    const client = new WaitroseClient();
    await client.findBranches("SW1A 1AA", "DELIVERY");
    expect(new URL(calls[0].url).searchParams.has("service_type")).toBe(false);
  });
});

describe("WaitroseClient token expiry", () => {
  it("re-logs in proactively when the access token is about to expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    const calls = stubFetch(() => ({ data: { shoppingContext: { customerId: "cust-1" } } }), 900);
    const client = await loggedInClient();

    await client.getShoppingContext();
    expect(calls.filter((c) => c.body.query.includes("generateSession"))).toHaveLength(1);

    // 14.5 minutes later — inside the 60s skew window before the 15-minute expiry
    vi.setSystemTime(new Date("2026-10-06T12:14:30Z"));
    await client.getShoppingContext();
    const logins = calls.filter((c) => c.body.query.includes("generateSession"));
    expect(logins).toHaveLength(2);
    // The re-login happens before the real call, which then succeeds first time
    expect(calls[calls.length - 1].body.query).toContain("shoppingContext");
    expect(calls[calls.length - 2].body.query).toContain("generateSession");
  });

  it("does not re-login while the token is fresh", async () => {
    const calls = stubFetch(() => ({ data: { shoppingContext: {} } }), 900);
    const client = await loggedInClient();
    await client.getShoppingContext();
    await client.getShoppingContext();
    expect(calls.filter((c) => c.body.query.includes("generateSession"))).toHaveLength(1);
  });
});
