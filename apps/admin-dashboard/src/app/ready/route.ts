import { adminRuntimeReadiness, parseAdminRuntimeConfig } from '@/lib/runtime-config-server';

export function GET() {
  try {
    const config = parseAdminRuntimeConfig();
    return Response.json(adminRuntimeReadiness(config), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json(
      { status: 'unavailable', reason: 'invalid_runtime_configuration' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
