'use client';

import * as React from 'react';
import { ImageIcon, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/empty-state';
import { PermissionGuard } from '@/components/permission-guard';
import { adminApi, type AdminBrand, type AdminBrandDomain } from '@/lib/api';
import { toast } from 'sonner';
import { useBootstrap } from '@/context/bootstrap-provider';

export default function BrandingPage() {
  return (
    <PermissionGuard required="settings.write">
      <BrandingPageContent />
    </PermissionGuard>
  );
}

function BrandingPageContent() {
  const {
    availableBrands,
    brandId,
    loading: bootstrapLoading,
    error: bootstrapError,
    updateBrand: updateBootstrapBrand,
  } = useBootstrap();
  const [brand, setBrand] = React.useState<AdminBrand | null>(null);
  const [brandName, setBrandName] = React.useState('');
  const [primaryColor, setPrimaryColor] = React.useState('#222222');
  const [supportUrl, setSupportUrl] = React.useState('');
  const [termsUrl, setTermsUrl] = React.useState('');
  const [privacyUrl, setPrivacyUrl] = React.useState('');
  const [refundPolicyUrl, setRefundPolicyUrl] = React.useState('');
  const [domain, setDomain] = React.useState('');
  const [domains, setDomains] = React.useState<AdminBrandDomain[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [addingDomain, setAddingDomain] = React.useState(false);
  const [uploadingLogo, setUploadingLogo] = React.useState(false);
  const [uploadingIcon, setUploadingIcon] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadBranding = React.useCallback(async () => {
    setLoading(true);
    setError(null);

    if (bootstrapLoading) return;

    if (bootstrapError) {
      setBrand(null);
      setDomains([]);
      setError(bootstrapError);
      setLoading(false);
      return;
    }

    const selectedBrand = availableBrands.find((candidate) => candidate.id === brandId) ?? null;
    setBrand(selectedBrand);
    setBrandName(selectedBrand?.name ?? '');
    setPrimaryColor(
      typeof selectedBrand?.theme.primaryColor === 'string'
        ? selectedBrand.theme.primaryColor
        : '#222222',
    );
    setSupportUrl(selectedBrand?.supportUrl ?? '');
    setTermsUrl(selectedBrand?.legalUrls?.terms ?? '');
    setPrivacyUrl(selectedBrand?.legalUrls?.privacy ?? '');
    setRefundPolicyUrl(selectedBrand?.legalUrls?.refundPolicy ?? '');
    setDomains(selectedBrand?.domains ?? []);
    setLoading(false);
  }, [availableBrands, bootstrapError, bootstrapLoading, brandId]);

  React.useEffect(() => {
    void loadBranding();
  }, [loadBranding]);

  const handleAddDomain = async () => {
    if (!brand) {
      toast.error('No brand is available for domain configuration');
      return;
    }

    const nextDomain = domain.trim().toLowerCase();
    if (!nextDomain) return;

    setAddingDomain(true);
    const result = await adminApi.addBrandDomain(brand.id, nextDomain, domains.length === 0);
    setAddingDomain(false);

    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }

    setDomains((current) => [result.data, ...current]);
    setDomain('');
    toast.success('Domain added');
  };

  const handleSave = async () => {
    if (!brand) {
      toast.error('No brand is available to update');
      return;
    }

    const nextBrandName = brandName.trim();
    if (!nextBrandName) {
      toast.error('Brand name is required');
      return;
    }

    setSaving(true);
    const nextSupportUrl = supportUrl.trim();
    const nextTermsUrl = termsUrl.trim();
    const nextPrivacyUrl = privacyUrl.trim();
    const nextRefundPolicyUrl = refundPolicyUrl.trim();
    const result = await adminApi.updateBrand(brand.id, {
      name: nextBrandName,
      theme: {
        ...brand.theme,
        primaryColor,
      },
      supportUrl: nextSupportUrl || undefined,
      legalUrls: {
        ...(nextTermsUrl ? { terms: nextTermsUrl } : {}),
        ...(nextPrivacyUrl ? { privacy: nextPrivacyUrl } : {}),
        ...(nextRefundPolicyUrl ? { refundPolicy: nextRefundPolicyUrl } : {}),
      },
    });
    setSaving(false);

    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }

    setBrand(result.data);
    updateBootstrapBrand(result.data);
    setBrandName(result.data.name);
    setSupportUrl(result.data.supportUrl ?? '');
    setTermsUrl(result.data.legalUrls.terms ?? '');
    setPrivacyUrl(result.data.legalUrls.privacy ?? '');
    setRefundPolicyUrl(result.data.legalUrls.refundPolicy ?? '');
    toast.success('Brand settings saved');
  };

  const handleBrandAssetUpload = async (file: File | undefined, variant: 'wordmark' | 'icon') => {
    if (!file) return;
    if (!brand) {
      toast.error('No brand is available for logo upload');
      return;
    }

    const setUploading = variant === 'wordmark' ? setUploadingLogo : setUploadingIcon;
    setUploading(true);
    const uploadResult = await adminApi.uploadArtifact({
      purpose: 'brand_logo',
      file,
      brandId: brand.id,
      metadata: { source: 'admin_branding', variant },
    });
    if (!uploadResult.ok) {
      setUploading(false);
      toast.error(uploadResult.error.message);
      return;
    }

    const assetTheme =
      variant === 'wordmark'
        ? {
            logoUrl: uploadResult.data.downloadUrl,
            logoArtifactId: uploadResult.data.artifactId,
          }
        : {
            iconUrl: uploadResult.data.downloadUrl,
            iconArtifactId: uploadResult.data.artifactId,
          };
    const updateResult = await adminApi.updateBrand(brand.id, {
      theme: { ...brand.theme, ...assetTheme },
    });
    setUploading(false);

    if (!updateResult.ok) {
      toast.error(updateResult.error.message);
      return;
    }

    setBrand(updateResult.data);
    updateBootstrapBrand(updateResult.data);
    toast.success(variant === 'wordmark' ? 'Wordmark uploaded' : 'Brand icon uploaded');
  };

  const handleBrandAssetRemove = async (variant: 'wordmark' | 'icon') => {
    if (!brand) return;
    const setUploading = variant === 'wordmark' ? setUploadingLogo : setUploadingIcon;
    setUploading(true);
    const nextTheme = { ...brand.theme };
    if (variant === 'wordmark') {
      delete nextTheme.logoUrl;
      delete nextTheme.logoArtifactId;
    } else {
      delete nextTheme.iconUrl;
      delete nextTheme.iconArtifactId;
    }
    const result = await adminApi.updateBrand(brand.id, { theme: nextTheme });
    setUploading(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    setBrand(result.data);
    updateBootstrapBrand(result.data);
    toast.success(variant === 'wordmark' ? 'Custom wordmark removed' : 'Custom icon removed');
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">Brand</h2>
        <p className="text-sm text-muted-foreground">
          Checkout identity, colors, domains, and event page defaults
        </p>
      </div>
      {bootstrapLoading || loading ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Loading branding settings...
          </CardContent>
        </Card>
      ) : error ? (
        <EmptyState
          icon={ImageIcon}
          title="Brand settings unavailable"
          description={error}
          action={
            <Button variant="outline" onClick={() => void loadBranding()}>
              Retry
            </Button>
          }
        />
      ) : !brand ? (
        <EmptyState
          icon={ImageIcon}
          title="Select a brand"
          description="Choose a brand from the sidebar before configuring checkout identity."
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Brand Details</CardTitle>
              <CardDescription>
                Set the public-facing brand name for checkout and event pages.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="brand-name">Brand Name</Label>
                <Input
                  id="brand-name"
                  value={brandName}
                  onChange={(event) => setBrandName(event.target.value)}
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Brand logo system</CardTitle>
              <CardDescription>
                Add a wide wordmark for customer-facing headers and a square icon for compact app
                surfaces.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-4 rounded-xl border bg-muted/20 p-4 sm:flex-row sm:items-center">
                <div className="flex h-28 w-full items-center justify-center overflow-hidden rounded-lg border bg-[#fbfaf7] p-5 sm:w-56">
                  {typeof brand.theme.logoUrl === 'string' && brand.theme.logoUrl ? (
                    <img
                      src={brand.theme.logoUrl}
                      alt={`${brand.name} logo`}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="space-y-2 text-center text-muted-foreground">
                      <ImageIcon className="mx-auto size-6" />
                      <p className="text-xs">No custom logo</p>
                    </div>
                  )}
                </div>
                <div className="flex-1 space-y-3">
                  <div>
                    <p className="text-sm font-medium">
                      {brand.theme.logoUrl ? 'Wordmark active' : 'Add your wordmark'}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Used in lifecycle emails, checkout, and event-page headers. A transparent PNG
                      or WebP with wide proportions works best.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {uploadingLogo ? (
                      <Button type="button" variant="outline" disabled>
                        <Upload className="size-4" />
                        Updating…
                      </Button>
                    ) : (
                      <Button asChild variant="outline">
                        <Label htmlFor="brand-logo-upload" className="cursor-pointer">
                          <Upload className="size-4" />
                          {brand.theme.logoUrl ? 'Replace wordmark' : 'Upload wordmark'}
                        </Label>
                      </Button>
                    )}
                    {brand.theme.logoUrl ? (
                      <Button
                        disabled={uploadingLogo}
                        onClick={() => void handleBrandAssetRemove('wordmark')}
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 className="size-4" />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Input
                  id="brand-logo-upload"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={(event) => {
                    void handleBrandAssetUpload(event.target.files?.[0], 'wordmark');
                    event.currentTarget.value = '';
                  }}
                />
              </div>
              <div className="flex flex-col gap-4 rounded-xl border bg-muted/20 p-4 sm:flex-row sm:items-center">
                <div className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-[#fbfaf7] p-4">
                  {typeof brand.theme.iconUrl === 'string' && brand.theme.iconUrl ? (
                    <img
                      src={brand.theme.iconUrl}
                      alt={`${brand.name} icon`}
                      className="size-full object-contain"
                    />
                  ) : (
                    <img
                      src="/brand/tixkit-symbol.svg"
                      alt="Tixkit default icon"
                      className="size-full object-contain"
                    />
                  )}
                </div>
                <div className="flex-1 space-y-3">
                  <div>
                    <p className="text-sm font-medium">
                      {brand.theme.iconUrl
                        ? 'Custom app icon active'
                        : 'Using the Tixkit fallback icon'}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Used in the sidebar, collapsed navigation, and other square brand surfaces.
                      Upload a transparent square PNG or WebP.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {uploadingIcon ? (
                      <Button type="button" variant="outline" disabled>
                        <Upload className="size-4" />
                        Updating…
                      </Button>
                    ) : (
                      <Button asChild variant="outline">
                        <Label htmlFor="brand-icon-upload" className="cursor-pointer">
                          <Upload className="size-4" />
                          {brand.theme.iconUrl ? 'Replace icon' : 'Upload icon'}
                        </Label>
                      </Button>
                    )}
                    {brand.theme.iconUrl ? (
                      <Button
                        disabled={uploadingIcon}
                        onClick={() => void handleBrandAssetRemove('icon')}
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 className="size-4" />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Input
                  id="brand-icon-upload"
                  aria-label={brand.theme.iconUrl ? 'Replace icon' : 'Upload icon'}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={(event) => {
                    void handleBrandAssetUpload(event.target.files?.[0], 'icon');
                    event.currentTarget.value = '';
                  }}
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Brand Colors</CardTitle>
              <CardDescription>
                Set the primary color for checkout pages, widgets, and wallet passes.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-2">
                  <Label htmlFor="brand-primary-color-picker">Primary color</Label>
                  <input
                    id="brand-primary-color-picker"
                    type="color"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    className="size-10 cursor-pointer rounded-md border"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="brand-primary-color-hex">Hex value</Label>
                  <Input
                    id="brand-primary-color-hex"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    className="w-32"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Legal & Support Links</CardTitle>
              <CardDescription>
                Buyer-facing links shown in checkout and event page footers.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="brand-support-url">Support URL</Label>
                <Input
                  id="brand-support-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/support"
                  value={supportUrl}
                  onChange={(event) => setSupportUrl(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-terms-url">Terms URL</Label>
                <Input
                  id="brand-terms-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/terms"
                  value={termsUrl}
                  onChange={(event) => setTermsUrl(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-privacy-url">Privacy URL</Label>
                <Input
                  id="brand-privacy-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/privacy"
                  value={privacyUrl}
                  onChange={(event) => setPrivacyUrl(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-refund-policy-url">Refund policy URL</Label>
                <Input
                  id="brand-refund-policy-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/refunds"
                  value={refundPolicyUrl}
                  onChange={(event) => setRefundPolicyUrl(event.target.value)}
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Custom Domains</CardTitle>
              <CardDescription>
                Configure custom domains for your event pages and checkout.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-2">
                  <Label htmlFor="brand-domain">Domain</Label>
                  <Input
                    id="brand-domain"
                    placeholder="events.example.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddDomain();
                    }}
                  />
                </div>
                <Button onClick={handleAddDomain}>Add</Button>
              </div>
              {domains.length > 0 && (
                <div className="space-y-2">
                  {domains.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between rounded-lg border p-3"
                    >
                      <code className="text-sm font-mono">{d.domain}</code>
                      <Badge variant={d.isVerified ? 'default' : 'secondary'}>
                        {d.isVerified ? 'verified' : d.sslStatus}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
              <Button onClick={handleSave} disabled={saving || addingDomain}>
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
