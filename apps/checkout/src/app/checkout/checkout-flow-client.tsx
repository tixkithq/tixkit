'use client'

import CheckoutFlow from './checkout-flow'

type Props = {
  initialEventId: string
  initialSessionId: string
  initialSessionToken: string
  brandId?: string
  supportUrl?: string
  termsUrl?: string
  privacyUrl?: string
  refundUrl?: string
  presetDiscountCode?: string
  trackingId?: string
  prefilledItemsParam?: string
  productFilterParam?: string
}

export default function CheckoutFlowClient(props: Props) {
  return <CheckoutFlow {...props} />
}
