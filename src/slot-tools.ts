import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type WaitroseClient from "./waitrose.js";
import { isCollectionSlotType, normaliseSlotType } from "./waitrose.js";
import type {
  Address,
  BookSlotResult,
  Branch,
  CurrentSlot,
  FulfilmentType,
  Price,
  SlotDate,
  SlotDay,
  SlotType,
} from "./waitrose.js";

export type SlotToolName =
  | "get_current_slot"
  | "list_delivery_addresses"
  | "find_branches"
  | "list_slot_dates"
  | "list_slot_days"
  | "list_slots"
  | "book_slot"
  | "cancel_slot";

const SLOT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_current_slot",
  "list_delivery_addresses",
  "find_branches",
  "list_slot_dates",
  "list_slot_days",
  "list_slots",
  "book_slot",
  "cancel_slot",
]);

/** Slot types accepted on tool input. COLLECTION is an alias for GROCERY_COLLECTION. */
export const SLOT_TYPE_VALUES = [
  "DELIVERY",
  "COLLECTION",
  "GROCERY_COLLECTION",
  "ENTERTAINING_COLLECTION",
] as const;

/** Default and maximum number of days returned by list_slots. */
const DEFAULT_SLOT_DAYS = 3;
const MAX_SLOT_DAYS = 14;

/** Slot ids look like "2026-10-12_08:00_09:00". */
const SLOT_ID_RE = /^(\d{4}-\d{2}-\d{2})_\d{2}:\d{2}_\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isSlotTool(name: string): name is SlotToolName {
  return SLOT_TOOL_NAMES.has(name);
}

function requireAuth(client: WaitroseClient): void {
  if (!client.isAuthenticated()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Not authenticated — this tool needs WAITROSE_USERNAME/WAITROSE_PASSWORD configured on the MCP server",
    );
  }
}

function parseSlotType(args: Record<string, unknown>): SlotType {
  const slotType = args.slotType;
  if (typeof slotType !== "string" || !(SLOT_TYPE_VALUES as readonly string[]).includes(slotType)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `slotType must be one of ${SLOT_TYPE_VALUES.join(", ")}`,
    );
  }
  return normaliseSlotType(slotType as (typeof SLOT_TYPE_VALUES)[number]);
}

function parseOptionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "string") {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a string`);
  }
  return val;
}

function parseDate(args: Record<string, unknown>, key: string): string | undefined {
  const val = parseOptionalString(args, key);
  if (val !== undefined && !DATE_RE.test(val)) {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a date in YYYY-MM-DD format`);
  }
  return val;
}

function parseDays(args: Record<string, unknown>): number | undefined {
  const days = args.days;
  if (days === undefined) return undefined;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_SLOT_DAYS) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `days must be an integer between 1 and ${MAX_SLOT_DAYS}`,
    );
  }
  return days;
}

/** Today's date in Europe/London as YYYY-MM-DD (slot dates are UK-local). */
export function todayInLondon(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function formatAddress(a: Address): string {
  return [a.line1, a.line2, a.line3, a.town, a.postalCode].filter(Boolean).join(", ");
}

/**
 * Delivery slot queries need an addressId. When the caller doesn't give one,
 * use the account's contact address if it is a saved address, otherwise the
 * first saved address. The id used is always echoed back in the response.
 */
async function resolveDeliveryAddressId(
  client: WaitroseClient,
  provided: string | undefined,
): Promise<string> {
  if (provided) return provided;
  const addresses = await client.getAddresses();
  if (addresses.length === 0) {
    throw new Error("No saved delivery addresses on this account — pass addressId explicitly");
  }
  let contactId: string | undefined;
  try {
    contactId = (await client.getAccountInfo()).profile?.contactAddress?.id;
  } catch {
    contactId = undefined;
  }
  const contact = contactId ? addresses.find((a) => a.id === contactId) : undefined;
  return (contact ?? addresses[0]).id;
}

/** Fill in the location defaults for a slot query. */
async function resolveLocation(
  client: WaitroseClient,
  slotType: SlotType,
  branchId: string | undefined,
  addressId: string | undefined,
): Promise<{ branchId?: string; addressId?: string }> {
  if (isCollectionSlotType(slotType)) {
    return { branchId: branchId ?? client.getDefaultBranchId() ?? undefined };
  }
  return { branchId, addressId: await resolveDeliveryAddressId(client, addressId) };
}

export interface SlotSummary {
  slotId: string;
  date: string;
  startDateTime: string;
  endDateTime: string;
  status: string;
  charge: Price | null;
  greenSlot: boolean;
  deliveryPassSlot: boolean;
  slotGridType: string | null;
}

export interface ListSlotsResponse {
  slotType: SlotType;
  branchId: string | null;
  addressId: string | null;
  fromDate: string;
  days: Array<{ date: string; branchId: string; availableCount: number; slots: SlotSummary[] }>;
  totalAvailable: number;
}

function summariseDays(slotDays: SlotDay[], availableOnly: boolean): ListSlotsResponse["days"] {
  return slotDays.map((day) => {
    const all = day.slots ?? [];
    const slots = all
      .filter((s) => !availableOnly || s.status === "AVAILABLE")
      .map((s) => ({
        slotId: s.id,
        date: day.date,
        startDateTime: s.startDateTime,
        endDateTime: s.endDateTime,
        status: s.status,
        charge: s.charge ?? null,
        greenSlot: !!s.greenSlot,
        deliveryPassSlot: !!s.deliveryPassSlot,
        slotGridType: s.slotGridType ?? null,
      }));
    return {
      date: day.date,
      branchId: day.branchId,
      availableCount: all.filter((s) => s.status === "AVAILABLE").length,
      slots,
    };
  });
}

export interface BookSlotToolResponse extends BookSlotResult {
  booked: CurrentSlot | null;
}

export interface CancelSlotToolResponse {
  cancelled: true;
  slotReservationId: string;
  releasedSlot: CurrentSlot | null;
  currentSlot: CurrentSlot | null;
}

export type SlotToolResponse =
  | CurrentSlot
  | null
  | Array<Address & { formatted: string }>
  | Branch[]
  | SlotDate[]
  | SlotDay[]
  | ListSlotsResponse
  | BookSlotToolResponse
  | CancelSlotToolResponse;

function requireConfirm(args: Record<string, unknown>, what: string): void {
  if (args.confirm !== true) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Set confirm: true to proceed — this ${what}`,
    );
  }
}

export async function dispatchSlotTool(
  client: WaitroseClient,
  toolName: SlotToolName,
  args: Record<string, unknown>,
): Promise<SlotToolResponse> {
  requireAuth(client);

  switch (toolName) {
    case "get_current_slot": {
      const postcode = parseOptionalString(args, "postcode");
      return client.getCurrentSlot(postcode);
    }

    case "list_delivery_addresses": {
      const addresses = await client.getAddresses();
      return addresses.map((a) => ({ ...a, formatted: formatAddress(a) }));
    }

    case "find_branches": {
      const postcode = parseOptionalString(args, "postcode");
      if (!postcode) {
        throw new McpError(ErrorCode.InvalidParams, "postcode is required");
      }
      const raw = args.fulfilmentType ?? "COLLECTION";
      if (raw !== "COLLECTION" && raw !== "DELIVERY") {
        throw new McpError(ErrorCode.InvalidParams, "fulfilmentType must be COLLECTION or DELIVERY");
      }
      return client.findBranches(postcode, raw as FulfilmentType);
    }

    case "list_slot_dates": {
      const slotType = parseSlotType(args);
      const loc = await resolveLocation(
        client,
        slotType,
        parseOptionalString(args, "branchId"),
        parseOptionalString(args, "addressId"),
      );
      return client.getSlotDates(slotType, loc.branchId, loc.addressId);
    }

    case "list_slot_days": {
      const slotType = parseSlotType(args);
      const fromDate = parseDate(args, "fromDate");
      if (!fromDate) {
        throw new McpError(ErrorCode.InvalidParams, "fromDate is required");
      }
      const days = parseDays(args);
      const loc = await resolveLocation(
        client,
        slotType,
        parseOptionalString(args, "branchId"),
        parseOptionalString(args, "addressId"),
      );
      return client.getSlotDays(slotType, fromDate, loc.branchId, loc.addressId, days);
    }

    case "list_slots": {
      const slotType = parseSlotType(args);
      const fromDate = parseDate(args, "fromDate") ?? todayInLondon();
      const days = parseDays(args) ?? DEFAULT_SLOT_DAYS;
      const availableOnly = args.availableOnly === undefined ? true : args.availableOnly;
      if (typeof availableOnly !== "boolean") {
        throw new McpError(ErrorCode.InvalidParams, "availableOnly must be a boolean");
      }
      const loc = await resolveLocation(
        client,
        slotType,
        parseOptionalString(args, "branchId"),
        parseOptionalString(args, "addressId"),
      );
      const slotDays = await client.getSlotDays(slotType, fromDate, loc.branchId, loc.addressId, days);
      const summary = summariseDays(slotDays, availableOnly);
      return {
        slotType,
        branchId: loc.branchId ?? summary[0]?.branchId ?? null,
        addressId: loc.addressId ?? null,
        fromDate,
        days: summary,
        totalAvailable: summary.reduce((n, d) => n + d.availableCount, 0),
      };
    }

    case "book_slot": {
      requireConfirm(args, "reserves a slot against the trolley (release it with cancel_slot)");
      const slotId = parseOptionalString(args, "slotId");
      if (!slotId) {
        throw new McpError(ErrorCode.InvalidParams, "slotId is required");
      }
      const match = SLOT_ID_RE.exec(slotId);
      if (!match) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "slotId must be a slot id from list_slots/list_slot_days, e.g. 2026-10-12_08:00_09:00",
        );
      }
      const slotType = parseSlotType(args);
      const addressId = parseOptionalString(args, "addressId");
      const branchId = parseOptionalString(args, "branchId");
      if (slotType === "DELIVERY" && !addressId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "addressId is required for DELIVERY — use the addressId returned by list_slots",
        );
      }
      const replaceExisting = args.replaceExisting === true;

      const existing = await client.getCurrentSlot();
      if (existing && !replaceExisting) {
        throw new Error(
          `A ${existing.slotType} slot is already reserved (${existing.startDateTime} – ${existing.endDateTime}). ` +
            "Pass replaceExisting: true to swap it, or cancel_slot first.",
        );
      }

      // The API books by start/end time rather than slot id, and rejects the
      // booking if the expected charge doesn't match — so re-read the grid.
      const loc = await resolveLocation(client, slotType, branchId, addressId);
      const slotDays = await client.getSlotDays(slotType, match[1], loc.branchId, loc.addressId, 1);
      const day = slotDays.find((d) => d.date === match[1]) ?? slotDays[0];
      const slot = day?.slots?.find((s) => s.id === slotId);
      if (!day || !slot) {
        throw new Error(`Slot ${slotId} not found in the ${slotType} slot grid`);
      }
      if (slot.status !== "AVAILABLE") {
        throw new Error(`Slot ${slotId} is not available (status: ${slot.status})`);
      }

      const result = await client.bookSlot({
        slotType,
        startDateTime: slot.startDateTime,
        endDateTime: slot.endDateTime,
        addressId: loc.addressId,
        branchId: isCollectionSlotType(slotType) ? (loc.branchId ?? day.branchId) : undefined,
        expectedSlotCharge: slot.charge,
        slotGridType: slot.slotGridType,
        greenSlot: slot.greenSlot,
      });
      const booked = await client.getCurrentSlot();
      return { ...result, booked };
    }

    case "cancel_slot": {
      requireConfirm(args, "releases the currently reserved slot");
      let slotReservationId = parseOptionalString(args, "slotReservationId");
      const before = await client.getCurrentSlot();
      if (!slotReservationId) {
        slotReservationId = before?.slotReservationId ?? undefined;
      }
      if (!slotReservationId) {
        throw new Error("No reserved slot to cancel");
      }
      await client.cancelSlot(slotReservationId);
      const after = await client.getCurrentSlot();
      return {
        cancelled: true,
        slotReservationId,
        releasedSlot: before?.slotReservationId === slotReservationId ? before : null,
        currentSlot: after,
      };
    }
  }
}
