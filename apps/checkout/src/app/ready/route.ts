import { checkoutRuntimeReadiness, parseCheckoutServerRuntime } from '@/lib/runtime-config-server';

export function GET() {
  try {
    return Response.json(checkoutRuntimeReadiness(parseCheckoutServerRuntime().publicConfig), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json(
      { status: 'unavailable', reason: 'invalid_runtime_configuration' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
