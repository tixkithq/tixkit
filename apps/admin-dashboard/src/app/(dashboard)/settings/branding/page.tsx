'use client';

import * as React from 'react';
import { Upload, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/empty-state';
import { adminApi, type AdminBrand, type AdminBrandDomain } from '@/lib/api';
import { toast } from 'sonner';
import { useBootstrap } from '@/context/bootstrap-provider';

export default function BrandingPage() {
  const {
    availableBrands,
    brandId,
    loading: bootstrapLoading,
    error: bootstrapError,
  } = useBootstrap();
  const [brand, setBrand] = React.useState<AdminBrand | null>(null);
  const [brandName, setBrandName] = React.useState('');
  const [primaryColor, setPrimaryColor] = React.useState('#222222');
  const [domain, setDomain] = React.useState('');
  const [domains, setDomains] = React.useState<AdminBrandDomain[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [addingDomain, setAddingDomain] = React.useState(false);
  const [uploadingLogo, setUploadingLogo] = React.useState(false);
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
    const result = await adminApi.updateBrand(brand.id, {
      name: nextBrandName,
      theme: {
        ...brand.theme,
        primaryColor,
      },
    });
    setSaving(false);

    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }

    setBrand(result.data);
    setBrandName(result.data.name);
    toast.success('Brand settings saved');
  };

  const handleLogoUpload = async (file: File | undefined) => {
    if (!file) return;
    if (!brand) {
      toast.error('No brand is available for logo upload');
      return;
    }

    setUploadingLogo(true);
    const uploadResult = await adminApi.uploadArtifact({
      purpose: 'brand_logo',
      file,
      brandId: brand.id,
      metadata: { source: 'admin_branding' },
    });
    if (!uploadResult.ok) {
      setUploadingLogo(false);
      toast.error(uploadResult.error.message);
      return;
    }

    const updateResult = await adminApi.updateBrand(brand.id, {
      theme: {
        ...brand.theme,
        logoUrl: uploadResult.data.downloadUrl,
        logoArtifactId: uploadResult.data.artifactId,
      },
    });
    setUploadingLogo(false);

    if (!updateResult.ok) {
      toast.error(updateResult.error.message);
      return;
    }

    setBrand(updateResult.data);
    toast.success('Logo uploaded');
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
              <CardTitle>Logo</CardTitle>
              <CardDescription>
                Upload the brand logo for checkout pages and emails.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="flex size-16 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                  {typeof brand.theme.logoUrl === 'string' && brand.theme.logoUrl ? (
                    <img
                      src={brand.theme.logoUrl}
                      alt={`${brand.name} logo`}
                      className="size-full object-contain"
                    />
                  ) : (
                    <ImageIcon className="size-6 text-muted-foreground" />
                  )}
                </div>
                {uploadingLogo ? (
                  <Button type="button" variant="outline" disabled>
                    <Upload className="size-4" />
                    Uploading...
                  </Button>
                ) : (
                  <Button asChild variant="outline">
                    <Label htmlFor="brand-logo-upload" className="cursor-pointer">
                      <Upload className="size-4" />
                      Upload Logo
                    </Label>
                  </Button>
                )}
                <Input
                  id="brand-logo-upload"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="sr-only"
                  onChange={(event) => {
                    void handleLogoUpload(event.target.files?.[0]);
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
                Set the primary color for your checkout pages and widgets.
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
