/** Fields safe to include in audit logs, keyed by tool name. */
const SAFE_ARGS: Record<string, Set<string>> = {
  search_products: new Set(["query", "sortBy", "size", "start", "filterTags"]),
  browse_products: new Set(["category", "sortBy", "size", "start"]),
  get_products_by_line_numbers: new Set(["lineNumbers"]),
  get_promotion_products: new Set(["promotionId", "sortBy", "size", "start"]),
  get_trolley: new Set([]),
  add_to_trolley: new Set(["lineNumber", "productId", "quantity", "uom"]),
  remove_from_trolley: new Set(["lineNumber", "productId"]),
  update_trolley_items: new Set(["items"]),
  empty_trolley: new Set([]),
  get_pending_orders: new Set(["limit"]),
  get_previous_orders: new Set(["limit"]),
  get_order: new Set(["customerOrderId"]),
  cancel_order: new Set(["customerOrderId"]),
  initiate_amend_order: new Set(["customerOrderId"]),
  cancel_amend_order: new Set(["customerOrderId"]),
  get_shopping_context: new Set([]),
  get_account_info: new Set([]),
  get_campaigns: new Set([]),
  // postcode is PII — intentionally omitted from get_current_slot allowlist
  get_current_slot: new Set([]),
  list_delivery_addresses: new Set([]),
  // postcode is PII — intentionally omitted from find_branches allowlist
  find_branches: new Set(["fulfilmentType"]),
  list_slot_dates: new Set(["slotType", "branchId", "addressId"]),
  list_slot_days: new Set(["slotType", "fromDate", "days", "branchId", "addressId"]),
  list_slots: new Set(["slotType", "fromDate", "days", "branchId", "addressId", "availableOnly"]),
  book_slot: new Set(["slotId", "slotType", "addressId", "branchId", "replaceExisting", "confirm"]),
  cancel_slot: new Set(["slotReservationId", "confirm"]),
};

/**
 * For top-level fields whose values are arrays of objects, an allowlist of
 * keys to retain on each element. Anything else on each element is redacted.
 */
const SAFE_ITEM_FIELDS: Record<string, Record<string, Set<string>>> = {
  update_trolley_items: {
    items: new Set(["lineNumber", "productId", "quantity", "uom", "noteToShopper", "canSubstitute"]),
  },
};

function redactArrayElements(
  arr: unknown,
  allow: Set<string>,
): unknown {
  if (!Array.isArray(arr)) return "<redacted>";
  return arr.map((el) => {
    if (el === null || typeof el !== "object" || Array.isArray(el)) return "<redacted>";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el as Record<string, unknown>)) {
      out[k] = allow.has(k) ? v : "<redacted>";
    }
    return out;
  });
}

/** Returns a copy of args with any field not on the allowlist redacted. */
export function redactArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const safe = SAFE_ARGS[toolName];
  if (!safe) {
    // Unknown tool — redact everything (fail-closed)
    return Object.fromEntries(Object.keys(args).map((k) => [k, "<redacted>"]));
  }

  const nested = SAFE_ITEM_FIELDS[toolName];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!safe.has(key)) {
      result[key] = "<redacted>";
      continue;
    }
    const allow = nested?.[key];
    result[key] = allow ? redactArrayElements(value, allow) : value;
  }
  return result;
}

export interface AuditEntry {
  audit: true;
  ts: string;
  session: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: "ok" | "error" | "denied";
  duration_ms: number;
  error?: string;
  denied?: string;
}

export function auditLog(entry: AuditEntry): void {
  console.error(JSON.stringify(entry));
}
