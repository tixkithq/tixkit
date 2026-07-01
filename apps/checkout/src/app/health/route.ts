const healthPayload = {
  status: 'ok',
  service: 'tixkit-checkout',
} as const;

export function GET() {
  return Response.json(healthPayload, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
