import { env } from 'cloudflare:workers';
import { bankApi } from '../../../lib/bank-api.mjs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return bankApi(request, env.DB, env); }
export async function POST(request: Request) { return bankApi(request, env.DB, env); }
