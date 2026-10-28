import { requireAccount } from '../account-auth';
import DashboardShell from '../dashboard-shell';
export const dynamic = 'force-dynamic';
export default async function ClientPage() {
  const user = await requireAccount('client');
  return <DashboardShell user={user} />;
}
