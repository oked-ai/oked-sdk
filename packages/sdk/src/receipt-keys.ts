import type { ReceiptKey } from "@oked/receipt-core";

/**
 * OKed's production receipt keys, shipped with the SDK so the first receipt
 * verifies without a network call and a lookalike backend cannot supply its
 * own key. Keys not listed here are fetched from the fixed published URL
 * (OKED_RECEIPT_KEYS_URL), never from the configurable backend URL.
 *
 * Add the production key here at release, before requireReceipt turns on by
 * default.
 */
export const PINNED_RECEIPT_KEYS: ReceiptKey[] = [];
