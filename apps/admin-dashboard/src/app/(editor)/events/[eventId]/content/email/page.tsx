import { PermissionGuard } from '@/components/permission-guard';
import { EmailPersistedEditorView } from '@/features/content-editor/email-persisted-editor-view';
import { isTemplateKey } from '@tixkit/domain';

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams?: Promise<{ returnTo?: string | string[]; templateKey?: string | string[] }>;
}) {
  const { eventId } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const templateKeyParam = Array.isArray(resolvedSearchParams?.templateKey)
    ? resolvedSearchParams?.templateKey[0]
    : resolvedSearchParams?.templateKey;
  const returnToParam = Array.isArray(resolvedSearchParams?.returnTo)
    ? resolvedSearchParams?.returnTo[0]
    : resolvedSearchParams?.returnTo;
  const templateKey =
    templateKeyParam && isTemplateKey(templateKeyParam) ? templateKeyParam : undefined;
  const returnTo =
    returnToParam && returnToParam.startsWith('/') && !returnToParam.startsWith('//')
      ? returnToParam
      : undefined;
  return (
    <PermissionGuard required="messages.write">
      <EmailPersistedEditorView eventId={eventId} returnHref={returnTo} templateKey={templateKey} />
    </PermissionGuard>
  );
}
