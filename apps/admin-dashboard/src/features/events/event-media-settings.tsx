"use client";

import * as React from "react";
import { adminApi, type AdminEventDetail } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function EventMediaSettings({
  event,
  onSaved,
}: {
  event: AdminEventDetail;
  onSaved: (event: AdminEventDetail) => void;
}) {
  const [coverUrl, setCoverUrl] = React.useState(event.coverImageUrl ?? "");
  const [seoUrl, setSeoUrl] = React.useState(event.seo.imageUrl ?? "");
  const [alt, setAlt] = React.useState(event.coverImageAlt ?? "");
  const [reuseCover, setReuseCover] = React.useState(
    event.seoUseCoverImage ?? false,
  );
  const [state, setState] = React.useState<
    "idle" | "uploading" | "saving" | "saved" | "offline" | "conflict" | "error"
  >("idle");
  const [error, setError] = React.useState<string>();
  const [dirty, setDirty] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const versionRef = React.useRef(event.version ?? 1);
  React.useEffect(() => {
    const online = () =>
      setState((current) => (current === "offline" ? "idle" : current));
    const offline = () => setState("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);
  React.useEffect(() => {
    const protect = (beforeUnload: BeforeUnloadEvent) => {
      if (dirty) beforeUnload.preventDefault();
    };
    const protectNavigation = (click: MouseEvent) => {
      if (!dirty || click.defaultPrevented) return;
      const anchor = (click.target as HTMLElement | null)?.closest("a[href]");
      if (
        anchor &&
        !window.confirm("Leave this page and discard unsaved media changes?")
      ) {
        click.preventDefault();
      }
    };
    window.addEventListener("beforeunload", protect);
    document.addEventListener("click", protectNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", protect);
      document.removeEventListener("click", protectNavigation, true);
    };
  }, [dirty]);
  React.useEffect(() => {
    if (dirty) return;
    setCoverUrl(event.coverImageUrl ?? "");
    setSeoUrl(event.seo.imageUrl ?? "");
    setAlt(event.coverImageAlt ?? "");
    setReuseCover(event.seoUseCoverImage ?? false);
    versionRef.current = event.version ?? versionRef.current;
  }, [dirty, event]);
  const upload = async (
    file: File,
    purpose: "event_cover" | "event_seo_image",
  ) => {
    setState("uploading");
    setUploadProgress(0);
    setError(undefined);
    try {
      const result = await adminApi.uploadArtifact({
        purpose,
        file,
        eventId: event.id,
        brandId: event.brandId,
        onProgress: setUploadProgress,
      });
      if (!result.ok) {
        setState("error");
        setError(result.error.message);
        return;
      }
      if (!result.data.downloadUrl) {
        setState("error");
        setError(
          "Upload completed without a usable image URL. You can select the file again to retry.",
        );
        return;
      }
      if (purpose === "event_cover") setCoverUrl(result.data.downloadUrl);
      else setSeoUrl(result.data.downloadUrl);
      setDirty(true);
      setState("idle");
    } catch (cause) {
      setState("error");
      setError(
        cause instanceof Error
          ? cause.message
          : "Upload failed. Select the file again to retry.",
      );
    }
  };
  const save = React.useCallback(async () => {
    if (!navigator.onLine) {
      setState("offline");
      return;
    }
    setState("saving");
    setError(undefined);
    const result = await adminApi.updateEvent(event.id, {
      expectedVersion: versionRef.current,
      coverImageUrl: coverUrl || null,
      coverImageAlt: alt.trim() || null,
      seoUseCoverImage: reuseCover,
      seo: {
        ...event.seo,
        imageUrl: reuseCover ? undefined : seoUrl || undefined,
      },
    });
    if (!result.ok) {
      setState(
        result.error.code === "stale_event_version" ? "conflict" : "error",
      );
      setError(
        result.error.code === "stale_event_version"
          ? "This event changed elsewhere. Reload before applying media changes."
          : result.error.message,
      );
      return;
    }
    versionRef.current = result.data.version ?? versionRef.current + 1;
    setDirty(false);
    setState("saved");
    onSaved(result.data);
  }, [alt, coverUrl, event.id, event.seo, onSaved, reuseCover, seoUrl]);
  const recoverConflict = async () => {
    setState("saving");
    const latest = await adminApi.getEvent(event.id);
    if (!latest.ok) {
      setState("conflict");
      setError(`Unable to load the latest version: ${latest.error.message}`);
      return;
    }
    versionRef.current = latest.data.version ?? versionRef.current;
    setState("idle");
    await save();
  };
  React.useEffect(() => {
    if (
      !dirty ||
      state === "uploading" ||
      state === "saving" ||
      state === "conflict" ||
      state === "offline" ||
      state === "error"
    )
      return;
    const timer = window.setTimeout(() => void save(), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, save, state]);
  return (
    <div className="space-y-4">
      {coverUrl ? (
        <img
          className="aspect-[16/9] w-full max-w-xl rounded-lg border object-cover"
          src={coverUrl}
          alt={alt || "Event cover preview"}
        />
      ) : (
        <div className="flex aspect-[16/9] max-w-xl items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          No cover image
        </div>
      )}
      <label htmlFor="event-cover-upload" className="block space-y-2">
        <span className="text-sm font-medium">Upload event cover</span>
        <Input
          id="event-cover-upload"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={state === "uploading"}
          onChange={(change) => {
            const file = change.target.files?.[0];
            if (file) void upload(file, "event_cover");
            change.target.value = "";
          }}
        />
        <span className="block text-xs text-muted-foreground">
          JPEG, PNG, or WebP up to 8 MB. Uploads are scanned and scoped to this
          event.
        </span>
      </label>
      {!reuseCover ? (
        <label htmlFor="event-seo-upload" className="block space-y-2">
          <span className="text-sm font-medium">Social image</span>
          {seoUrl ? (
            <img
              className="aspect-[1.91/1] w-full max-w-md rounded-lg border object-cover"
              src={seoUrl}
              alt="Social sharing preview"
            />
          ) : null}
          <Input
            id="event-seo-upload"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={state === "uploading"}
            onChange={(change) => {
              const file = change.target.files?.[0];
              if (file) void upload(file, "event_seo_image");
              change.target.value = "";
            }}
          />
        </label>
      ) : null}
      <label htmlFor="event-cover-alt" className="block space-y-2">
        <span className="text-sm font-medium">Cover alt text</span>
        <Input
          id="event-cover-alt"
          value={alt}
          onChange={(change) => {
            setAlt(change.target.value);
            setDirty(true);
          }}
          maxLength={500}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={reuseCover}
          onChange={(change) => {
            setReuseCover(change.target.checked);
            setDirty(true);
          }}
        />
        Reuse cover as the social image
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => void save()}
          disabled={state === "uploading" || state === "saving"}
        >
          {state === "saving" ? "Saving…" : "Save media"}
        </Button>
        {coverUrl ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setCoverUrl("");
              setDirty(true);
            }}
          >
            Remove cover
          </Button>
        ) : null}
        {!reuseCover && seoUrl ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSeoUrl("");
              setDirty(true);
            }}
          >
            Remove social image
          </Button>
        ) : null}
        {state === "conflict" ? (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Reload latest event
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (
                  window.confirm(
                    "Reapply your local cover, alt text, and social-image settings over the latest remote media settings?",
                  )
                )
                  void recoverConflict();
              }}
            >
              Reapply local media over latest
            </Button>
          </>
        ) : null}
        <span
          className="self-center text-sm text-muted-foreground"
          aria-live="polite"
        >
          {state === "uploading"
            ? `Uploading… ${uploadProgress}%`
            : state === "saving"
              ? "Saving…"
              : state === "saved"
                ? "Saved"
                : state === "offline"
                  ? "Offline — changes remain unsaved"
                  : state === "conflict"
                    ? "Conflict — reload or reapply to the latest version"
                    : dirty
                      ? "Unsaved changes"
                      : ""}
        </span>
        {state === "uploading" ? (
          <progress
            className="w-40 self-center"
            max={100}
            value={uploadProgress}
            aria-label="Upload progress"
          >
            {uploadProgress}%
          </progress>
        ) : null}
      </div>
    </div>
  );
}
