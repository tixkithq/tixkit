/**
 * Checkout chrome copy keys.
 *
 * Event content already flows through locale-aware page documents
 * (`event-page-locale`). Checkout step chrome remains English literals today.
 * This module is the single registry for chrome strings so a future locale
 * pack can swap implementations without inventing a second i18n system.
 *
 * Contract proposal (do not invent ad hoc translators until adopted repo-wide):
 * - Source of truth: shared message catalogs under packages/i18n (or existing
 *   content locale pipeline), keyed by stable ids used here.
 * - Runtime: resolve buyer locale from event page `?locale=` / document.lang,
 *   fall back to `en`.
 * - Checkout must not hardcode user-visible chrome outside this module once
 *   catalogs land.
 */

export const checkoutCopy = {
  continue: 'Continue',
  placeFreeOrder: 'Place free order',
  payPrefix: 'Pay',
  editOrder: 'Edit order',
  startNewOrder: 'Start new order',
  retryReservationCheck: 'Retry reservation check',
  retryCheckoutFields: 'Retry checkout fields',
  checkingReservation: 'Checking reservation',
  checkingReservationDetail: 'Checking whether your ticket reservation is still valid…',
  checkoutExpiredTitle: 'Checkout expired',
  checkoutExpiredBody: 'Your checkout session expired. Start a new order to reserve tickets again.',
  reservationUnverifiedTitle: 'Reservation could not be verified',
  reservationUnverifiedBody:
    'We could not confirm your ticket reservation. Payment is paused until the reservation is revalidated.',
  inventoryChangedTitle: 'Your selection changed',
  inventoryChangedAcknowledge: 'I understand — update my selection',
  inventoryReviewSelection: 'Review selection',
  networkOfflineTitle: 'You are offline',
  networkUnreachableTitle: 'Connection problem',
  networkRetry: 'Retry',
  checkoutErrorTitle: 'Checkout error',
  pleaseFixTitle: 'Please fix the following',
  orderSummary: 'Order summary',
  yourDetails: 'Your details',
  payment: 'Payment',
  selectTickets: 'Select tickets',
  loadingCheckoutFieldsTitle: 'Loading checkout fields',
  loadingCheckoutFieldsBody:
    'Required buyer and attendee fields are loading before checkout can continue.',
  checkoutFieldsUnavailableTitle: 'Checkout fields unavailable',
  orderComplete: 'Order complete',
  redirectingConfirmation: 'Redirecting to your confirmation…',
  sessionReservedUntil: (time: string) =>
    `Session reserved until ${time}. Your tickets are held while you complete checkout. We re-check the reservation with the server when that time is reached.`,
} as const;

export type CheckoutCopyKey = keyof typeof checkoutCopy;
