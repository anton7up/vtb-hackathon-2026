import { redirect } from 'next/navigation';
import { currentAccount } from './account-auth';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const user = await currentAccount();
  redirect(user ? user.role === 'employee' ? '/employee' : '/client' : '/login');
}
