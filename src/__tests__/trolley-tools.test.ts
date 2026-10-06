import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type WaitroseClient from "../waitrose.js";
import type { TrolleyResponse, TrolleyItemInput } from "../waitrose.js";
import { CapError } from "../safety.js";
import { dispatchTrolleyTool, isTrolleyTool } from "../trolley-tools.js";

function makeTrolley(
  itemCount: number,
  totalGbp: number,
  opts: {
    startingLineNumber?: number;
    minimumSpendThresholdMet?: boolean;
    failures?: { type: string; message: string }[];
  } = {},
): TrolleyResponse {
  const { startingLineNumber = 0, minimumSpendThresholdMet, failures } = opts;
  return {
    products: [],
    trolley: {
      orderId: "order-1",
      trolleyItems: Array.from({ length: itemCount }, (_, i) => ({
        lineNumber: `ln${i + startingLineNumber}`,
        trolleyItemId: i,
        quantity: { amount: 1, uom: "C62" as const },
        totalPrice: { amount: 1, currencyCode: "GBP" },
        canSubstitute: true,
        noteToShopper: null,
      })),
      trolleyTotals: {
        totalEstimatedCost: { amount: totalGbp, currencyCode: "GBP" },
        itemTotalEstimatedCost: { amount: totalGbp, currencyCode: "GBP" },
        deliveryCharge: null,
        savingsFromOffers: null,
        savingsFromMyWaitrose: null,
        ...(minimumSpendThresholdMet !== undefined ? { minimumSpendThresholdMet } : {}),
      },
      conflicts: [],
    },
    failures: failures ?? null,
  };
}

interface MockClient {
  isAuthenticated: ReturnType<typeof vi.fn>;
  getTrolley: ReturnType<typeof vi.fn>;
  addToTrolley: ReturnType<typeof vi.fn>;
  removeFromTrolley: ReturnType<typeof vi.fn>;
  updateTrolleyItems: ReturnType<typeof vi.fn>;
  emptyTrolley: ReturnType<typeof vi.fn>;
}

function makeClient(authenticated = true): MockClient {
  return {
    isAuthenticated: vi.fn(() => authenticated),
    getTrolley: vi.fn(async () => makeTrolley(0, 0)),
    addToTrolley: vi.fn(async () => makeTrolley(1, 1)),
    removeFromTrolley: vi.fn(async () => makeTrolley(0, 0)),
    updateTrolleyItems: vi.fn(async () => makeTrolley(1, 1)),
    emptyTrolley: vi.fn(async () => makeTrolley(0, 0)),
  };
}

const asClient = (c: MockClient): WaitroseClient => c as unknown as WaitroseClient;

describe("isTrolleyTool", () => {
  it("recognises the five trolley tools", () => {
    for (const name of [
      "get_trolley",
      "add_to_trolley",
      "remove_from_trolley",
      "update_trolley_items",
      "empty_trolley",
    ]) {
      expect(isTrolleyTool(name)).toBe(true);
    }
  });

  it("rejects other tool names", () => {
    expect(isTrolleyTool("search_products")).toBe(false);
    expect(isTrolleyTool("checkout")).toBe(false);
  });
});

describe("dispatchTrolleyTool — auth gate", () => {
  it("throws McpError when client is not authenticated", async () => {
    const client = makeClient(false);
    await expect(
      dispatchTrolleyTool(asClient(client), "get_trolley", {}),
    ).rejects.toBeInstanceOf(McpError);
  });
});

describe("dispatchTrolleyTool — get_trolley", () => {
  it("returns the client's trolley response", async () => {
    const client = makeClient();
    client.getTrolley.mockResolvedValueOnce(makeTrolley(2, 5));
    const data = await dispatchTrolleyTool(asClient(client), "get_trolley", {});
    expect(data.trolley.trolleyItems).toHaveLength(2);
    expect(data.trolley.trolleyTotals.totalEstimatedCost.amount).toBe(5);
  });

  it("surfaces a summary with itemCount, total, and minimumSpendThresholdMet", async () => {
    const client = makeClient();
    client.getTrolley.mockResolvedValueOnce(
      makeTrolley(3, 41, { minimumSpendThresholdMet: true }),
    );
    const data = await dispatchTrolleyTool(asClient(client), "get_trolley", {});
    expect(data.summary.itemCount).toBe(3);
    expect(data.summary.totalEstimatedCost.amount).toBe(41);
    expect(data.summary.minimumSpendThresholdMet).toBe(true);
    expect(data.summary.failures).toEqual([]);
  });

  it("summary.minimumSpendThresholdMet is false when below £40 threshold", async () => {
    const client = makeClient();
    client.getTrolley.mockResolvedValueOnce(
      makeTrolley(1, 12, { minimumSpendThresholdMet: false }),
    );
    const data = await dispatchTrolleyTool(asClient(client), "get_trolley", {});
    expect(data.summary.minimumSpendThresholdMet).toBe(false);
  });

  it("summary.minimumSpendThresholdMet is null when upstream omits the field", async () => {
    const client = makeClient();
    client.getTrolley.mockResolvedValueOnce(makeTrolley(1, 12));
    const data = await dispatchTrolleyTool(asClient(client), "get_trolley", {});
    expect(data.summary.minimumSpendThresholdMet).toBe(null);
  });

  it("summary surfaces failures from TrolleyResponse", async () => {
    const client = makeClient();
    client.getTrolley.mockResolvedValueOnce(
      makeTrolley(1, 12, {
        failures: [{ type: "OUT_OF_STOCK", message: "ln0 unavailable" }],
      }),
    );
    const data = await dispatchTrolleyTool(asClient(client), "get_trolley", {});
    expect(data.summary.failures).toHaveLength(1);
    expect(data.summary.failures[0].type).toBe("OUT_OF_STOCK");
  });
});

describe("dispatchTrolleyTool — summary.items", () => {
  it("joins trolley lines with product details", async () => {
    const client = makeClient();
    const trolley = makeTrolley(2, 1.1);
    trolley.trolley.trolleyItems[0].lineNumber = "088461";
    trolley.trolley.trolleyItems[0].quantity = { amount: 2, uom: "C62" };
    trolley.trolley.trolleyItems[0].totalPrice = { amount: 0.7, currencyCode: "GBP" };
    trolley.products = [
      {
        id: "088461-45403-45404",
        lineNumber: "088461",
        name: "Waitrose Loose Limes",
        brandName: "WAITROSE",
        displayPrice: "35p",
        size: "each",
        thumbnail: "",
        productType: "G",
        currentSaleUnitPrice: { price: { amount: 0.35, currencyCode: "GBP" }, quantity: { amount: 1, uom: "C62" } },
      },
    ];
    client.getTrolley.mockResolvedValueOnce(trolley);
    const data = await dispatchTrolleyTool(asClient(client), "get_trolley", {});
    expect(data.summary.items).toHaveLength(2);
    expect(data.summary.items[0]).toEqual({
      lineNumber: "088461",
      productId: "088461-45403-45404",
      name: "Waitrose Loose Limes",
      size: "each",
      quantity: { amount: 2, uom: "C62" },
      displayPrice: "35p",
      unitPrice: { amount: 0.35, currencyCode: "GBP" },
      totalPrice: { amount: 0.7, currencyCode: "GBP" },
      canSubstitute: true,
      noteToShopper: null,
    });
    // A line with no matching product still appears, with null product fields
    expect(data.summary.items[1]).toMatchObject({ lineNumber: "ln1", name: null, productId: null });
    expect(data.summary.totals.itemTotalEstimatedCost?.amount).toBe(1.1);
  });
});

describe("dispatchTrolleyTool — productId input", () => {
  it("add_to_trolley derives the line number from a product id", async () => {
    const client = makeClient();
    await dispatchTrolleyTool(asClient(client), "add_to_trolley", { productId: "088411-45361-45362", quantity: 2 });
    expect(client.addToTrolley).toHaveBeenCalledWith("088411", 2, "C62");
  });

  it("update_trolley_items accepts productId per item", async () => {
    const client = makeClient();
    await dispatchTrolleyTool(asClient(client), "update_trolley_items", {
      items: [{ productId: "088411-45361-45362", quantity: 0 }],
    });
    expect(client.updateTrolleyItems).toHaveBeenCalledWith([
      { lineNumber: "088411", quantity: { amount: 0, uom: "C62" } },
    ]);
  });

  it("rejects a malformed productId", async () => {
    const client = makeClient();
    await expect(
      dispatchTrolleyTool(asClient(client), "add_to_trolley", { productId: "abc-def" }),
    ).rejects.toBeInstanceOf(McpError);
  });
});

describe("dispatchTrolleyTool — write tools also surface summary", () => {
  it("add_to_trolley response carries summary", async () => {
    const client = makeClient();
    client.getTrolley.mockResolvedValueOnce(makeTrolley(0, 0));
    client.addToTrolley.mockResolvedValueOnce(
      makeTrolley(1, 3, { minimumSpendThresholdMet: false }),
    );
    const data = await dispatchTrolleyTool(asClient(client), "add_to_trolley", {
      lineNumber: "ln-new",
      quantity: 1,
    });
    expect(data.summary.itemCount).toBe(1);
    expect(data.summary.minimumSpendThresholdMet).toBe(false);
  });

  it("update_trolley_items response carries summary surfacing failures", async () => {
    const client = makeClient();
    client.getTrolley.mockResolvedValueOnce(makeTrolley(0, 0));
    client.updateTrolleyItems.mockResolvedValueOnce(
      makeTrolley(1, 5, {
        failures: [{ type: "PARTIAL", message: "one line skipped" }],
      }),
    );
    const data = await dispatchTrolleyTool(
      asClient(client),
      "update_trolley_items",
      { items: [{ lineNumber: "ln1", quantity: 1 }] },
    );
    expect(data.summary.failures).toHaveLength(1);
  });
});

describe("dispatchTrolleyTool — add_to_trolley", () => {
  let client: MockClient;
  beforeEach(() => {
    client = makeClient();
  });

  it("rejects missing lineNumber", async () => {
    await expect(
      dispatchTrolleyTool(asClient(client), "add_to_trolley", {}),
    ).rejects.toBeInstanceOf(McpError);
  });

  it("rejects non-positive quantity", async () => {
    await expect(
      dispatchTrolleyTool(asClient(client), "add_to_trolley", {
        lineNumber: "ln1",
        quantity: 0,
      }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it("rejects uom outside the C62/KGM/GRM enum", async () => {
    await expect(
      dispatchTrolleyTool(asClient(client), "add_to_trolley", {
        lineNumber: "ln1",
        quantity: 1,
        uom: "PIECE",
      }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it("default quantity 1, default uom C62 — succeeds", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(0, 0));
    await dispatchTrolleyTool(asClient(client), "add_to_trolley", {
      lineNumber: "ln1",
    });
    expect(client.addToTrolley).toHaveBeenCalledWith("ln1", 1, "C62");
  });

  it("quantity 4 succeeds with default cap of 5", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(0, 0));
    await dispatchTrolleyTool(asClient(client), "add_to_trolley", {
      lineNumber: "ln1",
      quantity: 4,
    });
    expect(client.addToTrolley).toHaveBeenCalledWith("ln1", 4, "C62");
  });

  it("quantity 5 is denied (CapError) with default cap of 5", async () => {
    await expect(
      dispatchTrolleyTool(asClient(client), "add_to_trolley", {
        lineNumber: "ln1",
        quantity: 5,
      }),
    ).rejects.toBeInstanceOf(CapError);
    expect(client.addToTrolley).not.toHaveBeenCalled();
  });

  it("denied when basket value already at cap", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(1, 200));
    await expect(
      dispatchTrolleyTool(asClient(client), "add_to_trolley", {
        lineNumber: "ln-new",
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(CapError);
    expect(client.addToTrolley).not.toHaveBeenCalled();
  });

  it("denied when basket items at cap and adding a NEW line", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(50, 10));
    await expect(
      dispatchTrolleyTool(asClient(client), "add_to_trolley", {
        lineNumber: "ln-new",
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(CapError);
  });

  it("ALLOWED when basket items at cap but updating an existing line", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(50, 10));
    await dispatchTrolleyTool(asClient(client), "add_to_trolley", {
      lineNumber: "ln0",
      quantity: 2,
    });
    expect(client.addToTrolley).toHaveBeenCalledWith("ln0", 2, "C62");
  });

  it("denied (fail-closed) if pre-fetch trolley call errors", async () => {
    client.getTrolley.mockRejectedValueOnce(new Error("upstream 500"));
    await expect(
      dispatchTrolleyTool(asClient(client), "add_to_trolley", {
        lineNumber: "ln1",
        quantity: 1,
      }),
    ).rejects.toThrow("upstream 500");
    expect(client.addToTrolley).not.toHaveBeenCalled();
  });
});

describe("dispatchTrolleyTool — remove_from_trolley", () => {
  it("calls client.removeFromTrolley with the line's unit of measure", async () => {
    const client = makeClient();
    client.getTrolley.mockResolvedValueOnce(makeTrolley(2, 2));
    await dispatchTrolleyTool(asClient(client), "remove_from_trolley", {
      lineNumber: "ln1",
    });
    expect(client.removeFromTrolley).toHaveBeenCalledWith("ln1", "C62");
  });

  it("zeroes weighed lines with KGM", async () => {
    const client = makeClient();
    const trolley = makeTrolley(1, 2);
    trolley.trolley.trolleyItems[0].quantity = { amount: 0.5, uom: "KGM" };
    client.getTrolley.mockResolvedValueOnce(trolley);
    await dispatchTrolleyTool(asClient(client), "remove_from_trolley", { lineNumber: "ln0" });
    expect(client.removeFromTrolley).toHaveBeenCalledWith("ln0", "KGM");
  });

  it("accepts a productId instead of lineNumber", async () => {
    const client = makeClient();
    const trolley = makeTrolley(1, 1);
    trolley.trolley.trolleyItems[0].lineNumber = "088411";
    client.getTrolley.mockResolvedValueOnce(trolley);
    await dispatchTrolleyTool(asClient(client), "remove_from_trolley", { productId: "088411-45361-45362" });
    expect(client.removeFromTrolley).toHaveBeenCalledWith("088411", "C62");
  });

  it("errors when the line is not in the trolley", async () => {
    const client = makeClient();
    await expect(
      dispatchTrolleyTool(asClient(client), "remove_from_trolley", { lineNumber: "nope" }),
    ).rejects.toThrow(/not in the trolley/);
    expect(client.removeFromTrolley).not.toHaveBeenCalled();
  });

  it("rejects missing lineNumber", async () => {
    const client = makeClient();
    await expect(
      dispatchTrolleyTool(asClient(client), "remove_from_trolley", {}),
    ).rejects.toBeInstanceOf(McpError);
  });
});

describe("dispatchTrolleyTool — update_trolley_items", () => {
  let client: MockClient;
  beforeEach(() => {
    client = makeClient();
  });

  it("rejects empty items array", async () => {
    await expect(
      dispatchTrolleyTool(asClient(client), "update_trolley_items", {
        items: [],
      }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it("rejects non-array items", async () => {
    await expect(
      dispatchTrolleyTool(asClient(client), "update_trolley_items", {
        items: "nope",
      }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it("rejects items[].uom outside the enum", async () => {
    await expect(
      dispatchTrolleyTool(asClient(client), "update_trolley_items", {
        items: [{ lineNumber: "ln1", quantity: 1, uom: "PIECE" }],
      }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it("succeeds with multiple items below cap", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(0, 0));
    await dispatchTrolleyTool(asClient(client), "update_trolley_items", {
      items: [
        { lineNumber: "ln1", quantity: 2 },
        { lineNumber: "ln2", quantity: 1, uom: "C62" },
      ],
    });
    const call = client.updateTrolleyItems.mock.calls[0][0] as TrolleyItemInput[];
    expect(call).toHaveLength(2);
    expect(call[0].lineNumber).toBe("ln1");
    expect(call[0].quantity.amount).toBe(2);
    expect(call[1].quantity.uom).toBe("C62");
  });

  it("denies when any input quantity meets per-line cap", async () => {
    await expect(
      dispatchTrolleyTool(asClient(client), "update_trolley_items", {
        items: [
          { lineNumber: "ok", quantity: 1 },
          { lineNumber: "bad", quantity: 5 },
        ],
      }),
    ).rejects.toBeInstanceOf(CapError);
    expect(client.updateTrolleyItems).not.toHaveBeenCalled();
  });

  it("denies when basket value already at cap", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(1, 200));
    await expect(
      dispatchTrolleyTool(asClient(client), "update_trolley_items", {
        items: [{ lineNumber: "ln1", quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(CapError);
  });

  it("denies when adding a new line at items cap", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(50, 10));
    await expect(
      dispatchTrolleyTool(asClient(client), "update_trolley_items", {
        items: [{ lineNumber: "ln-new", quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(CapError);
  });

  it("allows an update at items cap if no new lines are added", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(50, 10));
    await dispatchTrolleyTool(asClient(client), "update_trolley_items", {
      items: [{ lineNumber: "ln0", quantity: 2 }],
    });
    expect(client.updateTrolleyItems).toHaveBeenCalled();
  });

  it("allows quantity 0 (removal) without per-line cap concern", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(2, 5));
    await dispatchTrolleyTool(asClient(client), "update_trolley_items", {
      items: [{ lineNumber: "ln0", quantity: 0 }],
    });
    expect(client.updateTrolleyItems).toHaveBeenCalled();
  });

  it("preserves noteToShopper and canSubstitute in mapped input", async () => {
    client.getTrolley.mockResolvedValueOnce(makeTrolley(0, 0));
    await dispatchTrolleyTool(asClient(client), "update_trolley_items", {
      items: [
        {
          lineNumber: "ln1",
          quantity: 1,
          noteToShopper: "ripe please",
          canSubstitute: false,
        },
      ],
    });
    const call = client.updateTrolleyItems.mock.calls[0][0] as TrolleyItemInput[];
    expect(call[0].noteToShopper).toBe("ripe please");
    expect(call[0].canSubstitute).toBe(false);
  });
});

describe("dispatchTrolleyTool — empty_trolley", () => {
  it("calls client.emptyTrolley", async () => {
    const client = makeClient();
    await dispatchTrolleyTool(asClient(client), "empty_trolley", {});
    expect(client.emptyTrolley).toHaveBeenCalled();
  });
});
