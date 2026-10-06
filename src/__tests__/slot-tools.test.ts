import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchSlotTool, isSlotTool, todayInLondon } from "../slot-tools.js";
import type WaitroseClient from "../waitrose.js";
import type { CurrentSlot, SlotDate, SlotDay, BookSlotResult } from "../waitrose.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

function makeClient(overrides: Partial<WaitroseClient> = {}): WaitroseClient {
  return {
    isAuthenticated: vi.fn().mockReturnValue(true),
    getCurrentSlot: vi.fn(),
    getSlotDates: vi.fn(),
    getSlotDays: vi.fn(),
    bookSlot: vi.fn(),
    cancelSlot: vi.fn(),
    getAddresses: vi.fn().mockResolvedValue([
      { id: "addr-1", line1: "1 Test St", line2: null, line3: null, town: "London", region: null, country: "GB", postalCode: "SW1A 1AA" },
      { id: "addr-2", line1: "2 Other Rd", line2: null, line3: null, town: "London", region: null, country: "GB", postalCode: "SE1 1AA" },
    ]),
    getAccountInfo: vi.fn().mockResolvedValue({ profile: { contactAddress: { id: "addr-2" } }, memberships: null }),
    getDefaultBranchId: vi.fn().mockReturnValue("100"),
    findBranches: vi.fn(),
    ...overrides,
  } as unknown as WaitroseClient;
}

const stubSlot: CurrentSlot = {
  slotType: "DELIVERY",
  branchId: "968",
  addressId: "addr-1",
  postcode: null,
  startDateTime: "2026-05-14T10:00:00Z",
  endDateTime: "2026-05-14T12:00:00Z",
  expiryDateTime: "2026-05-14T09:00:00Z",
  orderCutoffDateTime: "2026-05-13T20:00:00Z",
  amendOrderCutoffDateTime: "2026-05-13T20:00:00Z",
  shopByDateTime: "2026-05-13T20:00:00Z",
  deliveryCharge: { amount: 0, currencyCode: "GBP" },
  slotGridType: "NORMAL",
};

const stubSlotDate: SlotDate = {
  id: "2026-05-14",
  dayOfWeek: "WEDNESDAY",
};

const stubSlotDay: SlotDay = {
  id: "day-1",
  branchId: "968",
  slotType: "DELIVERY",
  date: "2026-05-14",
  slots: [
    {
      id: "slot-abc",
      startDateTime: "2026-05-14T10:00:00Z",
      endDateTime: "2026-05-14T12:00:00Z",
      shopByDateTime: "2026-05-13T20:00:00Z",
      status: "AVAILABLE",
      charge: { amount: 0, currencyCode: "GBP" },
      greenSlot: true,
      deliveryPassSlot: false,
    },
  ],
};

const stubBookResult: BookSlotResult = {
  slotExpiryDateTime: "2026-05-14T09:00:00Z",
  orderCutoffDateTime: "2026-05-13T20:00:00Z",
  amendOrderCutoffDateTime: "2026-05-13T20:00:00Z",
  shopByDateTime: "2026-05-13T20:00:00Z",
};

describe("isSlotTool", () => {
  it("recognises slot tool names", () => {
    expect(isSlotTool("get_current_slot")).toBe(true);
    expect(isSlotTool("list_slot_dates")).toBe(true);
    expect(isSlotTool("list_slot_days")).toBe(true);
    expect(isSlotTool("book_slot")).toBe(true);
    expect(isSlotTool("cancel_slot")).toBe(true);
    expect(isSlotTool("list_slots")).toBe(true);
    expect(isSlotTool("list_delivery_addresses")).toBe(true);
    expect(isSlotTool("find_branches")).toBe(true);
  });

  it("rejects non-slot tool names", () => {
    expect(isSlotTool("search_products")).toBe(false);
    expect(isSlotTool("get_trolley")).toBe(false);
    expect(isSlotTool("unknown")).toBe(false);
  });
});

describe("dispatchSlotTool", () => {
  it("throws InvalidRequest when not authenticated", async () => {
    const client = makeClient({ isAuthenticated: vi.fn().mockReturnValue(false) });
    await expect(
      dispatchSlotTool(client, "get_current_slot", {}),
    ).rejects.toThrow(McpError);
  });

  describe("get_current_slot", () => {
    it("returns current slot", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(stubSlot);
      const result = await dispatchSlotTool(client, "get_current_slot", {});
      expect(client.getCurrentSlot).toHaveBeenCalledWith(undefined);
      expect(result).toEqual(stubSlot);
    });

    it("returns null when no slot is booked", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(null);
      const result = await dispatchSlotTool(client, "get_current_slot", {});
      expect(result).toBeNull();
    });

    it("passes postcode through when provided", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(stubSlot);
      await dispatchSlotTool(client, "get_current_slot", { postcode: "SW1A 1AA" });
      expect(client.getCurrentSlot).toHaveBeenCalledWith("SW1A 1AA");
    });

    it("throws InvalidParams when postcode is not a string", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "get_current_slot", { postcode: 12345 }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("list_slot_dates", () => {
    it("returns available dates for DELIVERY", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDates).mockResolvedValue([stubSlotDate]);
      const result = await dispatchSlotTool(client, "list_slot_dates", {
        slotType: "DELIVERY",
      });
      // Delivery defaults to the account's contact address when it is a saved address
      expect(client.getSlotDates).toHaveBeenCalledWith("DELIVERY", undefined, "addr-2");
      expect(result).toEqual([stubSlotDate]);
    });

    it("falls back to the first saved address when the contact address isn't saved", async () => {
      const client = makeClient({
        getAccountInfo: vi.fn().mockResolvedValue({ profile: { contactAddress: { id: "other" } }, memberships: null }),
      } as Partial<WaitroseClient>);
      vi.mocked(client.getSlotDates).mockResolvedValue([]);
      await dispatchSlotTool(client, "list_slot_dates", { slotType: "DELIVERY" });
      expect(client.getSlotDates).toHaveBeenCalledWith("DELIVERY", undefined, "addr-1");
    });

    it("errors when delivery has no saved addresses and none is given", async () => {
      const client = makeClient({ getAddresses: vi.fn().mockResolvedValue([]) } as Partial<WaitroseClient>);
      await expect(
        dispatchSlotTool(client, "list_slot_dates", { slotType: "DELIVERY" }),
      ).rejects.toThrow(/No saved delivery addresses/);
    });

    it("maps the COLLECTION alias to GROCERY_COLLECTION and passes branchId", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDates).mockResolvedValue([]);
      await dispatchSlotTool(client, "list_slot_dates", {
        slotType: "COLLECTION",
        branchId: "968",
        addressId: "addr-1",
      });
      // addressId is irrelevant for collection and is dropped
      expect(client.getSlotDates).toHaveBeenCalledWith("GROCERY_COLLECTION", "968", undefined);
    });

    it("defaults collection branch to the session's default branch", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDates).mockResolvedValue([]);
      await dispatchSlotTool(client, "list_slot_dates", { slotType: "GROCERY_COLLECTION" });
      expect(client.getSlotDates).toHaveBeenCalledWith("GROCERY_COLLECTION", "100", undefined);
    });

    it("throws InvalidParams when slotType is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_dates", {}),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotType is invalid", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_dates", { slotType: "BICYCLE" }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("list_slot_days", () => {
    it("returns slot days for a given date", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDays).mockResolvedValue([stubSlotDay]);
      const result = await dispatchSlotTool(client, "list_slot_days", {
        slotType: "DELIVERY",
        fromDate: "2026-05-14",
      });
      expect(client.getSlotDays).toHaveBeenCalledWith(
        "DELIVERY",
        "2026-05-14",
        undefined,
        "addr-2",
        undefined,
      );
      expect(result).toEqual([stubSlotDay]);
    });

    it("passes optional params when provided", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDays).mockResolvedValue([]);
      await dispatchSlotTool(client, "list_slot_days", {
        slotType: "COLLECTION",
        fromDate: "2026-05-15",
        branchId: "968",
        addressId: "addr-2",
        days: 4,
      });
      expect(client.getSlotDays).toHaveBeenCalledWith(
        "GROCERY_COLLECTION",
        "2026-05-15",
        "968",
        undefined,
        4,
      );
    });

    it("rejects a malformed fromDate", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_days", { slotType: "DELIVERY", fromDate: "14/05/2026" }),
      ).rejects.toThrow(McpError);
    });

    it("rejects days out of range", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_days", { slotType: "DELIVERY", fromDate: "2026-05-14", days: 30 }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when fromDate is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_days", { slotType: "DELIVERY" }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotType is invalid", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_days", {
          slotType: "WALK",
          fromDate: "2026-05-14",
        }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("list_delivery_addresses", () => {
    it("returns addresses with a formatted line", async () => {
      const client = makeClient();
      const result = (await dispatchSlotTool(client, "list_delivery_addresses", {})) as Array<{ id: string; formatted: string }>;
      expect(result.map((a) => a.id)).toEqual(["addr-1", "addr-2"]);
      expect(result[0].formatted).toBe("1 Test St, London, SW1A 1AA");
    });
  });

  describe("find_branches", () => {
    it("defaults to COLLECTION", async () => {
      const client = makeClient();
      vi.mocked(client.findBranches).mockResolvedValue([]);
      await dispatchSlotTool(client, "find_branches", { postcode: "SW1A 1AA" });
      expect(client.findBranches).toHaveBeenCalledWith("SW1A 1AA", "COLLECTION");
    });

    it("passes DELIVERY through", async () => {
      const client = makeClient();
      vi.mocked(client.findBranches).mockResolvedValue([]);
      await dispatchSlotTool(client, "find_branches", { postcode: "SW1A 1AA", fulfilmentType: "DELIVERY" });
      expect(client.findBranches).toHaveBeenCalledWith("SW1A 1AA", "DELIVERY");
    });

    it("requires postcode and validates fulfilmentType", async () => {
      const client = makeClient();
      await expect(dispatchSlotTool(client, "find_branches", {})).rejects.toThrow(McpError);
      await expect(
        dispatchSlotTool(client, "find_branches", { postcode: "SW1A 1AA", fulfilmentType: "DRONE" }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("list_slots", () => {
    const twoDays: SlotDay[] = [
      stubSlotDay,
      {
        ...stubSlotDay,
        id: "day-2",
        date: "2026-05-15",
        slots: [
          { ...stubSlotDay.slots[0], id: "2026-05-15_10:00_11:00", status: "FULLY_BOOKED" },
          { ...stubSlotDay.slots[0], id: "2026-05-15_11:00_12:00" },
        ],
      },
    ];

    it("flattens the grid, filters to available slots, and echoes the location used", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDays).mockResolvedValue(twoDays);
      const result = (await dispatchSlotTool(client, "list_slots", {
        slotType: "DELIVERY",
        fromDate: "2026-05-14",
        days: 2,
      })) as any;
      expect(client.getSlotDays).toHaveBeenCalledWith("DELIVERY", "2026-05-14", undefined, "addr-2", 2);
      expect(result.addressId).toBe("addr-2");
      expect(result.branchId).toBe("968");
      expect(result.totalAvailable).toBe(2);
      expect(result.days[1].slots.map((s: any) => s.slotId)).toEqual(["2026-05-15_11:00_12:00"]);
      expect(result.days[0].slots[0]).toMatchObject({
        slotId: "slot-abc",
        date: "2026-05-14",
        status: "AVAILABLE",
        charge: { amount: 0, currencyCode: "GBP" },
      });
    });

    it("includes unavailable slots when availableOnly is false", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDays).mockResolvedValue(twoDays);
      const result = (await dispatchSlotTool(client, "list_slots", {
        slotType: "COLLECTION",
        availableOnly: false,
      })) as any;
      expect(result.days[1].slots).toHaveLength(2);
      expect(result.slotType).toBe("GROCERY_COLLECTION");
      expect(result.branchId).toBe("100");
    });

    it("defaults fromDate to today (UK) and days to 3", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDays).mockResolvedValue([]);
      await dispatchSlotTool(client, "list_slots", { slotType: "GROCERY_COLLECTION" });
      expect(client.getSlotDays).toHaveBeenCalledWith("GROCERY_COLLECTION", todayInLondon(), "100", undefined, 3);
    });
  });

  describe("todayInLondon", () => {
    it("uses the UK calendar date, not UTC", () => {
      // 23:30 UTC on 30 June is already 1 July in London (BST)
      expect(todayInLondon(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
      expect(todayInLondon(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-15");
    });
  });

  describe("book_slot", () => {
    const gridDay: SlotDay = {
      id: "200_DELIVERY_2026-10-12",
      branchId: "200",
      slotType: "DELIVERY",
      date: "2026-10-12",
      slots: [
        {
          id: "2026-10-12_08:00_09:00",
          startDateTime: "2026-10-12T08:00:00+01:00",
          endDateTime: "2026-10-12T09:00:00+01:00",
          shopByDateTime: null,
          status: "AVAILABLE",
          slotGridType: "DEFAULT_GRID",
          charge: { amount: 4, currencyCode: "GBP" },
          greenSlot: false,
          deliveryPassSlot: false,
        },
        {
          id: "2026-10-12_09:00_10:00",
          startDateTime: "2026-10-12T09:00:00+01:00",
          endDateTime: "2026-10-12T10:00:00+01:00",
          shopByDateTime: null,
          status: "FULLY_BOOKED",
          slotGridType: "DEFAULT_GRID",
          charge: { amount: 4, currencyCode: "GBP" },
          greenSlot: false,
          deliveryPassSlot: false,
        },
      ],
    };

    it("resolves the slot from the grid and books by start/end time with the expected charge", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...stubSlot, slotReservationId: "res-1" });
      vi.mocked(client.getSlotDays).mockResolvedValue([gridDay]);
      vi.mocked(client.bookSlot).mockResolvedValue(stubBookResult);
      const result = (await dispatchSlotTool(client, "book_slot", {
        slotId: "2026-10-12_08:00_09:00",
        slotType: "DELIVERY",
        addressId: "addr-1",
        confirm: true,
      })) as any;
      expect(client.getSlotDays).toHaveBeenCalledWith("DELIVERY", "2026-10-12", undefined, "addr-1", 1);
      expect(client.bookSlot).toHaveBeenCalledWith({
        slotType: "DELIVERY",
        startDateTime: "2026-10-12T08:00:00+01:00",
        endDateTime: "2026-10-12T09:00:00+01:00",
        addressId: "addr-1",
        branchId: undefined,
        expectedSlotCharge: { amount: 4, currencyCode: "GBP" },
        slotGridType: "DEFAULT_GRID",
        greenSlot: false,
      });
      expect(result.slotExpiryDateTime).toBe(stubBookResult.slotExpiryDateTime);
      expect(result.booked.slotReservationId).toBe("res-1");
    });

    it("books collection slots against the branch", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(null);
      vi.mocked(client.getSlotDays).mockResolvedValue([
        { ...gridDay, branchId: "100", slotType: "GROCERY_COLLECTION", slots: [{ ...gridDay.slots[0], charge: null }] },
      ]);
      vi.mocked(client.bookSlot).mockResolvedValue(stubBookResult);
      await dispatchSlotTool(client, "book_slot", {
        slotId: "2026-10-12_08:00_09:00",
        slotType: "COLLECTION",
        confirm: true,
      });
      expect(client.getSlotDays).toHaveBeenCalledWith("GROCERY_COLLECTION", "2026-10-12", "100", undefined, 1);
      expect(vi.mocked(client.bookSlot).mock.calls[0][0]).toMatchObject({
        slotType: "GROCERY_COLLECTION",
        branchId: "100",
        addressId: undefined,
        expectedSlotCharge: null,
      });
    });

    it("refuses to replace an existing reservation unless replaceExisting is true", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(stubSlot);
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "2026-10-12_08:00_09:00",
          slotType: "DELIVERY",
          addressId: "addr-1",
          confirm: true,
        }),
      ).rejects.toThrow(/already reserved/);
      expect(client.bookSlot).not.toHaveBeenCalled();

      vi.mocked(client.getSlotDays).mockResolvedValue([gridDay]);
      vi.mocked(client.bookSlot).mockResolvedValue(stubBookResult);
      await dispatchSlotTool(client, "book_slot", {
        slotId: "2026-10-12_08:00_09:00",
        slotType: "DELIVERY",
        addressId: "addr-1",
        replaceExisting: true,
        confirm: true,
      });
      expect(client.bookSlot).toHaveBeenCalledTimes(1);
    });

    it("refuses slots that are not AVAILABLE or not in the grid", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(null);
      vi.mocked(client.getSlotDays).mockResolvedValue([gridDay]);
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "2026-10-12_09:00_10:00",
          slotType: "DELIVERY",
          addressId: "addr-1",
          confirm: true,
        }),
      ).rejects.toThrow(/not available/);
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "2026-10-12_23:00_23:30",
          slotType: "DELIVERY",
          addressId: "addr-1",
          confirm: true,
        }),
      ).rejects.toThrow(/not found/);
      expect(client.bookSlot).not.toHaveBeenCalled();
    });

    it("requires addressId for DELIVERY", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "2026-10-12_08:00_09:00",
          slotType: "DELIVERY",
          confirm: true,
        }),
      ).rejects.toThrow(McpError);
    });

    it("rejects a slotId that isn't in list_slots format", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", { slotId: "slot-abc", slotType: "DELIVERY", addressId: "a", confirm: true }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when confirm is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "2026-10-12_08:00_09:00",
          slotType: "DELIVERY",
        }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when confirm is false", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "2026-10-12_08:00_09:00",
          slotType: "DELIVERY",
          confirm: false,
        }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotId is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", { slotType: "DELIVERY", confirm: true }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotType is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", { slotId: "2026-10-12_08:00_09:00", confirm: true }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotType is invalid", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "2026-10-12_08:00_09:00",
          slotType: "TELEPORT",
          confirm: true,
        }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("cancel_slot", () => {
    it("cancels the current reservation by default", async () => {
      const client = makeClient();
      const reserved = { ...stubSlot, slotReservationId: "res-1" };
      vi.mocked(client.getCurrentSlot).mockResolvedValueOnce(reserved).mockResolvedValueOnce(null);
      const result = (await dispatchSlotTool(client, "cancel_slot", { confirm: true })) as any;
      expect(client.cancelSlot).toHaveBeenCalledWith("res-1");
      expect(result).toEqual({ cancelled: true, slotReservationId: "res-1", releasedSlot: reserved, currentSlot: null });
    });

    it("accepts an explicit slotReservationId", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(null);
      await dispatchSlotTool(client, "cancel_slot", { slotReservationId: "res-9", confirm: true });
      expect(client.cancelSlot).toHaveBeenCalledWith("res-9");
    });

    it("errors when nothing is reserved", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(null);
      await expect(dispatchSlotTool(client, "cancel_slot", { confirm: true })).rejects.toThrow(/No reserved slot/);
      expect(client.cancelSlot).not.toHaveBeenCalled();
    });

    it("requires confirm: true", async () => {
      const client = makeClient();
      await expect(dispatchSlotTool(client, "cancel_slot", {})).rejects.toThrow(McpError);
      expect(client.cancelSlot).not.toHaveBeenCalled();
    });
  });
});
