import { Suspense } from 'react';
import CheckoutFlowClient from './checkout-flow-client';

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  // Accept both `eventId` and `event` (fallback) so all SDK/widget entry
  // points converge. The backend worker is fixing sdk-next/sdk-sveltekit to
  // emit `eventId`; this makes checkout robust to both.
  const eventId = firstParam(params.eventId) || firstParam(params.event);

  return (
    <Suspense
      fallback={
        <div className="flex min-h-svh items-center justify-center p-6">
          <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        </div>
      }
    >
      <CheckoutFlowClient
        initialEventId={eventId}
        initialSessionId={firstParam(params.sessionId)}
        initialSessionToken={''}
        waitlistClaimToken={
          firstParam(params.waitlistClaim) ||
          firstParam(params.claimToken) ||
          firstParam(params.waitlistToken)
        }
        brandId={firstParam(params.brand)}
        supportUrl={firstParam(params.supportUrl)}
        termsUrl={firstParam(params.termsUrl)}
        privacyUrl={firstParam(params.privacyUrl)}
        refundUrl={firstParam(params.refundUrl)}
        presetDiscountCode={firstParam(params.discount)}
        trackingId={firstParam(params.tracking)}
        affiliateCode={firstParam(params.affiliateCode) || firstParam(params.affiliate)}
        prefilledItemsParam={firstParam(params.items)}
        productFilterParam={firstParam(params.products)}
      />
    </Suspense>
  );
}
