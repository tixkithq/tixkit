import { AppearanceSettings } from '@/features/settings/appearance-settings';

export default function Page() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">Appearance</h2>
        <p className="text-sm text-muted-foreground">Theme, direction, and layout preferences</p>
      </div>
      <AppearanceSettings />
    </div>
  );
}
