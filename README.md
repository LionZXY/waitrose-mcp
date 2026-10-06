waitrose-mcp
============

MCP server for Waitrose: product search, trolley management, delivery / Click & Collect slots, and orders. Deployed in the `claude-waitrose-mcp`
namespace of the home k3s cluster; see `claude-waitrose-mcp/` in
[zuzak/kube](https://github.com/zuzak/kube) for manifests.

## Tools

### Product search (anonymous)

These work without credentials (the upstream client uses `customerId: "-1"`
when not logged in).

| Tool | Purpose |
|---|---|
| `search_products` | Free-text product search, with optional sort/pagination/filter-tag parameters |
| `list_categories` | List sub-categories under a category (top-level aisles by default) |
| `browse_products` | Browse a category path or id (e.g. `groceries/bakery/bread`) |
| `get_products_by_line_numbers` | Look up specific products by their line number |
| `get_promotion_products` | List products on a given promotion |

### Trolley (authenticated)

| Tool | Purpose |
|---|---|
| `get_trolley` | Current trolley. `summary.items` lists each line with name, size, quantity/uom, shelf price, unit price and line total; `summary` also has the estimated total, delivery charge, savings and whether the minimum spend is met |
| `add_to_trolley` | Set a product's quantity in the trolley, by `lineNumber` (`"088411"`) or search-result `productId` (`"088411-45361-45362"`) |
| `update_trolley_items` | Bulk set quantities (0 removes); replacement, not additive |
| `remove_from_trolley` | Remove one line (zeroes it with its own unit of measure, so weighed KGM lines work) |
| `empty_trolley` | Remove everything from the trolley |

Trolley writes are guarded by the caps in `src/safety.ts`
(`WAITROSE_MAX_QTY_PER_LINE`, default 5; `WAITROSE_MAX_BASKET_ITEMS`, default 50;
`WAITROSE_MAX_BASKET_VALUE_GBP`, default 200).

### Delivery & Click and Collect slots (authenticated)

| Tool | Purpose |
|---|---|
| `list_delivery_addresses` | Saved addresses. Pass an `id` as `addressId` for delivery slots |
| `find_branches` | Branches for a postcode. `COLLECTION` (default) gives nearby Click & Collect stores with distance; `DELIVERY` gives the branch that delivers there |
| `list_slots` | Slots over a date range (default today + 3 days, max 14): `slotId`, date, start/end, status, charge. Available slots only unless `availableOnly: false` |
| `list_slot_dates` / `list_slot_days` | Lower-level slot calendar / raw slot grid |
| `get_current_slot` | The slot reserved for the trolley, including `slotReservationId` and expiry, or `null` if there isn't one |
| `book_slot` | Reserve a slot by `slotId` from `list_slots`. Needs `confirm: true`. Won't replace an existing reservation unless `replaceExisting: true` |
| `cancel_slot` | Release the reserved slot (the website's "Cancel slot"). Needs `confirm: true` |

`slotType` is `DELIVERY` or `GROCERY_COLLECTION` (Click & Collect).
`COLLECTION` is accepted as an alias. `ENTERTAINING_COLLECTION` is the separate
entertaining service. If you leave out `addressId`, delivery uses the
account's contact address (or the first saved address). If you leave out
`branchId`, collection uses the account's default branch. The response always
shows which one was used.

A typical flow:

```
list_slots { slotType: "DELIVERY", fromDate: "2026-10-12", days: 2 }
  → { addressId: "123", days: [{ date, slots: [{ slotId: "2026-10-12_08:00_09:00", charge: {amount: 4}, ... }] }] }
book_slot  { slotType: "DELIVERY", slotId: "2026-10-12_08:00_09:00", addressId: "123", confirm: true }
get_current_slot {}            → { slotType, startDateTime, expiryDateTime, slotReservationId, ... }
cancel_slot { confirm: true }  → { cancelled: true, currentSlot: null }
```

A reserved slot is held until checkout, or until `expiryDateTime` (about two
hours later). No tool here checks out or places an order.

### Orders and account (authenticated)

| Tool | Purpose |
|---|---|
| `get_pending_orders` / `get_previous_orders` / `get_order` | Order history and detail |
| `cancel_order`, `initiate_amend_order`, `cancel_amend_order` | Order lifecycle |
| `get_shopping_context`, `get_account_info`, `get_campaigns` | Session/account info |

### How the Waitrose APIs are used

- GraphQL is `POST https://www.waitrose.com/api/graphql-prod/graph/live`.
  Logging in uses the `generateSession` mutation (the Android-app client id),
  which returns an access token that lasts about 15 minutes, plus
  `customerOrderId`, the id of the open trolley/order. Every later call sends
  `Authorization: Bearer <token>`.
- Trolley: `getTrolley(orderId)`, `updateTrolleyItems(orderId, trolleyItems)`
  and `emptyTrolley(orderId)`. A quantity of 0 removes a line.
- Slots: `slotDates`, `slotDays` (`size` = number of days), `currentSlot`,
  `bookSlot` and `cancelSlot(slotReservationId)`. Every call needs
  `customerOrderId`. Delivery queries need `addressId`; collection queries need
  `branchId`. `bookSlot` has no slot-id argument: a slot is identified by
  `slotType` + `startDateTime`/`endDateTime` + address/branch, with
  `expectedSlotCharge` (Waitrose rejects the booking if the charge has
  changed). That's why `book_slot` re-reads the slot grid before booking.
- Branch finder (REST):
  `GET /api/branch-prod/v4/branches?fulfilment_type=COLLECTION|DELIVERY&location=<postcode>[&service_type=GROCERY]`.
- Token expiry: the client logs in again shortly before the token expires, and
  also once after any HTTP 401. Credentials stay in memory only.

## Auth

The server logs in at startup when `WAITROSE_USERNAME` (or its alias
`WAITROSE_EMAIL`) and `WAITROSE_PASSWORD` are set. Without them it runs
anonymously, and the authenticated tools return a clear "not authenticated"
error. The username is never logged.

## Local development

```
npm install
npm run build
PORT=8080 node build/index.js
```

## Endpoints

- `POST /mcp` — MCP streamable HTTP request channel
- `GET /mcp` — MCP SSE fallback channel (requires `Mcp-Session-Id` header)
- `GET /healthz` — liveness probe
- `GET /` — service info

## Credits

Vendors [jonastemplestein/waitrose](https://github.com/jonastemplestein/waitrose)
(MIT) as `src/waitrose.ts`. HTTP transport pattern adapted from
[saya6k/mcp-grocy-api](https://github.com/saya6k/mcp-grocy-api) (MIT).
