'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/empty-state';
import { PermissionGuard } from '@/components/permission-guard';
import { adminApi, type AdminBoxOfficeSettings, type AdminOrganization } from '@/lib/api';
import { Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { useBootstrap } from '@/context/bootstrap-provider';

const defaultBoxOfficeSettings: AdminBoxOfficeSettings = {
  enabled: true,
  allowedTenderTypes: ['cash', 'manual_card', 'comp'],
  requireBuyerEmail: false,
  receiptMode: 'email',
};

const tenderOptions: Array<{
  value: AdminBoxOfficeSettings['allowedTenderTypes'][number];
  label: string;
}> = [
  { value: 'cash', label: 'Cash' },
  { value: 'manual_card', label: 'Manual Card' },
  { value: 'comp', label: 'Comp' },
];

function cloneBoxOfficeSettings(settings?: AdminBoxOfficeSettings): AdminBoxOfficeSettings {
  return {
    ...(settings ?? defaultBoxOfficeSettings),
    allowedTenderTypes: [
      ...(settings?.allowedTenderTypes ?? defaultBoxOfficeSettings.allowedTenderTypes),
    ],
  };
}

export default function WorkspacePage() {
  return (
    <PermissionGuard required="settings.write">
      <WorkspacePageContent />
    </PermissionGuard>
  );
}

function WorkspacePageContent() {
  const {
    organizations,
    organizationId,
    loading: bootstrapLoading,
    error: bootstrapError,
  } = useBootstrap();
  const [organization, setOrganization] = React.useState<AdminOrganization | null>(null);
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [boxOfficeSettings, setBoxOfficeSettings] =
    React.useState<AdminBoxOfficeSettings>(defaultBoxOfficeSettings);
  const [eventDefaults, setEventDefaults] = React.useState<
    NonNullable<AdminOrganization['eventDefaults']>
  >({});
  const [savedVenues, setSavedVenues] = React.useState<Array<{ id: string; name: string }>>([]);
  const [savedVenuesLoading, setSavedVenuesLoading] = React.useState(false);
  const [savedVenuesError, setSavedVenuesError] = React.useState<string | null>(null);
  const [savedVenuesLoadVersion, setSavedVenuesLoadVersion] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveNotice, setSaveNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (bootstrapLoading) return;

    if (bootstrapError) {
      setError(bootstrapError);
      setOrganization(null);
      setName('');
      setSlug('');
      setBoxOfficeSettings(defaultBoxOfficeSettings);
      return;
    }

    const selectedOrganization = organizations.find((org) => org.id === organizationId) ?? null;
    setError(null);
    setOrganization(selectedOrganization);
    setName(selectedOrganization?.name ?? '');
    setSlug(selectedOrganization?.slug ?? '');
    setBoxOfficeSettings(cloneBoxOfficeSettings(selectedOrganization?.boxOfficeSettings));
    setEventDefaults(selectedOrganization?.eventDefaults ?? {});
  }, [bootstrapError, bootstrapLoading, organizationId, organizations]);

  React.useEffect(() => {
    if (!organizationId) {
      setSavedVenues([]);
      setSavedVenuesError(null);
      setSavedVenuesLoading(false);
      return;
    }

    let active = true;
    setSavedVenues([]);
    setSavedVenuesError(null);
    setSavedVenuesLoading(true);

    void (async () => {
      try {
        const result = await adminApi.listSavedVenues(organizationId);
        if (!active) return;
        if (!result.ok) {
          setSavedVenuesError(result.error.message);
          return;
        }
        setSavedVenues(result.data);
      } catch {
        if (active) {
          setSavedVenuesError('Saved venues could not be loaded. Try again.');
        }
      } finally {
        if (active) setSavedVenuesLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [organizationId, savedVenuesLoadVersion]);

  const updateBoxOfficeSettings = (changes: Partial<AdminBoxOfficeSettings>) => {
    setBoxOfficeSettings((current) => ({
      ...current,
      ...changes,
      allowedTenderTypes: changes.allowedTenderTypes ?? current.allowedTenderTypes,
    }));
  };

  const toggleTender = (
    tenderType: AdminBoxOfficeSettings['allowedTenderTypes'][number],
    checked: boolean,
  ) => {
    setBoxOfficeSettings((current) => {
      const nextTenderTypes = checked
        ? [...new Set([...current.allowedTenderTypes, tenderType])]
        : current.allowedTenderTypes.filter((value) => value !== tenderType);
      return {
        ...current,
        allowedTenderTypes:
          nextTenderTypes.length > 0 ? nextTenderTypes : current.allowedTenderTypes,
      };
    });
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaveNotice(null);
    if (!organization) {
      const message = 'No workspace is available to update';
      setSaveError(message);
      toast.error(message);
      return;
    }
    if (name.trim().length === 0) {
      const message = 'Workspace name is required';
      setSaveError(message);
      toast.error(message);
      return;
    }
    if (slug.trim().length === 0) {
      const message = 'Workspace slug is required';
      setSaveError(message);
      toast.error(message);
      return;
    }

    setSaving(true);
    try {
      const result = await adminApi.updateOrganization(organization.id, {
        name: name.trim(),
        slug: slug.trim(),
        boxOfficeSettings,
        eventDefaults,
      });

      if (!result.ok) {
        setSaveError(result.error.message);
        toast.error(result.error.message);
        return;
      }

      setOrganization(result.data);
      setName(result.data.name);
      setSlug(result.data.slug);
      setBoxOfficeSettings(cloneBoxOfficeSettings(result.data.boxOfficeSettings));
      setEventDefaults(result.data.eventDefaults ?? {});
      setSaveNotice('Workspace settings saved.');
      toast.success('Workspace settings saved');
    } catch {
      const message = 'Workspace settings could not be saved. Try again.';
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">Workspace</h2>
        <p className="text-sm text-muted-foreground">
          Workspace name, slug, and account-level details
        </p>
      </div>
      {bootstrapLoading ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Loading workspace settings...
          </CardContent>
        </Card>
      ) : error ? (
        <EmptyState icon={Building2} title="Workspace settings unavailable" description={error} />
      ) : !organization ? (
        <EmptyState
          icon={Building2}
          title="Select a workspace"
          description="Choose a workspace from the sidebar before editing workspace settings."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Workspace Details</CardTitle>
            <CardDescription>
              Configure your workspace name, slug, and box-office policy.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="org-name">Workspace Name</Label>
                <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-slug">Slug</Label>
                <Input id="org-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
              </div>
            </div>

            <div className="space-y-4 rounded-md border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <Label htmlFor="box-office-enabled">Box Office</Label>
                  <p className="text-sm text-muted-foreground">
                    Control at-door sales and accepted tender types for this workspace.
                  </p>
                </div>
                <Switch
                  id="box-office-enabled"
                  checked={boxOfficeSettings.enabled}
                  onCheckedChange={(checked) => updateBoxOfficeSettings({ enabled: checked })}
                  aria-label="Enable box-office sales"
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-[1fr_14rem]">
                <div className="space-y-2">
                  <Label>Accepted Tender Types</Label>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {tenderOptions.map((option) => (
                      <label
                        key={option.value}
                        className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm"
                      >
                        <Checkbox
                          checked={boxOfficeSettings.allowedTenderTypes.includes(option.value)}
                          onCheckedChange={(checked) =>
                            toggleTender(option.value, checked === true)
                          }
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="receipt-mode">Receipt Mode</Label>
                  <Select
                    value={boxOfficeSettings.receiptMode}
                    onValueChange={(value) =>
                      updateBoxOfficeSettings({
                        receiptMode: value as AdminBoxOfficeSettings['receiptMode'],
                      })
                    }
                  >
                    <SelectTrigger id="receipt-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="print">Print</SelectItem>
                      <SelectItem value="both">Email and Print</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Label
                htmlFor="require-buyer-email"
                className="flex min-h-10 items-center gap-2 text-sm"
              >
                <Checkbox
                  id="require-buyer-email"
                  checked={boxOfficeSettings.requireBuyerEmail}
                  onCheckedChange={(checked) =>
                    updateBoxOfficeSettings({ requireBuyerEmail: checked === true })
                  }
                />
                <span>Require buyer email for at-door orders</span>
              </Label>
            </div>

            <div className="space-y-4 rounded-md border p-4">
              <div>
                <Label>New event defaults</Label>
                <p className="text-sm text-muted-foreground">
                  Applied to new drafts before browser or payment-account fallbacks.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="event-default-timezone">Timezone</Label>
                  <Input
                    id="event-default-timezone"
                    value={eventDefaults.timezone ?? ''}
                    onChange={(change) =>
                      setEventDefaults((current) => ({
                        ...current,
                        timezone: change.target.value || undefined,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="event-default-currency">Currency</Label>
                  <Input
                    id="event-default-currency"
                    maxLength={3}
                    value={eventDefaults.currency ?? ''}
                    onChange={(change) =>
                      setEventDefaults((current) => ({
                        ...current,
                        currency: change.target.value.toUpperCase() || undefined,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="event-default-country">Country</Label>
                  <Input
                    id="event-default-country"
                    maxLength={2}
                    value={eventDefaults.country ?? ''}
                    onChange={(change) =>
                      setEventDefaults((current) => ({
                        ...current,
                        country: change.target.value.toUpperCase() || undefined,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-default-venue">Default saved venue</Label>
                <select
                  id="event-default-venue"
                  className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  value={eventDefaults.defaultVenueId ?? ''}
                  disabled={savedVenuesLoading || savedVenuesError !== null}
                  aria-describedby={
                    savedVenuesError
                      ? 'event-default-venue-error'
                      : savedVenuesLoading
                        ? 'event-default-venue-status'
                        : undefined
                  }
                  onChange={(change) =>
                    setEventDefaults((current) => ({
                      ...current,
                      defaultVenueId: change.target.value || null,
                    }))
                  }
                >
                  <option value="">No default venue</option>
                  {eventDefaults.defaultVenueId &&
                  !savedVenues.some((venue) => venue.id === eventDefaults.defaultVenueId) ? (
                    <option value={eventDefaults.defaultVenueId}>
                      Configured venue ({eventDefaults.defaultVenueId}) — unavailable
                    </option>
                  ) : null}
                  {savedVenues.map((venue) => (
                    <option key={venue.id} value={venue.id}>
                      {venue.name}
                    </option>
                  ))}
                </select>
                {savedVenuesLoading ? (
                  <output
                    id="event-default-venue-status"
                    className="text-sm text-muted-foreground"
                  >
                    Loading saved venues…
                  </output>
                ) : null}
                {savedVenuesError ? (
                  <div
                    id="event-default-venue-error"
                    role="alert"
                    className="flex flex-wrap items-center gap-2 text-sm text-destructive"
                  >
                    <span>{savedVenuesError}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setSavedVenuesLoadVersion((version) => version + 1)}
                    >
                      Retry saved venues
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-default-description">Default event description</Label>
                <textarea
                  id="event-default-description"
                  className="min-h-24 w-full rounded-md border bg-transparent p-3 text-sm"
                  value={eventDefaults.eventDescription ?? ''}
                  onChange={(change) =>
                    setEventDefaults((current) => ({
                      ...current,
                      eventDescription: change.target.value || undefined,
                    }))
                  }
                />
              </div>
            </div>

            {saving ? (
              <output id="workspace-save-status" className="text-sm text-muted-foreground">
                Saving workspace settings…
              </output>
            ) : saveError ? (
              <p id="workspace-save-error" role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            ) : saveNotice ? (
              <output id="workspace-save-status" className="text-sm text-success">
                {saveNotice}
              </output>
            ) : null}
            <Button
              onClick={handleSave}
              disabled={saving}
              aria-describedby={saveError ? 'workspace-save-error' : undefined}
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
