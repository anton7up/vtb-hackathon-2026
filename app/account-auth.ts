import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { env } from 'cloudflare:workers';
import { sessionUser } from '../lib/bank-api.mjs';

export async function currentAccount() {
  const h = await headers();
  try { return await sessionUser(new Request('https://antiscam.internal', { headers: { Cookie: h.get('cookie') || '' } }), env.DB); }
  catch { return null; }
}
export async function requireAccount(role: 'client' | 'employee') {
  const user = await currentAccount();
  if (!user) redirect('/login');
  if (user.role !== role) redirect(user.role === 'employee' ? '/employee' : '/client');
  return user;
}
