'use client';

import * as React from 'react';
import {
  adminApi,
  type AdminEventDetail,
  type AdminEventMediaAsset,
  type AdminEventMediaRole,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthenticatedEventImage } from './authenticated-event-image';

export function EventMediaSettings({
  event,
  onChanged,
}: {
  event: AdminEventDetail;
  onChanged: () => void;
}) {
  const [state, setState] = React.useState<
    'loading' | 'idle' | 'uploading' | 'saving' | 'saved' | 'error'
  >('loading');
  const [error, setError] = React.useState<string>();
  const [listFailed, setListFailed] = React.useState(false);
  const [loadRevision, setLoadRevision] = React.useState(0);
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const [activeUploadRole, setActiveUploadRole] = React.useState<AdminEventMediaRole>();
  const [assets, setAssets] = React.useState<AdminEventMediaAsset[]>([]);
  const [roleAlt, setRoleAlt] = React.useState<Record<AdminEventMediaRole, string>>({
    poster: event.title,
    cover: event.coverImageAlt ?? event.title,
    social: event.title,
  });
  const [roleFocalPoints, setRoleFocalPoints] = React.useState<
    Record<AdminEventMediaRole, { x: number; y: number }>
  >({
    poster: { x: 0.5, y: 0.5 },
    cover: { x: 0.5, y: 0.5 },
    social: { x: 0.5, y: 0.5 },
  });
  React.useEffect(() => {
    let active = true;
    setState('loading');
    setListFailed(false);
    setError(undefined);
    void adminApi
      .listEventMedia(event.id)
      .then((result) => {
        if (!active) return;
        if (!result.ok) throw new Error(result.error.message);
        setAssets(result.data);
        setRoleAlt((current) => {
          const next = { ...current };
          for (const asset of result.data) next[asset.role] = asset.altText;
          return next;
        });
        setRoleFocalPoints((current) => {
          const next = { ...current };
          for (const asset of result.data) next[asset.role] = asset.focalPoint;
          return next;
        });
        setState('idle');
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setListFailed(true);
        setState('error');
        setError(cause instanceof Error ? cause.message : 'Unable to load event media.');
      });
    return () => {
      active = false;
    };
  }, [event.id, loadRevision]);
  const busy = state === 'loading' || state === 'uploading' || state === 'saving' || listFailed;
  const uploadRole = async (file: File, role: AdminEventMediaRole) => {
    const altText = roleAlt[role].trim();
    if (!altText) {
      setState('error');
      setError(`Add alt text before uploading the ${role} image.`);
      return;
    }
    setState('uploading');
    setActiveUploadRole(role);
    setUploadProgress(0);
    setError(undefined);
    try {
      const uploaded = await adminApi.uploadArtifact({
        purpose:
          role === 'poster' ? 'event_poster' : role === 'cover' ? 'event_cover' : 'event_social',
        file,
        eventId: event.id,
        brandId: event.brandId,
        onProgress: setUploadProgress,
      });
      if (!uploaded.ok) {
        setState('error');
        setActiveUploadRole(undefined);
        setError(uploaded.error.message);
        return;
      }
      const attached = await adminApi.attachEventMedia(event.id, role, {
        uploadArtifactId: uploaded.data.artifactId,
        altText,
        focalPoint: roleFocalPoints[role],
      });
      if (!attached.ok) {
        setState('error');
        setActiveUploadRole(undefined);
        setError(attached.error.message);
        return;
      }
      setAssets((current) => [...current.filter((asset) => asset.role !== role), attached.data]);
      setState('saved');
      setActiveUploadRole(undefined);
      onChanged();
    } catch (cause) {
      setState('error');
      setActiveUploadRole(undefined);
      setError(cause instanceof Error ? cause.message : `Unable to upload the ${role} image.`);
    }
  };
  const removeRole = async (role: AdminEventMediaRole) => {
    if (!window.confirm(`Remove the ${role} image and its published renditions?`)) return;
    setState('saving');
    setError(undefined);
    try {
      const removed = await adminApi.removeEventMedia(event.id, role);
      if (!removed.ok) {
        setState('error');
        setError(removed.error.message);
        return;
      }
    } catch (cause) {
      setState('error');
      setError(cause instanceof Error ? cause.message : `Unable to remove the ${role} image.`);
      return;
    }
    setAssets((current) => current.filter((asset) => asset.role !== role));
    setState('saved');
    onChanged();
  };
  return (
    <div className="space-y-4">
      <section className="space-y-4" aria-labelledby="event-role-media-heading">
        <div>
          <h2 id="event-role-media-heading" className="font-medium">
            Event poster, cover, and social images
          </h2>
          <p className="text-sm text-muted-foreground">
            Each upload keeps its original and creates optimized crops. Set the focal point used for
            automatic crops before uploading. JPEG, PNG, and WebP files up to 8 MB are scanned and
            scoped to this event.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {(['poster', 'cover', 'social'] as const).map((role) => {
            const roleLabel = `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
            const asset = assets.find((candidate) => candidate.role === role);
            const preview =
              asset?.renditions.find((rendition) => rendition.variant === 'card') ??
              asset?.renditions.find((rendition) => rendition.variant === 'thumbnail');
            return (
              <article key={role} className="space-y-3 rounded-lg border p-4">
                <h3 className="font-medium">{roleLabel}</h3>
                {preview ? (
                  <AuthenticatedEventImage
                    source={{
                      url: preview.organizerUrl ?? preview.url,
                      altText: asset?.altText ?? `${role} preview`,
                      width: preview.width,
                      height: preview.height,
                    }}
                    className="aspect-video w-full rounded-md object-cover"
                    fallbackClassName="aspect-video w-full"
                  />
                ) : (
                  <div className="flex aspect-video items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                    No {role} image
                  </div>
                )}
                <label htmlFor={`event-${role}-alt`} className="block space-y-1 text-sm">
                  <span>{roleLabel} alt text for next upload</span>
                  <Input
                    id={`event-${role}-alt`}
                    value={roleAlt[role]}
                    maxLength={500}
                    required
                    onChange={(change) =>
                      setRoleAlt((current) => ({
                        ...current,
                        [role]: change.target.value,
                      }))
                    }
                  />
                </label>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Focal point for next upload</legend>
                  {(['x', 'y'] as const).map((axis) => (
                    <label key={axis} className="block text-sm">
                      <span>
                        {axis === 'x' ? 'Horizontal' : 'Vertical'} (
                        {Math.round(roleFocalPoints[role][axis] * 100)}%)
                      </span>
                      <input
                        className="w-full"
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={roleFocalPoints[role][axis]}
                        onChange={(change) =>
                          setRoleFocalPoints((current) => ({
                            ...current,
                            [role]: {
                              ...current[role],
                              [axis]: Number(change.target.value),
                            },
                          }))
                        }
                        aria-label={`${role} ${axis === 'x' ? 'horizontal' : 'vertical'} focal point`}
                      />
                    </label>
                  ))}
                </fieldset>
                <label htmlFor={`event-${role}-upload`} className="block space-y-1 text-sm">
                  <span>Upload {role}</span>
                  <Input
                    id={`event-${role}-upload`}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy}
                    onChange={(change) => {
                      const file = change.target.files?.[0];
                      if (file) void uploadRole(file, role);
                      change.target.value = '';
                    }}
                  />
                </label>
                {asset ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="text-foreground"
                    disabled={busy}
                    onClick={() => void removeRole(role)}
                  >
                    Remove {role}
                  </Button>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
      {event.coverImageUrl || event.seo.imageUrl ? (
        <aside
          className="rounded-lg border bg-muted/30 p-4 text-sm"
          aria-label="Legacy event media"
        >
          <p className="font-medium">Legacy image metadata retained</p>
          <p className="mt-1 text-muted-foreground">
            This event has an older cover or social image reference. It remains available for
            compatibility but is read-only here. Upload a structured cover and social image above to
            use durable optimized renditions.
          </p>
        </aside>
      ) : null}
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {listFailed ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setLoadRevision((current) => current + 1)}
            >
              Retry loading media
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <span className="self-center text-sm text-muted-foreground" aria-live="polite">
          {state === 'loading'
            ? 'Loading media…'
            : state === 'uploading'
              ? `Uploading ${activeUploadRole ?? 'media'}… ${uploadProgress}%`
              : state === 'saving'
                ? 'Saving…'
                : state === 'saved'
                  ? 'Saved'
                  : ''}
        </span>
        {state === 'uploading' ? (
          <progress
            className="w-40 self-center"
            max={100}
            value={uploadProgress}
            aria-label={`${activeUploadRole ?? 'Media'} upload progress`}
          >
            {uploadProgress}%
          </progress>
        ) : null}
      </div>
    </div>
  );
}
