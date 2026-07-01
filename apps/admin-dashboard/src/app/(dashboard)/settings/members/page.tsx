import { PermissionGuard } from '@/components/permission-guard';
import { TeamView } from '@/features/team/team-view';

export default function Page() {
  return (
    <PermissionGuard required="settings.write">
      <TeamView />
    </PermissionGuard>
  );
}
