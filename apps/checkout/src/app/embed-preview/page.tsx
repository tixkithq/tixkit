import { EmbedPreviewClient } from './embed-preview-client';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const value = (name: string) => {
    const candidate = query[name];
    return typeof candidate === 'string' ? candidate : undefined;
  };
  return (
    <EmbedPreviewClient
      eventId={value('eventId') ?? ''}
      brandId={value('brand') ?? 'platform'}
      mode={value('mode') ?? 'inline'}
      theme={value('theme') ?? 'auto'}
      locale={value('locale') ?? 'en-US'}
      products={value('products')}
      themeTokens={value('themeTokens')}
      previewId={value('previewId') ?? ''}
      apiBaseUrl={value('apiBaseUrl') ?? 'https://checkout.tixkit.com'}
    />
  );
}
