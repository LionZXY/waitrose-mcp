import { upstreamCallsTotal, reauthsTotal } from "./metrics.js";
import { auditLog } from "./audit.js";
import { TokenBucket, rateLimiterFromEnv } from "./rate-limiter.js";

/**
 * Waitrose API Client
 *
 * TypeScript client for the Waitrose grocery API.
 * Reverse-engineered from the Waitrose Android app v3.9.1.
 * 
 * Usage:
 *   const client = new WaitroseClient();
 *   await client.login(username, password);
 *   const trolley = await client.getTrolley();
 */

const GRAPHQL_URL = "https://www.waitrose.com/api/graphql-prod/graph/live";
const SEARCH_API_URL = "https://www.waitrose.com/api/content-prod/v2/cms/publish/productcontent";
const PRODUCTS_API_URL = "https://www.waitrose.com/api/products-prod/v1/products";
const BRANCH_API_URL = "https://www.waitrose.com/api/branch-prod/v4/branches";
const CLIENT_ID = "ANDROID_APP";
/** Re-login this long before the access token's advertised expiry. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

// LOCAL PATCH (not upstream): the REST API rejects requests with no Authorization
// header (HTTP 401). Real anonymous traffic from waitrose.com carries
// "Authorization: Bearer unauthenticated". We inject that when no access token
// is set.
const ANONYMOUS_BEARER = "unauthenticated";

/** Thrown specifically on HTTP 401 so callers can detect auth failures. */
class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// ============================================================================
// GraphQL Operations
// ============================================================================

const QUERIES = {
  // Session
  NewSession: `mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }`,
  
  RefreshSession: `mutation RefreshSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }`,
  
  DeleteSession: `mutation DeleteSession { deleteSession }`,
  
  // Shopping Context
  GetShoppingContext: `query GetShoppingContext { shoppingContext { customerId customerOrderId customerOrderState defaultBranchId } }`,
  
  // Account
  GetAccountInfoAndMembership: `query GetAccountInfoAndMembership { getAccountProfile { id email contactAddress { __typename ...ContactAddress } } getMemberships { memberships { number type } } }  fragment Addressee on Addressee { title firstName lastName contactNumber }  fragment ContactAddress on Address { id line1 line2 line3 town region country postalCode addressee { __typename ...Addressee } }`,
  
  // Trolley
  GetTrolley: `query GetTrolley($orderId: ID!) { getTrolley(orderId: $orderId) { checkoutReadiness { __typename ...CheckoutReadiness } products { __typename ...TrolleyProduct } slotChangeable trolley { __typename ...TrolleyResponse } instantCheckout failures { __typename ...TrolleyFailure } } }  fragment CheckoutReadiness on CheckoutReadiness { slotTypeValid }  fragment TrolleyProductCategory on TrolleyProductCategory { id name }  fragment TrolleyPrice on Price { amount currencyCode }  fragment Quantity on Quantity { amount uom }  fragment QuantityPrice on QuantityPrice { price { __typename ...TrolleyPrice } quantity { __typename ...Quantity } }  fragment Hfss on Hfss { status }  fragment ProductImage on ProductImage { extraLarge large medium small }  fragment Group on Group { name }  fragment TrolleyProductPromotion on TrolleyProductPromotion { groups { __typename ...Group } myWaitrosePromotion promotionDescription promotionExpiryDate promotionId promotionTypeCode promotionUnitPrice { __typename ...TrolleyPrice } promotionalPricePerUnit discount { type } hidden }  fragment AvailableDate on AvailableDate { startDate endDate }  fragment Restriction on Restriction { availableDates { __typename ...AvailableDate } }  fragment ProductReview on ProductReview { averageRating reviewCount }  fragment ProductServings on ProductServings { max min }  fragment ProductWeight on ProductWeight { uoms }  fragment TrolleyProduct on TrolleyProduct { categories { __typename ...TrolleyProductCategory } currentSaleUnitPrice { __typename ...QuantityPrice } defaultQuantity { __typename ...Quantity } displayPrice displayPriceEstimated displayPriceQualifier formattedPriceRange formattedWeightRange hfss { __typename ...Hfss } id leadTime lineNumber maxPersonalisedMessageLength name brandName productImageUrls { __typename ...ProductImage } productType promotions { __typename ...TrolleyProductPromotion } restriction { __typename ...Restriction } reviews { __typename ...ProductReview } servings { __typename ...ProductServings } substitutionsProhibited size thumbnail weights { __typename ...ProductWeight } depositCharge { __typename ...TrolleyPrice } }  fragment SlotOptionDatesType on SlotOptionDatesType { date type }  fragment Conflict on Conflict { productId lineNumber messages priority outOfStock resolutionActions prohibitedActions itemId type slotOptionDates { __typename ...SlotOptionDatesType } }  fragment TrolleyItem on TrolleyItem { canSubstitute lineNumber noteToShopper personalisedMessage quantity { __typename ...Quantity } reservedQuantity totalPrice { __typename ...TrolleyPrice } triggeredPromotions trolleyItemId untriggeredPromotions }  fragment TrolleyItemCounts on TrolleyItemCounts { hardConflicts noConflicts softConflicts }  fragment TrolleyTotals on TrolleyTotals { collectionMinimumOrderValue { __typename ...TrolleyPrice } deliveryCharge { __typename ...TrolleyPrice } deliveryMinimumOrderValue { __typename ...TrolleyPrice } itemTotalEstimatedCost { __typename ...TrolleyPrice } minimumSpendThresholdMet savingsFromOffers { __typename ...TrolleyPrice } savingsFromMyWaitrose { __typename ...TrolleyPrice } totalDepositCharge { __typename ...TrolleyPrice } totalEstimatedCost { __typename ...TrolleyPrice } trolleyItemCounts { __typename ...TrolleyItemCounts } }  fragment TrolleyResponse on TrolleyResponse { amendingOrder conflicts { __typename ...Conflict } orderId trolleyItems { __typename ...TrolleyItem } trolleyTotals { __typename ...TrolleyTotals } }  fragment TrolleyFailure on TrolleyFailure { message type }`,
  
  UpdateTrolleyItems: `mutation UpdateTrolleyItems($trolleyItemsInput: [TrolleyItemInput!], $orderId: ID!) { updateTrolleyItems(trolleyItems: $trolleyItemsInput, orderId: $orderId) { products { __typename ...TrolleyProduct } trolley { __typename ...TrolleyResponse } instantCheckout failures { __typename ...TrolleyFailure } } }  fragment TrolleyProductCategory on TrolleyProductCategory { id name }  fragment TrolleyPrice on Price { amount currencyCode }  fragment Quantity on Quantity { amount uom }  fragment QuantityPrice on QuantityPrice { price { __typename ...TrolleyPrice } quantity { __typename ...Quantity } }  fragment Hfss on Hfss { status }  fragment ProductImage on ProductImage { extraLarge large medium small }  fragment Group on Group { name }  fragment TrolleyProductPromotion on TrolleyProductPromotion { groups { __typename ...Group } myWaitrosePromotion promotionDescription promotionExpiryDate promotionId promotionTypeCode promotionUnitPrice { __typename ...TrolleyPrice } promotionalPricePerUnit discount { type } hidden }  fragment AvailableDate on AvailableDate { startDate endDate }  fragment Restriction on Restriction { availableDates { __typename ...AvailableDate } }  fragment ProductReview on ProductReview { averageRating reviewCount }  fragment ProductServings on ProductServings { max min }  fragment ProductWeight on ProductWeight { uoms }  fragment TrolleyProduct on TrolleyProduct { categories { __typename ...TrolleyProductCategory } currentSaleUnitPrice { __typename ...QuantityPrice } defaultQuantity { __typename ...Quantity } displayPrice displayPriceEstimated displayPriceQualifier formattedPriceRange formattedWeightRange hfss { __typename ...Hfss } id leadTime lineNumber maxPersonalisedMessageLength name brandName productImageUrls { __typename ...ProductImage } productType promotions { __typename ...TrolleyProductPromotion } restriction { __typename ...Restriction } reviews { __typename ...ProductReview } servings { __typename ...ProductServings } substitutionsProhibited size thumbnail weights { __typename ...ProductWeight } depositCharge { __typename ...TrolleyPrice } }  fragment SlotOptionDatesType on SlotOptionDatesType { date type }  fragment Conflict on Conflict { productId lineNumber messages priority outOfStock resolutionActions prohibitedActions itemId type slotOptionDates { __typename ...SlotOptionDatesType } }  fragment TrolleyItem on TrolleyItem { canSubstitute lineNumber noteToShopper personalisedMessage quantity { __typename ...Quantity } reservedQuantity totalPrice { __typename ...TrolleyPrice } triggeredPromotions trolleyItemId untriggeredPromotions }  fragment TrolleyItemCounts on TrolleyItemCounts { hardConflicts noConflicts softConflicts }  fragment TrolleyTotals on TrolleyTotals { collectionMinimumOrderValue { __typename ...TrolleyPrice } deliveryCharge { __typename ...TrolleyPrice } deliveryMinimumOrderValue { __typename ...TrolleyPrice } itemTotalEstimatedCost { __typename ...TrolleyPrice } minimumSpendThresholdMet savingsFromOffers { __typename ...TrolleyPrice } savingsFromMyWaitrose { __typename ...TrolleyPrice } totalDepositCharge { __typename ...TrolleyPrice } totalEstimatedCost { __typename ...TrolleyPrice } trolleyItemCounts { __typename ...TrolleyItemCounts } }  fragment TrolleyResponse on TrolleyResponse { amendingOrder conflicts { __typename ...Conflict } orderId trolleyItems { __typename ...TrolleyItem } trolleyTotals { __typename ...TrolleyTotals } }  fragment TrolleyFailure on TrolleyFailure { message type }`,
  
  EmptyTrolley: `mutation EmptyTrolley($orderId: ID!) { emptyTrolley(orderId: $orderId) { products { __typename ...TrolleyProduct } trolley { __typename ...TrolleyResponse } instantCheckout failures { __typename ...TrolleyFailure } } }  fragment TrolleyProductCategory on TrolleyProductCategory { id name }  fragment TrolleyPrice on Price { amount currencyCode }  fragment Quantity on Quantity { amount uom }  fragment QuantityPrice on QuantityPrice { price { __typename ...TrolleyPrice } quantity { __typename ...Quantity } }  fragment Hfss on Hfss { status }  fragment ProductImage on ProductImage { extraLarge large medium small }  fragment Group on Group { name }  fragment TrolleyProductPromotion on TrolleyProductPromotion { groups { __typename ...Group } myWaitrosePromotion promotionDescription promotionExpiryDate promotionId promotionTypeCode promotionUnitPrice { __typename ...TrolleyPrice } promotionalPricePerUnit discount { type } hidden }  fragment AvailableDate on AvailableDate { startDate endDate }  fragment Restriction on Restriction { availableDates { __typename ...AvailableDate } }  fragment ProductReview on ProductReview { averageRating reviewCount }  fragment ProductServings on ProductServings { max min }  fragment ProductWeight on ProductWeight { uoms }  fragment TrolleyProduct on TrolleyProduct { categories { __typename ...TrolleyProductCategory } currentSaleUnitPrice { __typename ...QuantityPrice } defaultQuantity { __typename ...Quantity } displayPrice displayPriceEstimated displayPriceQualifier formattedPriceRange formattedWeightRange hfss { __typename ...Hfss } id leadTime lineNumber maxPersonalisedMessageLength name brandName productImageUrls { __typename ...ProductImage } productType promotions { __typename ...TrolleyProductPromotion } restriction { __typename ...Restriction } reviews { __typename ...ProductReview } servings { __typename ...ProductServings } substitutionsProhibited size thumbnail weights { __typename ...ProductWeight } depositCharge { __typename ...TrolleyPrice } }  fragment SlotOptionDatesType on SlotOptionDatesType { date type }  fragment Conflict on Conflict { productId lineNumber messages priority outOfStock resolutionActions prohibitedActions itemId type slotOptionDates { __typename ...SlotOptionDatesType } }  fragment TrolleyItem on TrolleyItem { canSubstitute lineNumber noteToShopper personalisedMessage quantity { __typename ...Quantity } reservedQuantity totalPrice { __typename ...TrolleyPrice } triggeredPromotions trolleyItemId untriggeredPromotions }  fragment TrolleyItemCounts on TrolleyItemCounts { hardConflicts noConflicts softConflicts }  fragment TrolleyTotals on TrolleyTotals { collectionMinimumOrderValue { __typename ...TrolleyPrice } deliveryCharge { __typename ...TrolleyPrice } deliveryMinimumOrderValue { __typename ...TrolleyPrice } itemTotalEstimatedCost { __typename ...TrolleyPrice } minimumSpendThresholdMet savingsFromOffers { __typename ...TrolleyPrice } savingsFromMyWaitrose { __typename ...TrolleyPrice } totalDepositCharge { __typename ...TrolleyPrice } totalEstimatedCost { __typename ...TrolleyPrice } trolleyItemCounts { __typename ...TrolleyItemCounts } }  fragment TrolleyResponse on TrolleyResponse { amendingOrder conflicts { __typename ...Conflict } orderId trolleyItems { __typename ...TrolleyItem } trolleyTotals { __typename ...TrolleyTotals } }  fragment TrolleyFailure on TrolleyFailure { message type }`,
  
  // Orders
  GetOrders: `query GetOrders($getPendingOrdersInput: GetOrdersInput, $getPreviousOrdersInput: GetOrdersInput, $getAmendingOrderInput: GetOrdersInput) { pendingOrders: getOrders(getOrdersInput: $getPendingOrdersInput) { content { __typename ...Order } links { rel title href } } previousOrders: getOrders(getOrdersInput: $getPreviousOrdersInput) { content { __typename ...Order } links { rel title href } } amendingOrder: getOrders(getOrdersInput: $getAmendingOrderInput) { content { __typename ...Order } } }  fragment Price on OrderPrice { amount currencyCode }  fragment OrderAddress on OrderAddress { id line1 line2 line3 postalCode town region country }  fragment OrderSlot on OrderSlot { branchId branchName branchAddress { __typename ...OrderAddress } type startDateTime endDateTime amendOrderCutoffDateTime deliveryAddress { __typename ...OrderAddress } status }  fragment Order on OrderContent { customerOrderId status created lastUpdated links { rel title href } totals { estimated { totalPrice { __typename ...Price } toPay { __typename ...Price } } actual { paid { __typename ...Price } } } slots { __typename ...OrderSlot } containsEntertainingLines orderLines { lineNumber } }`,
  
  GetPendingOrders: `query GetPendingOrders($getPendingOrdersInput: GetOrdersInput) { pendingOrders: getOrders(getOrdersInput: $getPendingOrdersInput) { content { __typename ...Order } links { rel title href } } }  fragment Price on OrderPrice { amount currencyCode }  fragment OrderAddress on OrderAddress { id line1 line2 line3 postalCode town region country }  fragment OrderSlot on OrderSlot { branchId branchName branchAddress { __typename ...OrderAddress } type startDateTime endDateTime amendOrderCutoffDateTime deliveryAddress { __typename ...OrderAddress } status }  fragment Order on OrderContent { customerOrderId status created lastUpdated links { rel title href } totals { estimated { totalPrice { __typename ...Price } toPay { __typename ...Price } } actual { paid { __typename ...Price } } } slots { __typename ...OrderSlot } containsEntertainingLines orderLines { lineNumber } }`,
  
  GetPreviousOrders: `query GetPreviousOrders($getPreviousOrdersInput: GetOrdersInput) { previousOrders: getOrders(getOrdersInput: $getPreviousOrdersInput) { content { __typename ...Order } links { rel title href } } }  fragment Price on OrderPrice { amount currencyCode }  fragment OrderAddress on OrderAddress { id line1 line2 line3 postalCode town region country }  fragment OrderSlot on OrderSlot { branchId branchName branchAddress { __typename ...OrderAddress } type startDateTime endDateTime amendOrderCutoffDateTime deliveryAddress { __typename ...OrderAddress } status }  fragment Order on OrderContent { customerOrderId status created lastUpdated links { rel title href } totals { estimated { totalPrice { __typename ...Price } toPay { __typename ...Price } } actual { paid { __typename ...Price } } } slots { __typename ...OrderSlot } containsEntertainingLines orderLines { lineNumber } }`,
  
  GetOrder: `query GetOrder($customerOrderId: String) { getOrder(customerOrderId: $customerOrderId) { customerOrderId status created lastUpdated orderLines { __typename ...OrderLine } slots { __typename ...OrderSlot } containsEntertainingLines substitutionsAllowed bagless paperStatement links { rel title href } totals { actual { paid { __typename ...Price } savings { __typename ...Price } carrierBagCharge { __typename ...Price } deliveryCharge { __typename ...Price } depositCharge { __typename ...Price } offerSavings { __typename ...Price } partnerDiscountSavings { __typename ...Price } membershipSavings { __typename ...Price } pickedPrice { __typename ...Price } } estimated { giftCards { __typename ...Price } giftVouchers { __typename ...Price } paymentCard { __typename ...Price } carrierBagCharge { __typename ...Price } deliveryCharge { __typename ...Price } depositCharge { __typename ...Price } orderLines { __typename ...Price } offerSavings { __typename ...Price } membershipSavings { __typename ...Price } incentiveSavings { __typename ...Price } totalSavings { __typename ...Price } totalPrice { __typename ...Price } toPay { __typename ...Price } } } paymentInfo { giftCards { __typename ...OrderGiftCard } giftVouchers { __typename ...OrderGiftVoucher } cardPayment { __typename ...CardPayment } } } }  fragment Quantity on Quantity { amount uom }  fragment Price on OrderPrice { amount currencyCode }  fragment PersonalisedMessage on PersonalisedInfo { message }  fragment OrderLine on OrderLine { lineNumber orderLineStatus estimatedQuantity { __typename ...Quantity } quantity { __typename ...Quantity } estimatedUnitPrice { __typename ...Price } estimatedTotalPrice { __typename ...Price } estimatedDepositCharge { __typename ...Price } estimatedPrice { __typename ...Price } price { __typename ...Price } unitPrice { __typename ...Price } depositCharge { __typename ...Price } totalPrice { __typename ...Price } substitutionAllowed noteToShopper personalisedInfos { __typename ...PersonalisedMessage } }  fragment OrderAddress on OrderAddress { id line1 line2 line3 postalCode town region country }  fragment OrderSlot on OrderSlot { branchId branchName branchAddress { __typename ...OrderAddress } type startDateTime endDateTime amendOrderCutoffDateTime deliveryAddress { __typename ...OrderAddress } status }  fragment OrderGiftCard on OrderGiftCard { serialNumber remainingBalance { __typename ...Price } amountToDeduct { __typename ...Price } }  fragment OrderGiftVoucher on OrderGiftVoucher { serialNumber status value { __typename ...Price } }  fragment CardPayment on CardPayment { cardType cardholderName maskedCardNumber startDate expiryDate businessAccount billingAddress { __typename ...OrderAddress } }`,
  
  CancelOrder: `mutation CancelOrder($input: ID!) { cancelOrder(customerOrderId: $input) { failures { __typename ...OrderFailure } } }  fragment OrderFailure on OrderFailure { type message }`,
  
  InitiateAmendOrder: `mutation InitiateAmendOrder($input: ID!) { amendOrder(customerOrderId: $input) { failures { __typename ...OrderFailure } } }  fragment OrderFailure on OrderFailure { type message }`,
  
  CancelAmendOrder: `mutation CancelAmendOrder($input: ID!) { cancelAmendOrder(customerOrderId: $input) { failures { __typename ...OrderFailure } } }  fragment OrderFailure on OrderFailure { type message }`,
  
  // Slots
  CurrentSlot: `query CurrentSlot($input: CurrentSlotInput) { currentSlot(currentSlotInput: $input) { slotType branchId addressId postcode startDateTime endDateTime expiryDateTime orderCutoffDateTime amendOrderCutoffDateTime shopByDateTime slotReservationId slotGridType greenSlot deliveryCharge { amount currencyCode } } }`,
  
  SlotDates: `query SlotDates($slotDatesInput: SlotDatesInput) { slotDates(slotDatesInput: $slotDatesInput) { content { id dayOfWeek } failures { message type } } }`,
  
  SlotDays: `query SlotDays($slotDaysInput: SlotDaysInput) { slotDays(slotDaysInput: $slotDaysInput) { content { id branchId slotType date slots { id startDateTime endDateTime shopByDateTime status slotGridType charge { currencyCode amount } greenSlot deliveryPassSlot } } failures { message type } variant } }`,
  
  BookSlot: `mutation BookSlot($input: BookSlotInput) { bookSlot(bookSlotInput: $input) { slotExpiryDateTime orderCutoffDateTime amendOrderCutoffDateTime shopByDateTime failures { type message } variant } }`,

  CancelSlot: `mutation CancelSlot($slotReservationId: ID!) { cancelSlot(slotReservationId: $slotReservationId) { failures { type message } } }`,

  // Addresses (the customer's saved delivery addresses)
  GetAddresses: `query GetAddresses { addresses { id line1 line2 line3 town region country postalCode } }`,
  
  // Campaigns
  GetCampaigns: `query GetCampaigns { campaigns { id name marketingStartDate marketingEndDate startDate endDate } }`,
};

// ============================================================================
// Types
// ============================================================================

/** GraphQL error structure */
interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
}

/** GraphQL response with errors */
type GraphQLResponse<T> = T & { errors?: GraphQLError[] };

/** Standard API failure type */
export interface ApiFailure {
  type: string;
  message: string;
}

/**
 * Slot type as understood by the Waitrose slot API. Click & Collect for
 * groceries is `GROCERY_COLLECTION` (the API rejects a bare `COLLECTION`
 * with "Invalid slot type"); `ENTERTAINING_COLLECTION` is the separate
 * entertaining/party-food collection service.
 */
export type SlotType = "DELIVERY" | "GROCERY_COLLECTION" | "ENTERTAINING_COLLECTION";

/** Accepted by the tool layer; `COLLECTION` is an alias for `GROCERY_COLLECTION`. */
export type SlotTypeInput = SlotType | "COLLECTION";

export function normaliseSlotType(slotType: SlotTypeInput): SlotType {
  return slotType === "COLLECTION" ? "GROCERY_COLLECTION" : slotType;
}

export function isCollectionSlotType(slotType: SlotType): boolean {
  return slotType !== "DELIVERY";
}

/** Standard unit of measure (C62 = "each") */
export type UnitOfMeasure = "C62" | "KGM" | "GRM";

/** Slot date with day of week */
export interface SlotDate {
  id: string;
  dayOfWeek: string;
}

/** Book slot result */
export interface BookSlotResult {
  slotExpiryDateTime: string;
  orderCutoffDateTime: string;
  amendOrderCutoffDateTime?: string;
  shopByDateTime?: string;
}

export interface Price {
  amount: number;
  currencyCode: string;
}

export interface Quantity {
  amount: number;
  uom: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  customerId: string;
  customerOrderId: string;
  customerOrderState: string;
  defaultBranchId: string;
  expiresIn: number;
}

export interface ShoppingContext {
  customerId: string;
  customerOrderId: string;
  customerOrderState: string;
  defaultBranchId: string;
}

export interface TrolleyProduct {
  id: string;
  lineNumber: string;
  name: string;
  brandName: string;
  displayPrice: string;
  size: string;
  thumbnail: string;
  productType: string;
  displayPriceQualifier?: string | null;
  currentSaleUnitPrice?: { price: Price; quantity: Quantity } | null;
}

export interface TrolleyItem {
  lineNumber: string;
  trolleyItemId: number;
  quantity: Quantity;
  totalPrice: Price;
  canSubstitute: boolean;
  noteToShopper: string | null;
}

export interface TrolleyTotals {
  totalEstimatedCost: Price;
  itemTotalEstimatedCost: Price;
  deliveryCharge: Price | null;
  savingsFromOffers: Price | null;
  savingsFromMyWaitrose: Price | null;
  minimumSpendThresholdMet?: boolean;
}

export interface Trolley {
  orderId: string;
  trolleyItems: TrolleyItem[];
  trolleyTotals: TrolleyTotals;
  conflicts: unknown[];
}

export interface TrolleyResponse {
  products: TrolleyProduct[];
  trolley: Trolley;
  failures: ApiFailure[] | null;
}

export interface OrderSlot {
  branchId: string;
  branchName: string;
  type: string;
  startDateTime: string;
  endDateTime: string;
  status: string;
}

export interface Order {
  customerOrderId: string;
  status: string;
  created: string;
  lastUpdated: string;
  slots: OrderSlot[];
  totals: {
    estimated: { totalPrice: Price; toPay: Price };
    actual: { paid: Price | null };
  };
}

export interface Slot {
  /** e.g. "2026-10-12_08:00_09:00" — date plus local start/end time */
  id: string;
  startDateTime: string;
  endDateTime: string;
  shopByDateTime: string | null;
  /** e.g. AVAILABLE, FULLY_BOOKED, UNAVAILABLE */
  status: string;
  slotGridType?: string | null;
  /** Null for collection slots (free) */
  charge: Price | null;
  greenSlot: boolean;
  deliveryPassSlot: boolean;
}

export interface SlotDay {
  id: string;
  branchId: string;
  slotType: string;
  date: string;
  slots: Slot[];
}

export interface AccountProfile {
  id: string;
  email: string;
  contactAddress: {
    id: string;
    line1: string;
    line2: string;
    line3: string;
    town: string;
    postalCode: string;
  };
}

export interface Address {
  id: string;
  line1: string | null;
  line2: string | null;
  line3: string | null;
  town: string | null;
  region: string | null;
  country: string | null;
  postalCode: string | null;
}

/** Fulfilment type accepted by the branch finder. */
export type FulfilmentType = "DELIVERY" | "COLLECTION";

export interface Branch {
  id: string;
  name: string;
  type: string;
  defaultBranch: boolean;
  /** Miles from the searched location (absent for delivery lookups) */
  distance?: number;
  carParkCollectionEnabled?: boolean;
  services: string[];
  address: {
    address1?: string;
    address2?: string;
    city?: string;
    county?: string;
    postcode?: string;
  };
  phone?: string;
}

/** Input for bookSlot — mirrors the GraphQL BookSlotInput type. */
export interface BookSlotParams {
  slotType: SlotType;
  startDateTime: string;
  endDateTime: string;
  /** Required for DELIVERY */
  addressId?: string;
  /** Required for collection slot types */
  branchId?: string;
  postcode?: string;
  /** The charge shown in the slot grid; Waitrose rejects the booking if it no longer matches. */
  expectedSlotCharge?: Price | null;
  slotGridType?: string | null;
  greenSlot?: boolean;
}

export interface Membership {
  number: string;
  type: string;
}

export interface TrolleyItemInput {
  lineNumber: string;
  quantity: { amount: number; uom: UnitOfMeasure };
  noteToShopper?: string;
  canSubstitute?: boolean;
}

export interface CurrentSlot {
  slotType: string | null;
  /** Needed to cancel/release the reservation (cancel_slot). */
  slotReservationId?: string | null;
  greenSlot?: boolean | null;
  branchId: string | null;
  addressId: string | null;
  postcode: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  expiryDateTime: string | null;
  orderCutoffDateTime: string | null;
  amendOrderCutoffDateTime: string | null;
  shopByDateTime: string | null;
  deliveryCharge: Price | null;
  slotGridType: string | null;
}

export interface OrderLine {
  lineNumber: string;
  orderLineStatus: string;
  estimatedQuantity: Quantity | null;
  quantity: Quantity | null;
  estimatedUnitPrice: Price | null;
  estimatedTotalPrice: Price | null;
  estimatedPrice: Price | null;
  price: Price | null;
  unitPrice: Price | null;
  totalPrice: Price | null;
  substitutionAllowed: boolean;
  noteToShopper: string | null;
}

export interface OrderTotals {
  estimated: {
    totalPrice: Price | null;
    toPay: Price | null;
    deliveryCharge: Price | null;
    offerSavings: Price | null;
    membershipSavings: Price | null;
  };
  actual: {
    paid: Price | null;
    savings: Price | null;
    deliveryCharge: Price | null;
  };
}

export interface OrderDetails {
  customerOrderId: string;
  status: string;
  created: string;
  lastUpdated: string;
  orderLines: OrderLine[];
  slots: OrderSlot[];
  containsEntertainingLines: boolean;
  substitutionsAllowed: boolean;
  bagless: boolean;
  totals: OrderTotals;
}

export interface Campaign {
  id: string;
  name: string;
  marketingStartDate: string;
  marketingEndDate: string;
  startDate: string;
  endDate: string;
}

// ============================================================================
// Product Search Types (REST API)
// ============================================================================

/** Sort options for product search */
export type SearchSortBy = 
  | "RELEVANCE" 
  | "PRICE_LOW_2_HIGH" 
  | "PRICE_HIGH_2_LOW" 
  | "A_2_Z" 
  | "Z_2_A"
  | "TOP_RATED"
  | "MOST_POPULAR"
  | "CATEGORY_RANKING";

/** Search tag for filtering */
export interface SearchTag {
  group: string;
  value: string;
}

/** Filter tag for filtering results */
export interface FilterTag {
  group: string;
  value: string;
}

/** Search query parameters */
export interface SearchQueryParams {
  /** Search term (for text search) */
  searchTerm?: string;
  /** Category path (for browsing) */
  category?: string;
  /** Sort order */
  sortBy?: SearchSortBy;
  /** Pagination offset (0-based) */
  start?: number;
  /** Page size (max 128 for search, 15 for orders) */
  size?: number;
  /** Search tags for filtering */
  searchTags?: SearchTag[];
  /** Filter tags for filtering */
  filterTags?: FilterTag[];
  /** Branch ID for availability */
  branchId?: string;
  /** Promotion ID to filter by promotion */
  promotionId?: string;
  /** Category level depth */
  categoryLevel?: number;
}

/** Product promotion information */
export interface ProductPromotion {
  promotionId: string;
  promotionDescription: string;
  promotionTypeCode: string;
  promotionExpiryDate?: string;
  promotionUnitPrice?: Price;
  myWaitrosePromotion: boolean;
}

/** Product review information */
export interface ProductReview {
  averageRating: number;
  reviewCount: number;
}

/** Product image URLs */
export interface ProductImageUrls {
  small?: string;
  medium?: string;
  large?: string;
  extraLarge?: string;
}

/** Product details from search results */
export interface SearchProduct {
  id: string;
  lineNumber: string;
  name: string;
  brandName?: string;
  displayPrice: string;
  displayPriceEstimated?: boolean;
  displayPriceQualifier?: string;
  formattedPriceRange?: string;
  formattedWeightRange?: string;
  size?: string;
  thumbnail?: string;
  productImageUrls?: ProductImageUrls;
  productType?: string;
  promotions?: ProductPromotion[];
  reviews?: ProductReview;
  currentSaleUnitPrice?: {
    price: Price;
    quantity: Quantity;
  };
  defaultQuantity?: Quantity;
  leadTime?: number;
  categories?: Array<{ id: string; name: string }>;
  depositCharge?: Price;
  hasDepositCharge?: boolean;
  servings?: { min?: number; max?: number };
  isHfss?: boolean;
  marketingBadges?: string[];
}

/** Favourite category in search results */
export interface FavouriteCategory {
  id: string;
  name: string;
  productCount: number;
}

/** Search results response */
export interface SearchResponse {
  products: SearchProduct[];
  totalMatches: number;
  favouriteCategories?: FavouriteCategory[];
  personalisation?: { experimentId?: string; variant?: string };
  subCategories?: RawSubCategory[];
}

/** Product details from batch lookup by line numbers */
export interface ProductDetail {
  lineNumber: string;
  name: string;
  brandName?: string;
  displayPrice?: string;
  size?: string;
  thumbnail?: string;
  productImageUrls?: ProductImageUrls;
  currentSaleUnitPrice?: {
    price: Price;
    quantity: Quantity;
  };
}

/** Category information for browsing */
export interface CategoryInfo {
  id: string;
  name: string;
  parentCategoryId?: string;
  isRootCategory?: boolean;
  childCategories?: CategoryInfo[];
  productCount?: number;
}

/** Sub-category entry returned by getCategoryNavigation. */
export interface CategoryNavEntry {
  /** Display name as shown on waitrose.com (e.g. "Fresh & Chilled"). */
  name: string;
  /** Numeric Waitrose category id — pass to list_categories to drill in, or to browse_products. */
  categoryId: string;
  /** Approximate number of products listed under this category. */
  productCount: number;
}

interface RawSubCategory {
  name: string;
  categoryId: string;
  expectedResults?: number;
  hiddenInNav?: boolean;
}

// ============================================================================
// API Client
// ============================================================================

export class WaitroseClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private customerId: string | null = null;
  private customerOrderId: string | null = null;
  private defaultBranchId: string | null = null;
  /** Epoch ms at which the current access token expires (null when unknown/anonymous). */
  private tokenExpiresAt: number | null = null;
  private readonly rateLimiter: TokenBucket;
  private _storedUsername: string | null = null;
  private _storedPassword: string | null = null;

  constructor(rateLimiter?: TokenBucket) {
    this.rateLimiter = rateLimiter ?? rateLimiterFromEnv();
  }

  /**
   * Re-authenticate once after a 401. Increments `waitrose_mcp_reauths_total`
   * and emits an audit entry. Only called when credentials are available.
   */
  private async _handleReauth(ts: string): Promise<void> {
    if (!this._storedUsername || !this._storedPassword) {
      throw new Error("No stored credentials for re-authentication");
    }
    const start = Date.now();
    try {
      await this.login(this._storedUsername, this._storedPassword);
      reauthsTotal.inc({ outcome: "ok" });
      auditLog({ audit: true, ts, session: "client", tool: "_reauth", args: {}, outcome: "ok", duration_ms: Date.now() - start });
    } catch (err) {
      reauthsTotal.inc({ outcome: "error" });
      auditLog({ audit: true, ts, session: "client", tool: "_reauth", args: {}, outcome: "error", duration_ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /**
   * Waitrose access tokens live for ~15 minutes (`expiresIn` ≈ 900s) and there
   * is no refresh-token grant on this API, so re-login shortly before expiry.
   * Doing this proactively (rather than only on 401) avoids a failed mutation
   * mid-way through a multi-step trolley/slot operation.
   */
  private async ensureFreshToken(): Promise<void> {
    if (
      this.tokenExpiresAt !== null &&
      this._storedUsername &&
      this._storedPassword &&
      Date.now() >= this.tokenExpiresAt - TOKEN_EXPIRY_SKEW_MS
    ) {
      await this._handleReauth(new Date().toISOString());
    }
  }

  /** Execute a GraphQL query/mutation — throws AuthError on 401 */
  private async graphqlOnce<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Waitrose/3.9.1 (Android)",
    };

    // LOCAL PATCH: send "Bearer unauthenticated" when no session; see ANONYMOUS_BEARER.
    headers["Authorization"] = `Bearer ${this.accessToken ?? ANONYMOUS_BEARER}`;

    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      upstreamCallsTotal.inc({ outcome: "error" });
      if (response.status === 401) throw new AuthError(`HTTP 401: ${text}`);
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const json = await response.json() as GraphQLResponse<T>;

    if (json.errors?.length) {
      upstreamCallsTotal.inc({ outcome: "error" });
      throw new Error(`GraphQL Error: ${json.errors.map(e => e.message).join(", ")}`);
    }

    upstreamCallsTotal.inc({ outcome: "ok" });
    return json as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    await this.rateLimiter.acquire();
    await this.ensureFreshToken();
    try {
      return await this.graphqlOnce<T>(query, variables);
    } catch (err) {
      if (err instanceof AuthError && this._storedUsername && this._storedPassword) {
        await this._handleReauth(new Date().toISOString());
        // Retry without acquiring a new rate-limiter token — the original token was already consumed.
        return this.graphqlOnce<T>(query, variables);
      }
      throw err;
    }
  }

  /** Execute a REST API call to the content/search API — throws AuthError on 401 */
  private async restApiOnce(
    endpoint: "search" | "browse",
    body: Record<string, unknown>
  ): Promise<SearchResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Waitrose/3.9.1 (Android)",
    };

    // LOCAL PATCH: send "Bearer unauthenticated" when no session; see ANONYMOUS_BEARER.
    headers["Authorization"] = `Bearer ${this.accessToken ?? ANONYMOUS_BEARER}`;

    // Use -1 for anonymous users, customerId for logged-in users
    const customerId = this.customerId || "-1";
    const url = `${SEARCH_API_URL}/${endpoint}/${customerId}?clientType=WEB_APP`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      upstreamCallsTotal.inc({ outcome: "error" });
      if (response.status === 401) throw new AuthError(`HTTP 401: ${text}`);
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    // The API returns products inside componentsAndProducts[].searchProduct
    const raw = await response.json() as {
      totalMatches: number;
      productsInResultset?: number;
      componentsAndProducts?: Array<{ searchProduct?: SearchProduct }>;
      subCategories?: RawSubCategory[];
    };

    const products: SearchProduct[] = [];
    if (raw.componentsAndProducts) {
      for (const item of raw.componentsAndProducts) {
        if (item.searchProduct) {
          products.push(item.searchProduct);
        }
      }
    }

    upstreamCallsTotal.inc({ outcome: "ok" });
    return {
      products,
      totalMatches: raw.totalMatches,
      subCategories: raw.subCategories,
    };
  }

  private async restApi(
    endpoint: "search" | "browse",
    body: Record<string, unknown>
  ): Promise<SearchResponse> {
    await this.rateLimiter.acquire();
    await this.ensureFreshToken();
    try {
      return await this.restApiOnce(endpoint, body);
    } catch (err) {
      if (err instanceof AuthError && this._storedUsername && this._storedPassword) {
        await this._handleReauth(new Date().toISOString());
        // Retry without acquiring a new rate-limiter token — the original token was already consumed.
        return this.restApiOnce(endpoint, body);
      }
      throw err;
    }
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /** Log in with username and password */
  async login(username: string, password: string): Promise<Session> {
    // Clear any prior access token so graphqlOnce sends "Bearer unauthenticated".
    // Waitrose rejects generateSession with HTTP 401 when carrying a validly-signed
    // (but expired) JWT — leaving the prior token in place breaks reauth-on-401.
    this.accessToken = null;

    // Use graphqlOnce directly — avoid triggering re-auth loop during login itself.
    const result = await this.graphqlOnce<{ data: { generateSession: Session & { failures: ApiFailure[] | null } } }>(
      QUERIES.NewSession,
      { input: { username, password, clientId: CLIENT_ID } }
    );

    const session = result.data.generateSession;
    if (session.failures?.length) {
      throw new Error(`Login failed: ${session.failures.map(f => f.message).join(", ")}`);
    }

    this.accessToken = session.accessToken;
    this.refreshToken = session.refreshToken;
    this.customerId = session.customerId;
    this.customerOrderId = session.customerOrderId;
    this.defaultBranchId = session.defaultBranchId;
    this.tokenExpiresAt =
      typeof session.expiresIn === "number" && session.expiresIn > 0
        ? Date.now() + session.expiresIn * 1000
        : null;
    this._storedUsername = username;
    this._storedPassword = password;

    return session;
  }

  /** 
   * Re-authenticate using stored credentials.
   * Note: The Waitrose API doesn't support token refresh via GraphQL - 
   * re-login is required when the token expires.
   */
  async reAuthenticate(username: string, password: string): Promise<Session> {
    return this.login(username, password);
  }

  /** Check if the client is authenticated */
  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  /** Log out and delete the session */
  async logout(): Promise<void> {
    await this.graphql(QUERIES.DeleteSession);
    this.accessToken = null;
    this.refreshToken = null;
    this.customerId = null;
    this.customerOrderId = null;
    this.tokenExpiresAt = null;
    this._storedUsername = null;
    this._storedPassword = null;
  }

  /** Get the current order ID */
  getOrderId(): string | null {
    return this.customerOrderId;
  }

  /** Get the current customer ID */
  getCustomerId(): string | null {
    return this.customerId;
  }

  /** Get the default (collection) branch ID from the session */
  getDefaultBranchId(): string | null {
    return this.defaultBranchId;
  }

  // ==========================================================================
  // Shopping Context
  // ==========================================================================

  /** Get the current shopping context */
  async getShoppingContext(): Promise<ShoppingContext> {
    const result = await this.graphql<{ data: { shoppingContext: ShoppingContext } }>(QUERIES.GetShoppingContext);
    return result.data.shoppingContext;
  }

  // ==========================================================================
  // Account
  // ==========================================================================

  /** Get account profile and membership info */
  async getAccountInfo(): Promise<{ profile: AccountProfile; memberships: Membership[] | null }> {
    const result = await this.graphql<{ 
      data: { 
        getAccountProfile: AccountProfile; 
        getMemberships: { memberships: Membership[] } | null
      } 
    }>(QUERIES.GetAccountInfoAndMembership);

    return {
      profile: result.data.getAccountProfile,
      memberships: result.data.getMemberships?.memberships || null,
    };
  }

  /** List the customer's saved addresses (usable as delivery addressId). */
  async getAddresses(): Promise<Address[]> {
    const result = await this.graphql<{ data: { addresses: Address[] | null } }>(QUERIES.GetAddresses);
    return result.data.addresses ?? [];
  }

  // ==========================================================================
  // Trolley
  // ==========================================================================

  /** Get the current trolley contents */
  async getTrolley(orderId?: string): Promise<TrolleyResponse> {
    const id = orderId || this.customerOrderId;
    if (!id) throw new Error("No order ID available");

    const result = await this.graphql<{ data: { getTrolley: TrolleyResponse } }>(
      QUERIES.GetTrolley,
      { orderId: id }
    );

    return result.data.getTrolley;
  }

  /** Add or update items in the trolley */
  async updateTrolleyItems(items: TrolleyItemInput[], orderId?: string): Promise<TrolleyResponse> {
    const id = orderId || this.customerOrderId;
    if (!id) throw new Error("No order ID available");

    const result = await this.graphql<{ data: { updateTrolleyItems: TrolleyResponse } }>(
      QUERIES.UpdateTrolleyItems,
      { trolleyItemsInput: items, orderId: id }
    );

    return result.data.updateTrolleyItems;
  }

  /** Add an item to the trolley by line number */
  async addToTrolley(lineNumber: string, quantity: number = 1, uom: UnitOfMeasure = "C62"): Promise<TrolleyResponse> {
    return this.updateTrolleyItems([{ lineNumber, quantity: { amount: quantity, uom } }]);
  }

  /**
   * Remove an item from the trolley. Weighed lines (KGM/GRM) must be zeroed
   * with their own unit of measure, so pass `uom` when known.
   */
  async removeFromTrolley(lineNumber: string, uom: UnitOfMeasure = "C62"): Promise<TrolleyResponse> {
    return this.updateTrolleyItems([{ lineNumber, quantity: { amount: 0, uom } }]);
  }

  /** Empty the entire trolley */
  async emptyTrolley(orderId?: string): Promise<TrolleyResponse> {
    const id = orderId || this.customerOrderId;
    if (!id) throw new Error("No order ID available");

    const result = await this.graphql<{ data: { emptyTrolley: TrolleyResponse } }>(
      QUERIES.EmptyTrolley,
      { orderId: id }
    );

    return result.data.emptyTrolley;
  }

  // ==========================================================================
  // Orders
  // ==========================================================================

  /** 
   * Get all orders (pending and previous)
   * @param limit Max number of orders per category (API max is 15)
   */
  async getOrders(limit: number = 10): Promise<{ pending: Order[]; previous: Order[] }> {
    const [pending, previous] = await Promise.all([
      this.getPendingOrders(limit),
      this.getPreviousOrders(limit),
    ]);

    return { pending, previous };
  }

  /** 
   * Get pending orders only
   * @param limit Max number of orders to return (API max is 15)
   */
  async getPendingOrders(limit: number = 10): Promise<Order[]> {
    // API has a max page size of 15
    const effectiveLimit = Math.min(limit, 15);
    
    const result = await this.graphql<{ data: { pendingOrders: { content: Order[] } } }>(
      QUERIES.GetPendingOrders,
      { 
        getPendingOrdersInput: { 
          size: effectiveLimit, 
          sortBy: "+",  // ASCENDING
          statuses: ["PAYMENT_FAILED", "PLACED", "FULFIL", "PAID", "PICKED"]
        } 
      }
    );
    return result.data.pendingOrders?.content || [];
  }

  /** 
   * Get previous/completed orders
   * @param limit Max number of orders to return (API max is 15)
   */
  async getPreviousOrders(limit: number = 10): Promise<Order[]> {
    // API has a max page size of 15
    const effectiveLimit = Math.min(limit, 15);
    
    const result = await this.graphql<{ data: { previousOrders: { content: Order[] } } }>(
      QUERIES.GetPreviousOrders,
      { 
        getPreviousOrdersInput: { 
          size: effectiveLimit, 
          sortBy: "-",  // DESCENDING
          statuses: ["COMPLETED", "CANCELLED", "REFUND_PENDING"]
        } 
      }
    );
    return result.data.previousOrders?.content || [];
  }

  /** Get details for a specific order */
  async getOrder(customerOrderId: string): Promise<OrderDetails> {
    const result = await this.graphql<{ data: { getOrder: OrderDetails } }>(
      QUERIES.GetOrder,
      { customerOrderId }
    );
    return result.data.getOrder;
  }

  /** Cancel an order */
  async cancelOrder(customerOrderId: string): Promise<void> {
    const result = await this.graphql<{ data: { cancelOrder: { failures: ApiFailure[] | null } } }>(
      QUERIES.CancelOrder,
      { input: customerOrderId }
    );

    if (result.data.cancelOrder.failures?.length) {
      throw new Error(`Cancel failed: ${result.data.cancelOrder.failures.map(f => `${f.type}: ${f.message}`).join(", ")}`);
    }
  }

  /** Start amending an existing order */
  async initiateAmendOrder(customerOrderId: string): Promise<void> {
    // Idempotency: if the session is already in AMENDING state (e.g. after a server
    // restart mid-amendment), skip the mutation and sync local state from the server.
    // Without this, a second call produces ORDER_ORCHESTRATION_004.
    const preContext = await this.getShoppingContext();
    if (preContext.customerOrderState === "AMENDING") {
      if (preContext.customerOrderId !== customerOrderId) {
        throw new Error(
          `Cannot amend order ${customerOrderId} — session is already amending order ${preContext.customerOrderId}`
        );
      }
      this.customerOrderId = preContext.customerOrderId;
      return;
    }

    const result = await this.graphql<{ data: { amendOrder: { failures: ApiFailure[] | null } } }>(
      QUERIES.InitiateAmendOrder,
      { input: customerOrderId }
    );

    if (result.data.amendOrder.failures?.length) {
      throw new Error(`Amend failed: ${result.data.amendOrder.failures.map(f => `${f.type}: ${f.message}`).join(", ")}`);
    }

    // Sync local customerOrderId from server — trolley write tools use this.customerOrderId,
    // so it must reflect the placed order ID rather than the login-session basket ID.
    const postContext = await this.getShoppingContext();
    this.customerOrderId = postContext.customerOrderId;
  }

  /** Cancel amending an order */
  async cancelAmendOrder(customerOrderId: string): Promise<void> {
    const result = await this.graphql<{ data: { cancelAmendOrder: { failures: ApiFailure[] | null } } }>(
      QUERIES.CancelAmendOrder,
      { input: customerOrderId }
    );

    if (result.data.cancelAmendOrder.failures?.length) {
      throw new Error(`Cancel amend failed: ${result.data.cancelAmendOrder.failures.map(f => `${f.type}: ${f.message}`).join(", ")}`);
    }

    // Revert customerOrderId to whatever the server reports after cancellation.
    const context = await this.getShoppingContext();
    this.customerOrderId = context.customerOrderId;
  }

  // ==========================================================================
  // Slots
  // ==========================================================================

  /**
   * Get the slot currently reserved against the active trolley/order, or null.
   * `customerOrderId` is mandatory in CurrentSlotInput.
   */
  async getCurrentSlot(postcode?: string): Promise<CurrentSlot | null> {
    const result = await this.graphql<{ data: { currentSlot: CurrentSlot | null } }>(
      QUERIES.CurrentSlot,
      { input: { postcode, customerOrderId: this.customerOrderId, customerId: this.customerId ?? undefined } }
    );
    const slot = result.data.currentSlot;
    // The API returns an object full of nulls rather than null when nothing is booked.
    if (!slot || (!slot.slotType && !slot.startDateTime)) return null;
    return slot;
  }

  /**
   * Build the location part of a slot query. Delivery needs an addressId (the
   * API resolves the delivering branch from it); collection needs a branchId
   * and falls back to the session's default branch.
   */
  private slotLocation(slotType: SlotType, branchId?: string, addressId?: string): Record<string, string | undefined> {
    if (isCollectionSlotType(slotType)) {
      return { branchId: branchId || this.defaultBranchId || undefined };
    }
    return { addressId, branchId };
  }

  /** Get dates that have slots for the given service */
  async getSlotDates(slotType: SlotType, branchId?: string, addressId?: string): Promise<SlotDate[]> {
    const result = await this.graphql<{ 
      data: { 
        slotDates: { 
          content: SlotDate[] | null;
          failures: ApiFailure[] | null;
        } 
      } 
    }>(QUERIES.SlotDates, {
      slotDatesInput: {
        slotType,
        customerOrderId: this.customerOrderId,
        ...this.slotLocation(slotType, branchId, addressId),
      },
    });

    if (result.data.slotDates.failures?.length) {
      throw new Error(`Get slots failed: ${result.data.slotDates.failures.map(f => f.message).join(", ")}`);
    }

    return result.data.slotDates.content ?? [];
  }

  /**
   * Get the slot grid starting at `fromDate` (YYYY-MM-DD).
   * @param days Number of days to return (API `size`; defaults to 1 server-side)
   */
  async getSlotDays(slotType: SlotType, fromDate: string, branchId?: string, addressId?: string, days?: number): Promise<SlotDay[]> {
    const result = await this.graphql<{ 
      data: { 
        slotDays: { 
          content: SlotDay[] | null;
          failures: ApiFailure[] | null;
        } 
      } 
    }>(QUERIES.SlotDays, {
      slotDaysInput: {
        slotType,
        customerOrderId: this.customerOrderId,
        ...this.slotLocation(slotType, branchId, addressId),
        fromDate,
        ...(days !== undefined ? { size: days } : {}),
      },
    });

    if (result.data.slotDays.failures?.length) {
      throw new Error(`Get slot days failed: ${result.data.slotDays.failures.map(f => f.message).join(", ")}`);
    }

    return result.data.slotDays.content ?? [];
  }

  /**
   * Reserve a delivery/collection slot for the active trolley. The API has no
   * slot-id argument: a slot is identified by type + start/end time + address
   * (delivery) or branch (collection). The reservation is temporary until
   * checkout and can be released with cancelSlot().
   */
  async bookSlot(params: BookSlotParams): Promise<BookSlotResult> {
    const collection = isCollectionSlotType(params.slotType);
    const result = await this.graphql<{ 
      data: { 
        bookSlot: BookSlotResult & { failures: ApiFailure[] | null };
      } 
    }>(QUERIES.BookSlot, {
      input: {
        slotType: params.slotType,
        customerOrderId: this.customerOrderId,
        customerId: this.customerId ?? undefined,
        startDateTime: params.startDateTime,
        endDateTime: params.endDateTime,
        ...(collection
          ? { branchId: params.branchId || this.defaultBranchId || undefined }
          : { addressId: params.addressId }),
        postcode: params.postcode,
        expectedSlotCharge: params.expectedSlotCharge
          ? { amount: params.expectedSlotCharge.amount, currencyCode: params.expectedSlotCharge.currencyCode }
          : undefined,
        slotGridType: params.slotGridType ?? undefined,
        greenSlot: params.greenSlot,
      },
    });

    if (result.data.bookSlot.failures?.length) {
      throw new Error(`Book slot failed: ${result.data.bookSlot.failures.map(f => f.message).join(", ")}`);
    }

    return result.data.bookSlot;
  }

  /** Release a reserved slot (the website's "Cancel slot" action). */
  async cancelSlot(slotReservationId: string): Promise<void> {
    const result = await this.graphql<{ data: { cancelSlot: { failures: ApiFailure[] | null } | null } }>(
      QUERIES.CancelSlot,
      { slotReservationId }
    );

    const failures = result.data.cancelSlot?.failures;
    if (failures?.length) {
      throw new Error(`Cancel slot failed: ${failures.map(f => `${f.type}: ${f.message}`).join(", ")}`);
    }
  }

  // ==========================================================================
  // Branches (REST)
  // ==========================================================================

  /** Single GET against the branch finder — throws AuthError on 401 */
  private async _findBranchesOnce(query: string): Promise<Branch[]> {
    const response = await fetch(`${BRANCH_API_URL}?${query}`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Waitrose/3.9.1 (Android)",
        "Authorization": `Bearer ${this.accessToken ?? ANONYMOUS_BEARER}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      upstreamCallsTotal.inc({ outcome: "error" });
      if (response.status === 401) throw new AuthError(`HTTP 401: ${text}`);
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    upstreamCallsTotal.inc({ outcome: "ok" });
    const raw = await response.json() as {
      branches?: Array<{
        branch: {
          id: number | string;
          name: string;
          type: string;
          services?: string[];
          contactDetails?: {
            address1?: string; address2?: string; city?: string; county?: string; postcode?: string; phone?: string;
          };
        };
        defaultBranch?: boolean;
        distance?: number;
        carParkCollectionEnabled?: boolean;
      }>;
    };

    return (raw.branches ?? []).map(({ branch, defaultBranch, distance, carParkCollectionEnabled }) => ({
      id: String(branch.id),
      name: branch.name,
      type: branch.type,
      defaultBranch: !!defaultBranch,
      ...(distance !== undefined ? { distance } : {}),
      ...(carParkCollectionEnabled !== undefined ? { carParkCollectionEnabled } : {}),
      services: branch.services ?? [],
      address: {
        address1: branch.contactDetails?.address1,
        address2: branch.contactDetails?.address2,
        city: branch.contactDetails?.city,
        county: branch.contactDetails?.county,
        postcode: branch.contactDetails?.postcode,
      },
      phone: branch.contactDetails?.phone,
    }));
  }

  /**
   * Find branches serving a postcode/town. For COLLECTION this lists nearby
   * Click & Collect stores (pass one as branchId); for DELIVERY it returns the
   * branch/fulfilment centre that delivers to that postcode.
   */
  async findBranches(
    location: string,
    fulfilmentType: FulfilmentType = "COLLECTION",
    serviceType: "GROCERY" | "ENTERTAINING_PLACED_AT_HOME" = "GROCERY",
  ): Promise<Branch[]> {
    const params = new URLSearchParams({ fulfilment_type: fulfilmentType, location });
    if (fulfilmentType === "COLLECTION") params.set("service_type", serviceType);
    const query = params.toString();

    await this.rateLimiter.acquire();
    await this.ensureFreshToken();
    try {
      return await this._findBranchesOnce(query);
    } catch (err) {
      if (err instanceof AuthError && this._storedUsername && this._storedPassword) {
        await this._handleReauth(new Date().toISOString());
        return this._findBranchesOnce(query);
      }
      throw err;
    }
  }

  // ==========================================================================
  // Campaigns
  // ==========================================================================

  /** Get active campaigns */
  async getCampaigns(): Promise<Campaign[]> {
    const result = await this.graphql<{ data: { campaigns: Campaign[] } }>(
      QUERIES.GetCampaigns
    );
    return result.data.campaigns;
  }

  // ==========================================================================
  // Product Search (REST API)
  // ==========================================================================

  /**
   * Search for products by text query
   * 
   * @example
   * ```ts
   * // Simple search
   * const results = await client.searchProducts("organic milk");
   * 
   * // Search with options (size defaults to API default, max ~128)
   * const results = await client.searchProducts("milk", {
   *   sortBy: "PRICE_LOW_2_HIGH",
   *   size: 24
   * });
   * ```
   */
  async searchProducts(
    searchTerm: string,
    options: Omit<SearchQueryParams, "searchTerm" | "category"> = {}
  ): Promise<SearchResponse> {
    const queryParams: SearchQueryParams = {
      searchTerm,
      start: options.start ?? 0,
      sortBy: options.sortBy ?? "RELEVANCE",
      ...options,
    };

    return this.restApi("search", {
      customerSearchRequest: { queryParams },
    });
  }

  /**
   * Browse products by category
   * 
   * @example
   * ```ts
   * // Browse a category
   * const results = await client.browseProducts("groceries/bakery/bread");
   * 
   * // Browse with sorting
   * const results = await client.browseProducts("groceries/dairy", {
   *   sortBy: "MOST_POPULAR"
   * });
   * ```
   */
  async browseProducts(
    category: string,
    options: Omit<SearchQueryParams, "searchTerm" | "category"> = {}
  ): Promise<SearchResponse> {
    const queryParams: SearchQueryParams = {
      category,
      start: options.start ?? 0,
      sortBy: options.sortBy ?? "RELEVANCE",
      ...options,
    };

    return this.restApi("browse", {
      customerSearchRequest: { queryParams },
    });
  }

  async getCategoryNavigation(categoryId: string = "10051"): Promise<CategoryNavEntry[]> {
    const raw = await this.restApi("browse", {
      customerSearchRequest: {
        queryParams: { category: categoryId, start: 0, size: 1, sortBy: "RELEVANCE" },
      },
    });

    const subs = raw.subCategories;
    if (!subs?.length) {
      console.info("[Waitrose] getCategoryNavigation: no subcategories returned for categoryId=%s", categoryId);
      return [];
    }

    return subs
      .filter(s => !s.hiddenInNav)
      .map(s => ({ name: s.name, categoryId: s.categoryId, productCount: s.expectedResults ?? 0 }));
  }

  /**
   * Get product details by line numbers
   * 
   * @example
   * ```ts
   * const products = await client.getProductsByLineNumbers(["123456", "789012"]);
   * console.log(products[0].name); // "Waitrose Organic Milk 2 Pints"
   * ```
   */
  private async _fetchProductsByLineNumbersOnce(lineNumbers: string[]): Promise<ProductDetail[]> {
    const lineNumbersParam = lineNumbers.map(encodeURIComponent).join("+");
    const url = `${PRODUCTS_API_URL}/${lineNumbersParam}`;

    const params: Record<string, string> = {
      view: "EXTENDED",
      excludeLinesWithConflicts: "false",
      filterByCustomerSlot: "false",
    };

    const queryString = new URLSearchParams(params).toString();
    const fullUrl = `${url}?${queryString}`;

    const headers: Record<string, string> = {
      "Accept": "application/json",
      "User-Agent": "Waitrose/3.9.1 (Android)",
    };

    // LOCAL PATCH: send "Bearer unauthenticated" when no session; see ANONYMOUS_BEARER.
    headers["Authorization"] = `Bearer ${this.accessToken ?? ANONYMOUS_BEARER}`;

    const response = await fetch(fullUrl, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      upstreamCallsTotal.inc({ outcome: "error" });
      if (response.status === 401) throw new AuthError(`HTTP 401: ${text}`);
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    upstreamCallsTotal.inc({ outcome: "ok" });
    const result = await response.json() as { products?: ProductDetail[] };
    return result.products || [];
  }

  async getProductsByLineNumbers(lineNumbers: string[]): Promise<ProductDetail[]> {
    if (lineNumbers.length === 0) {
      return [];
    }
    await this.rateLimiter.acquire();
    await this.ensureFreshToken();
    try {
      return await this._fetchProductsByLineNumbersOnce(lineNumbers);
    } catch (err) {
      if (err instanceof AuthError && this._storedUsername && this._storedPassword) {
        await this._handleReauth(new Date().toISOString());
        // Retry without acquiring a new rate-limiter token — the original token was already consumed.
        return this._fetchProductsByLineNumbersOnce(lineNumbers);
      }
      throw err;
    }
  }

  /**
   * Get products on promotion
   * 
   * @example
   * ```ts
   * const results = await client.getPromotionProducts("myWaitrose");
   * ```
   */
  async getPromotionProducts(
    promotionId: string,
    options: Omit<SearchQueryParams, "searchTerm" | "category" | "promotionId"> = {}
  ): Promise<SearchResponse> {
    const queryParams: SearchQueryParams = {
      promotionId,
      start: options.start ?? 0,
      sortBy: options.sortBy ?? "RELEVANCE",
      ...options,
    };

    return this.restApi("search", {
      customerSearchRequest: { queryParams },
    });
  }

  /**
   * Search with filters
   * 
   * @example
   * ```ts
   * const results = await client.searchWithFilters("milk", {
   *   filterTags: [
   *     { group: "dietary", value: "vegan" },
   *     { group: "brand", value: "Oatly" }
   *   ]
   * });
   * ```
   */
  async searchWithFilters(
    searchTerm: string,
    filters: {
      filterTags?: FilterTag[];
      searchTags?: SearchTag[];
      sortBy?: SearchSortBy;
      start?: number;
      size?: number;
    }
  ): Promise<SearchResponse> {
    return this.searchProducts(searchTerm, filters);
  }

  /**
   * Paginated search helper
   * 
   * @example
   * ```ts
   * // Get page 2 (products 24-47)
   * const results = await client.searchProductsPage("milk", 2, 24);
   * ```
   */
  async searchProductsPage(
    searchTerm: string,
    page: number,
    pageSize: number = 24,
    options: Omit<SearchQueryParams, "searchTerm" | "category" | "start" | "size"> = {}
  ): Promise<SearchResponse> {
    return this.searchProducts(searchTerm, {
      ...options,
      start: (page - 1) * pageSize,
      size: pageSize,
    });
  }
}

// Export for default usage
export default WaitroseClient;

