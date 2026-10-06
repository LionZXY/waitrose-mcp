#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import WaitroseClient from "./waitrose.js";
import { startHttpServer } from "./http-server.js";
import { toolCallsTotal, toolCallDuration, sessionAuthenticated } from "./metrics.js";
import { redactArgs, auditLog } from "./audit.js";
import { CapError } from "./safety.js";
import { DeniedError } from "./rate-limiter.js";
import { dispatchTrolleyTool, isTrolleyTool } from "./trolley-tools.js";
import { dispatchOrderTool, isOrderTool } from "./order-tools.js";
import { dispatchAccountTool, isAccountTool } from "./account-tools.js";
import { dispatchSlotTool, isSlotTool, SLOT_TYPE_VALUES } from "./slot-tools.js";

const VERSION = "0.1.0";
const SERVER_NAME = "waitrose-mcp";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

// A single shared client — stateless for anonymous use. Each tool call
// issues a fresh HTTP request; there is no per-session client state.
const client = new WaitroseClient();

// Auth.
// If credentials are provided, log in at startup; otherwise remain
// anonymous (the upstream client falls back to customerId "-1" for
// anonymous product search and browse). Authenticated tools (trolley,
// orders, slots, account) check client.isAuthenticated() and return a
// clear "not authenticated" error when it is false.
// WAITROSE_EMAIL is accepted as an alias for WAITROSE_USERNAME.
const username = process.env.WAITROSE_USERNAME || process.env.WAITROSE_EMAIL;
const password = process.env.WAITROSE_PASSWORD;

if (username && password) {
  try {
    await client.login(username, password);
    sessionAuthenticated.set(1);
    // Don't log the username/email — it's PII and ends up in container logs.
    console.error("[INIT] Authenticated with Waitrose");
  } catch (err) {
    console.error("[INIT] Login failed:", err);
    process.exit(1);
  }
} else {
  sessionAuthenticated.set(0);
  console.error("[INIT] Running anonymously (no WAITROSE_USERNAME/WAITROSE_PASSWORD)");
}

const SORT_BY_VALUES = [
  "RELEVANCE",
  "PRICE_LOW_2_HIGH",
  "PRICE_HIGH_2_LOW",
  "A_2_Z",
  "Z_2_A",
  "TOP_RATED",
  "MOST_POPULAR",
  "CATEGORY_RANKING",
] as const;

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return JSON.stringify({ error: "Failed to serialise response" });
  }
}

function toolError(message: string) {
  return {
    content: [{ type: "text", text: safeJson({ error: message }) }],
    isError: true,
  };
}

// Per-session Server factory. The @modelcontextprotocol/sdk Server class
// can only be connected to one transport at a time; connecting the same
// instance to multiple transports throws "Already connected to a transport".
// claude.ai creates a new MCP session per conversation, so each session
// needs its own Server. Tool handlers themselves are stateless, so
// creating new handlers per session is cheap.
function createMcpServer(): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_products",
        description:
          "Search Waitrose products by free-text query. Returns product names, prices, sizes, and other details. Works without authentication.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search term, e.g. 'feta' or 'organic milk'",
            },
            sortBy: {
              type: "string",
              enum: SORT_BY_VALUES,
              description: "Sort order (default: RELEVANCE)",
            },
            size: {
              type: "number",
              description: "Number of results (default: 24, max: 128)",
            },
            start: {
              type: "number",
              description: "Pagination offset, 0-based (default: 0)",
            },
            filterTags: {
              type: "array",
              description:
                "Optional filters, each { group, value } e.g. { group: 'dietary', value: 'vegan' }",
              items: {
                type: "object",
                properties: {
                  group: { type: "string" },
                  value: { type: "string" },
                },
                required: ["group", "value"],
              },
            },
          },
          required: ["query"],
        },
      },
      {
        name: "list_categories",
        description:
          "List the sub-categories under a Waitrose category. Returns each child category's display name, numeric categoryId, and product count. Call with no argument for the top-level grocery aisles. Pass a categoryId from a previous response to drill into a subcategory. Pass the categoryId to browse_products to fetch products in that category.",
        inputSchema: {
          type: "object",
          properties: {
            categoryId: {
              type: "string",
              description:
                "Numeric Waitrose category id (default: '10051' for top-level groceries). Pass a categoryId from a previous list_categories response to drill in.",
            },
          },
        },
      },
      {
        name: "browse_products",
        description:
          "Browse Waitrose products by category path. Returns products in that category. Works without authentication.",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description:
                "Category path or numeric categoryId. Pass a categoryId from list_categories to browse products in that category. Slash-separated paths (e.g. 'groceries/bakery/bread') are also accepted.",
            },
            sortBy: {
              type: "string",
              enum: SORT_BY_VALUES,
              description: "Sort order (default: RELEVANCE)",
            },
            size: {
              type: "number",
              description: "Number of results (default: 24, max: 128)",
            },
            start: {
              type: "number",
              description: "Pagination offset, 0-based (default: 0)",
            },
          },
          required: ["category"],
        },
      },
      {
        name: "get_products_by_line_numbers",
        description:
          "Look up specific Waitrose products by their line number(s). Returns full product details. Works without authentication.",
        inputSchema: {
          type: "object",
          properties: {
            lineNumbers: {
              type: "array",
              description: "One or more Waitrose product line numbers",
              items: { type: "string" },
            },
          },
          required: ["lineNumbers"],
        },
      },
      {
        name: "get_promotion_products",
        description:
          "List Waitrose products on a given promotion. Works without authentication.",
        inputSchema: {
          type: "object",
          properties: {
            promotionId: {
              type: "string",
              description: "Promotion identifier",
            },
            sortBy: {
              type: "string",
              enum: SORT_BY_VALUES,
              description: "Sort order (default: RELEVANCE)",
            },
            size: {
              type: "number",
              description: "Number of results (default: 24, max: 128)",
            },
            start: {
              type: "number",
              description: "Pagination offset, 0-based (default: 0)",
            },
          },
          required: ["promotionId"],
        },
      },
      {
        name: "get_trolley",
        description:
          "Get the current trolley (basket). `summary.items` lists each line with product name, size, quantity, unit and line prices; `summary` also carries the estimated total, delivery charge, savings, and whether the minimum-spend threshold is met. The raw upstream response follows. Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "add_to_trolley",
        description:
          "Add a single product (by Waitrose line number or product id) to the active trolley, setting that line's quantity. Returns the updated trolley state. Requires authentication. Refused if quantity meets WAITROSE_MAX_QTY_PER_LINE, or if pre-state basket totals meet the configured caps.",
        inputSchema: {
          type: "object",
          properties: {
            lineNumber: {
              type: "string",
              description: "Waitrose product line number (e.g. '088411'). Either lineNumber or productId is required.",
            },
            productId: {
              type: "string",
              description: "Product id from search results (e.g. '088411-45361-45362'); its first segment is the line number",
            },
            quantity: {
              type: "number",
              description: "Quantity to set on this line (replacement, not delta). Default: 1",
            },
            uom: {
              type: "string",
              enum: ["C62", "KGM", "GRM"],
              description: "Unit of measure: C62 (each, default), KGM (kilograms), GRM (grams)",
            },
          },
        },
      },
      {
        name: "remove_from_trolley",
        description:
          "Remove a single line from the active trolley (works for weighed KGM lines too). Returns the updated trolley state. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            lineNumber: {
              type: "string",
              description: "Waitrose product line number to remove. Either lineNumber or productId is required.",
            },
            productId: {
              type: "string",
              description: "Product id (e.g. '088411-45361-45362') as an alternative to lineNumber",
            },
          },
        },
      },
      {
        name: "update_trolley_items",
        description:
          "Bulk update trolley lines — set quantity (0 to remove) for one or more line numbers in a single call. Replacement semantics, not additive. Requires authentication. Refused if any input quantity meets WAITROSE_MAX_QTY_PER_LINE, or if pre-state basket totals meet the configured caps.",
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              description: "List of items to set on the trolley",
              items: {
                type: "object",
                properties: {
                  lineNumber: { type: "string" },
                  quantity: { type: "number", description: "Set 0 to remove the line" },
                  uom: {
                    type: "string",
                    enum: ["C62", "KGM", "GRM"],
                    description: "Default: C62",
                  },
                  noteToShopper: { type: "string" },
                  canSubstitute: { type: "boolean" },
                },
                required: ["lineNumber", "quantity"],
              },
            },
          },
          required: ["items"],
        },
      },
      {
        name: "empty_trolley",
        description:
          "Empty the entire trolley. Returns the (now empty) trolley state. Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_pending_orders",
        description:
          "List pending (upcoming) Waitrose orders — placed but not yet delivered. Returns order IDs, statuses, slot times, and estimated totals. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum orders to return (default: 10, max: 128)",
            },
          },
        },
      },
      {
        name: "get_previous_orders",
        description:
          "List past (completed or cancelled) Waitrose orders. Returns order IDs, statuses, slot times, and totals. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum orders to return (default: 10, max: 128)",
            },
          },
        },
      },
      {
        name: "get_order",
        description:
          "Get full detail for a specific Waitrose order by ID — order lines, slot, totals, payment info, substitutions status. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            customerOrderId: {
              type: "string",
              description: "Order ID from get_pending_orders or get_previous_orders",
            },
          },
          required: ["customerOrderId"],
        },
      },
      {
        name: "cancel_order",
        description:
          "Cancel a placed Waitrose order. Cannot be undone via the API — a re-place would require building a fresh basket. Use only when the customer has explicitly confirmed cancellation of the specific order ID. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            customerOrderId: {
              type: "string",
              description: "Order ID to cancel",
            },
          },
          required: ["customerOrderId"],
        },
      },
      {
        name: "initiate_amend_order",
        description:
          "Open an amendment session against a placed order. After this call, the active trolley mirrors the order's items — trolley write tools (add_to_trolley, update_trolley_items, etc.) modify the placed order rather than a fresh basket. Close the amend via the Waitrose website or cancel_amend_order. There is no API method to programmatically commit an amend; Waitrose closes it at the slot day. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            customerOrderId: {
              type: "string",
              description: "Order ID to start amending",
            },
          },
          required: ["customerOrderId"],
        },
      },
      {
        name: "cancel_amend_order",
        description:
          "Discard an in-progress order amendment, reverting the trolley to the original placed order state. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            customerOrderId: {
              type: "string",
              description: "Order ID whose amendment session to cancel",
            },
          },
          required: ["customerOrderId"],
        },
      },
      {
        name: "get_shopping_context",
        description:
          "Get the current shopping session context — customer ID, active order ID, order state, and default branch. Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_account_info",
        description:
          "Get the authenticated customer's account profile and myWaitrose membership details. Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_campaigns",
        description:
          "List active Waitrose marketing campaigns (promotional periods with start/end dates). Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_current_slot",
        description:
          "Get the delivery or collection slot currently reserved for the trolley (type, branch/address, start/end, expiry, order cut-off, charge, slotReservationId). Returns null if no slot is reserved. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            postcode: {
              type: "string",
              description: "Postcode to check slot availability for (optional; defaults to account address)",
            },
          },
        },
      },
      {
        name: "list_delivery_addresses",
        description:
          "List the account's saved addresses. Use an address id as addressId for delivery slot tools. Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "find_branches",
        description:
          "Find Waitrose branches for a postcode or town. fulfilmentType COLLECTION (default) lists nearby Click & Collect branches with distance — pass a branch id as branchId to the slot tools; DELIVERY returns the branch that delivers to that postcode. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            postcode: {
              type: "string",
              description: "UK postcode or town, e.g. 'SW1A 1AA'",
            },
            fulfilmentType: {
              type: "string",
              enum: ["COLLECTION", "DELIVERY"],
              description: "Default: COLLECTION",
            },
          },
          required: ["postcode"],
        },
      },
      {
        name: "list_slots",
        description:
          "List delivery or Click & Collect slots over a date range — date, start/end time, status, charge and slotId for each. Delivery uses addressId (defaults to the account's address); collection uses branchId (defaults to the account's default branch; see find_branches). Pass a slotId (with the returned addressId/branchId) to book_slot. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            slotType: {
              type: "string",
              enum: SLOT_TYPE_VALUES,
              description: "DELIVERY, or GROCERY_COLLECTION for Click & Collect (COLLECTION is accepted as an alias). ENTERTAINING_COLLECTION is the separate entertaining service.",
            },
            fromDate: {
              type: "string",
              description: "First date, YYYY-MM-DD (default: today, UK time)",
            },
            days: {
              type: "number",
              description: "Number of days to return (default: 3, max: 14)",
            },
            addressId: {
              type: "string",
              description: "Delivery address id from list_delivery_addresses (delivery only)",
            },
            branchId: {
              type: "string",
              description: "Branch id from find_branches (collection only)",
            },
            availableOnly: {
              type: "boolean",
              description: "Only include AVAILABLE slots (default: true)",
            },
          },
          required: ["slotType"],
        },
      },
      {
        name: "list_slot_dates",
        description:
          "List dates that have delivery or collection slots. Returns date IDs and day-of-week labels. Use list_slots (or list_slot_days) for the actual time windows. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            slotType: {
              type: "string",
              enum: SLOT_TYPE_VALUES,
              description: "DELIVERY or GROCERY_COLLECTION (COLLECTION is an alias)",
            },
            branchId: {
              type: "string",
              description: "Branch ID (collection; defaults to the account's default branch)",
            },
            addressId: {
              type: "string",
              description: "Delivery address ID (delivery; defaults to the account's address)",
            },
          },
          required: ["slotType"],
        },
      },
      {
        name: "list_slot_days",
        description:
          "Raw slot grid from a given date — slot IDs, start/end times, status, and charge per day. list_slots returns the same data in a flatter shape. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            slotType: {
              type: "string",
              enum: SLOT_TYPE_VALUES,
              description: "DELIVERY or GROCERY_COLLECTION (COLLECTION is an alias)",
            },
            fromDate: {
              type: "string",
              description: "Date to fetch slots from, YYYY-MM-DD (e.g. 2026-05-14)",
            },
            days: {
              type: "number",
              description: "Number of days (default: 1, max: 14)",
            },
            branchId: {
              type: "string",
              description: "Branch ID (collection; defaults to the account's default branch)",
            },
            addressId: {
              type: "string",
              description: "Delivery address ID (delivery; defaults to the account's address)",
            },
          },
          required: ["slotType", "fromDate"],
        },
      },
      {
        name: "book_slot",
        description:
          "Reserve a delivery or collection slot for the trolley. Use only when the user has confirmed the specific slot — slots are scarce; do not call speculatively. The reservation is held until checkout or expiry and can be released with cancel_slot. Refuses to replace an already-reserved slot unless replaceExisting is true. Does not check out or place an order. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            slotId: {
              type: "string",
              description: "Slot ID from list_slots / list_slot_days, e.g. '2026-10-12_08:00_09:00'",
            },
            slotType: {
              type: "string",
              enum: SLOT_TYPE_VALUES,
              description: "Must match the slot type the slot was listed with",
            },
            addressId: {
              type: "string",
              description: "Delivery address ID (required for DELIVERY — use the addressId returned by list_slots)",
            },
            branchId: {
              type: "string",
              description: "Branch ID for collection (defaults to the account's default branch)",
            },
            replaceExisting: {
              type: "boolean",
              description: "Allow replacing a slot that is already reserved (default: false)",
            },
            confirm: {
              type: "boolean",
              description: "Must be true — explicit acknowledgement that this reserves a slot",
            },
          },
          required: ["slotId", "slotType", "confirm"],
        },
      },
      {
        name: "cancel_slot",
        description:
          "Release the slot currently reserved for the trolley (the website's 'Cancel slot'). Does not affect placed orders. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            slotReservationId: {
              type: "string",
              description: "Reservation to cancel (optional; defaults to the current slot's slotReservationId)",
            },
            confirm: {
              type: "boolean",
              description: "Must be true — explicit acknowledgement that this releases the slot",
            },
          },
          required: ["confirm"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const sessionId = (request as any)._meta?.sessionId ?? "unknown";
    const startMs = Date.now();
    const endTimer = toolCallDuration.startTimer({ tool: toolName });

    const finish = (outcome: "ok" | "error" | "denied", errorMsg?: string) => {
      endTimer();
      toolCallsTotal.inc({ tool: toolName, outcome });
      auditLog({
        audit: true,
        ts: new Date().toISOString(),
        session: sessionId,
        tool: toolName,
        args: redactArgs(toolName, args),
        outcome,
        duration_ms: Date.now() - startMs,
        ...(errorMsg && outcome === "denied" ? { denied: errorMsg } : {}),
        ...(errorMsg && outcome === "error" ? { error: errorMsg } : {}),
      });
    };

    try {
      let result: { content: Array<{ type: string; text: string }> };

      switch (toolName) {
        case "search_products": {
          const query = args.query;
          if (typeof query !== "string" || !query) {
            throw new McpError(ErrorCode.InvalidParams, "query is required");
          }
          const data = await client.searchProducts(query, {
            sortBy: args.sortBy as any,
            size: args.size as number | undefined,
            start: args.start as number | undefined,
            filterTags: args.filterTags as any,
          });
          result = { content: [{ type: "text", text: safeJson(data) }] };
          break;
        }

        case "browse_products": {
          const category = args.category;
          if (typeof category !== "string" || !category) {
            throw new McpError(ErrorCode.InvalidParams, "category is required");
          }
          const data = await client.browseProducts(category, {
            sortBy: args.sortBy as any,
            size: args.size as number | undefined,
            start: args.start as number | undefined,
          });
          result = { content: [{ type: "text", text: safeJson(data) }] };
          break;
        }

        case "list_categories": {
          const categoryId = args.categoryId;
          if (categoryId !== undefined && (typeof categoryId !== "string" || !categoryId)) {
            throw new McpError(ErrorCode.InvalidParams, "categoryId must be a non-empty string when provided");
          }
          const data = await client.getCategoryNavigation(categoryId as string | undefined);
          result = { content: [{ type: "text", text: safeJson(data) }] };
          break;
        }

        case "get_products_by_line_numbers": {
          const lineNumbers = args.lineNumbers;
          if (
            !Array.isArray(lineNumbers) ||
            lineNumbers.length === 0 ||
            !lineNumbers.every((n) => typeof n === "string")
          ) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "lineNumbers must be a non-empty array of strings",
            );
          }
          const data = await client.getProductsByLineNumbers(lineNumbers as string[]);
          result = { content: [{ type: "text", text: safeJson(data) }] };
          break;
        }

        case "get_promotion_products": {
          const promotionId = args.promotionId;
          if (typeof promotionId !== "string" || !promotionId) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "promotionId is required",
            );
          }
          const data = await client.getPromotionProducts(promotionId, {
            sortBy: args.sortBy as any,
            size: args.size as number | undefined,
            start: args.start as number | undefined,
          });
          result = { content: [{ type: "text", text: safeJson(data) }] };
          break;
        }

        default:
          if (isTrolleyTool(toolName)) {
            const data = await dispatchTrolleyTool(client, toolName, args);
            result = { content: [{ type: "text", text: safeJson(data) }] };
            break;
          }
          if (isOrderTool(toolName)) {
            const data = await dispatchOrderTool(client, toolName, args);
            result = { content: [{ type: "text", text: safeJson(data) }] };
            break;
          }
          if (isAccountTool(toolName)) {
            const data = await dispatchAccountTool(client, toolName, args);
            result = { content: [{ type: "text", text: safeJson(data) }] };
            break;
          }
          if (isSlotTool(toolName)) {
            const data = await dispatchSlotTool(client, toolName, args);
            result = { content: [{ type: "text", text: safeJson(data) }] };
            break;
          }
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${toolName}`,
          );
      }

      finish("ok");
      return result;
    } catch (err) {
      if (err instanceof McpError) {
        finish("error", err.message);
        throw err;
      }
      if (err instanceof CapError || err instanceof DeniedError) {
        const msg = err.message;
        finish("denied", msg);
        return toolError(msg);
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] Tool ${toolName} failed:`, msg);
      finish("error", msg);
      return toolError(msg);
    }
  });

  server.onerror = (error) => console.error("[MCP Error]", error);

  return server;
}

process.on("SIGINT", () => {
  process.exit(0);
});

startHttpServer(createMcpServer, PORT, { name: SERVER_NAME, version: VERSION });

console.error(`[INIT] ${SERVER_NAME} v${VERSION} listening on port ${PORT}`);
