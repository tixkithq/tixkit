import { redirect } from 'next/navigation';

import { routes } from '@/lib/routes';

export default function TeamSettingsRedirect() {
  redirect(routes.settingsMembers);
}
