const healthPayload = {
  status: 'ok',
  service: 'tixkit-admin',
} as const;

export function GET() {
  return Response.json(healthPayload, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
