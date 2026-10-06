import type { ReceiptKey } from "@oked/receipt-core";

/**
 * OKed's production receipt keys, shipped with the SDK so the first receipt
 * verifies without a network call and a lookalike backend cannot supply its
 * own key. Keys not listed here are fetched from the fixed published URL
 * (OKED_RECEIPT_KEYS_URL), never from the configurable backend URL.
 *
 * On rotation, add the new key here and give the old one its not_after (the
 * same value the backend publishes), so a retired key stops verifying new
 * receipts here too.
 */
export const PINNED_RECEIPT_KEYS: ReceiptKey[] = [
  {
    kid: "oked-2026-10",
    alg: "Ed25519",
    public_key: "C0YsmbAi0NLBz4eEDTwpusXlBMOzh30LXWkd-9dEiAw",
    not_before: "2026-10-01T00:00:00.000Z",
    not_after: null,
  },
];
