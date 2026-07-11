import { docsSiteConfig } from '@/lib/site';

export const dynamic = 'force-static';

export function GET() {
  const config = docsSiteConfig();
  return Response.json({
    status: 'ok',
    service: 'tixkit-docs',
    version: config.version,
    commit: config.commit,
  });
}
