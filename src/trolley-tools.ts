import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type WaitroseClient from "./waitrose.js";
import type {
  ApiFailure,
  Price,
  TrolleyItemInput,
  TrolleyResponse,
  UnitOfMeasure,
} from "./waitrose.js";
import {
  checkBasketItemCap,
  checkBasketValueCap,
  checkQtyPerLineCap,
} from "./safety.js";

/**
 * A short summary surfaced at the top of every trolley tool response so
 * Claude can see the prominent state — whether the £40 minimum is met,
 * the running total, the item count, and any upstream failures — without
 * digging through the raw response body. The original response is spread
 * after this summary, so consumers that want full detail still have it.
 */
export interface TrolleySummaryItem {
  lineNumber: string;
  productId: string | null;
  name: string | null;
  size: string | null;
  quantity: { amount: number; uom: string };
  /** Shelf price per unit as shown on the site, e.g. "40p" or "£2.10/kg" */
  displayPrice: string | null;
  unitPrice: Price | null;
  totalPrice: Price | null;
  canSubstitute: boolean;
  noteToShopper: string | null;
}

export interface TrolleySummary {
  itemCount: number;
  totalEstimatedCost: Price;
  minimumSpendThresholdMet: boolean | null;
  failures: ApiFailure[];
  /** Trolley lines joined with their product details (name, size, prices). */
  items: TrolleySummaryItem[];
  totals: {
    itemTotalEstimatedCost: Price | null;
    deliveryCharge: Price | null;
    savingsFromOffers: Price | null;
    savingsFromMyWaitrose: Price | null;
  };
}

export type TrolleyToolResponse = TrolleyResponse & { summary: TrolleySummary };

function summariseItems(r: TrolleyResponse): TrolleySummaryItem[] {
  const products = new Map((r.products ?? []).map((p) => [p.lineNumber, p]));
  return r.trolley.trolleyItems.map((item) => {
    const p = products.get(item.lineNumber);
    return {
      lineNumber: item.lineNumber,
      productId: p?.id ?? null,
      name: p?.name ?? null,
      size: p?.size ?? null,
      quantity: { amount: item.quantity.amount, uom: item.quantity.uom },
      displayPrice: p?.displayPrice ?? null,
      unitPrice: p?.currentSaleUnitPrice?.price ?? null,
      totalPrice: item.totalPrice ?? null,
      canSubstitute: item.canSubstitute,
      noteToShopper: item.noteToShopper ?? null,
    };
  });
}

function summarise(r: TrolleyResponse): TrolleyToolResponse {
  const totals = r.trolley.trolleyTotals;
  const summary: TrolleySummary = {
    itemCount: r.trolley.trolleyItems.length,
    totalEstimatedCost: totals.totalEstimatedCost,
    minimumSpendThresholdMet: totals.minimumSpendThresholdMet ?? null,
    failures: r.failures ?? [],
    items: summariseItems(r),
    totals: {
      itemTotalEstimatedCost: totals.itemTotalEstimatedCost ?? null,
      deliveryCharge: totals.deliveryCharge ?? null,
      savingsFromOffers: totals.savingsFromOffers ?? null,
      savingsFromMyWaitrose: totals.savingsFromMyWaitrose ?? null,
    },
  };
  return { ...r, summary };
}

/**
 * Accept either a line number ("088411") or a full product id from search
 * results ("088411-45361-45362"); the line number is the id's first segment.
 */
function parseLineNumber(args: Record<string, unknown>, prefix = ""): string {
  const ln = args.lineNumber;
  const pid = args.productId;
  if (typeof ln === "string" && ln) return ln;
  if (typeof pid === "string" && pid) {
    const first = pid.split("-")[0];
    if (/^\d+$/.test(first)) return first;
    throw new McpError(ErrorCode.InvalidParams, `${prefix}productId is not a valid Waitrose product id`);
  }
  throw new McpError(ErrorCode.InvalidParams, `${prefix}lineNumber is required`);
}

const VALID_UOMS = new Set<UnitOfMeasure>(["C62", "KGM", "GRM"]);

function validateUom(value: unknown, context: string): UnitOfMeasure {
  if (value === undefined) return "C62";
  if (typeof value !== "string" || !VALID_UOMS.has(value as UnitOfMeasure)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${context}: uom must be one of C62, KGM, GRM`,
    );
  }
  return value as UnitOfMeasure;
}

export type TrolleyToolName =
  | "get_trolley"
  | "add_to_trolley"
  | "remove_from_trolley"
  | "update_trolley_items"
  | "empty_trolley";

const TROLLEY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_trolley",
  "add_to_trolley",
  "remove_from_trolley",
  "update_trolley_items",
  "empty_trolley",
]);

export function isTrolleyTool(name: string): name is TrolleyToolName {
  return TROLLEY_TOOL_NAMES.has(name);
}

function requireAuth(client: WaitroseClient): void {
  if (!client.isAuthenticated()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Not authenticated — this tool needs WAITROSE_USERNAME/WAITROSE_PASSWORD configured on the MCP server",
    );
  }
}

function parseAddToTrolley(args: Record<string, unknown>): {
  lineNumber: string;
  quantity: number;
  uom: UnitOfMeasure;
} {
  const lineNumber = parseLineNumber(args);
  const quantity = (args.quantity as number | undefined) ?? 1;
  const uom = validateUom(args.uom, "add_to_trolley");
  if (typeof quantity !== "number" || quantity <= 0 || !Number.isFinite(quantity)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "quantity must be a positive number",
    );
  }
  return { lineNumber, quantity, uom };
}

function parseUpdateItems(args: Record<string, unknown>): TrolleyItemInput[] {
  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "items must be a non-empty array",
    );
  }
  return rawItems.map((raw, idx) => {
    if (!raw || typeof raw !== "object") {
      throw new McpError(
        ErrorCode.InvalidParams,
        `items[${idx}] must be an object`,
      );
    }
    const obj = raw as Record<string, unknown>;
    const ln = parseLineNumber(obj, `items[${idx}].`);
    const qty = obj.quantity;
    const uom = validateUom(obj.uom, `items[${idx}]`);
    if (typeof qty !== "number" || qty < 0 || !Number.isFinite(qty)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `items[${idx}].quantity must be a non-negative number`,
      );
    }
    const item: TrolleyItemInput = {
      lineNumber: ln,
      quantity: { amount: qty, uom },
    };
    if (typeof obj.noteToShopper === "string") item.noteToShopper = obj.noteToShopper;
    if (typeof obj.canSubstitute === "boolean") item.canSubstitute = obj.canSubstitute;
    return item;
  });
}

/**
 * Dispatch a trolley tool call. Caller is responsible for wrapping the
 * returned data into the MCP `{content: [...]}` shape and for catching
 * CapError / DeniedError to map them to a "denied" outcome.
 */
export async function dispatchTrolleyTool(
  client: WaitroseClient,
  toolName: TrolleyToolName,
  args: Record<string, unknown>,
): Promise<TrolleyToolResponse> {
  requireAuth(client);

  switch (toolName) {
    case "get_trolley":
      return summarise(await client.getTrolley());

    case "add_to_trolley": {
      const { lineNumber, quantity, uom } = parseAddToTrolley(args);
      checkQtyPerLineCap([{ lineNumber, quantity: { amount: quantity, uom } }]);
      const trolley = await client.getTrolley();
      checkBasketValueCap(trolley);
      const isNewLine = !trolley.trolley.trolleyItems.some(
        (i) => i.lineNumber === lineNumber,
      );
      if (isNewLine) checkBasketItemCap(trolley);
      return summarise(await client.addToTrolley(lineNumber, quantity, uom));
    }

    case "remove_from_trolley": {
      const lineNumber = parseLineNumber(args);
      // Zero the line with its own unit of measure — weighed (KGM) lines
      // aren't removed by a C62 quantity of 0.
      const trolley = await client.getTrolley();
      const line = trolley.trolley.trolleyItems.find((i) => i.lineNumber === lineNumber);
      if (!line) {
        throw new Error(`Line ${lineNumber} is not in the trolley`);
      }
      const uom = VALID_UOMS.has(line.quantity.uom as UnitOfMeasure)
        ? (line.quantity.uom as UnitOfMeasure)
        : "C62";
      return summarise(await client.removeFromTrolley(lineNumber, uom));
    }

    case "update_trolley_items": {
      const items = parseUpdateItems(args);
      checkQtyPerLineCap(items);
      const trolley = await client.getTrolley();
      checkBasketValueCap(trolley);
      const currentLines = new Set(
        trolley.trolley.trolleyItems.map((i) => i.lineNumber),
      );
      const addsNewLine = items.some(
        (i) => !currentLines.has(i.lineNumber) && i.quantity.amount > 0,
      );
      if (addsNewLine) checkBasketItemCap(trolley);
      return summarise(await client.updateTrolleyItems(items));
    }

    case "empty_trolley":
      return summarise(await client.emptyTrolley());
  }
}
