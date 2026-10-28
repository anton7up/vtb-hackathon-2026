import { requireAccount } from '../account-auth';
import DashboardShell from '../dashboard-shell';
export const dynamic = 'force-dynamic';
export default async function EmployeePage() {
  const user = await requireAccount('employee');
  return <DashboardShell user={user} />;
}
