import { fetchPage } from './fetch-page.mjs';
import { analyzePage, unavailableReport } from './analyze.mjs';
import { DEMO_SCENARIOS } from './fixtures.mjs';
import { createCloudflareResolver } from './dns-https.mjs';
import { readBrowserDocument } from './browser-page.mjs';

process.once('message', async payload => {
  let report;
  const demo = payload?.demoScenario ? DEMO_SCENARIOS[payload.demoScenario] : null;
  const input = demo?.url || payload?.url;
  try {
    if (typeof input !== 'string' || input.length > 2048) throw new Error('invalid_url');
    const signal = AbortSignal.timeout(22000);
    const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
    const page = demo ? { html: demo.html, finalUrl: demo.url, trace: [{ url: demo.url, status: 200 }] } : await fetchPage(input, {
      signal: fetchSignal,
      resolver: payload.dns === 'cloudflare' ? createCloudflareResolver(fetchSignal) : undefined,
    });
    if (!demo && payload.loader === 'browser') {
      const dom = await readBrowserDocument({ url: page.finalUrl, html: page.html, signal, executablePath: payload.executablePath });
      page.html = dom.html;
    }
    report = analyzePage({ inputUrl: input, ...page, source: demo ? 'demo_fixture' : 'live' });
    if (!demo && report.status === 'completed') report.retrieval = { loader: payload.loader === 'browser' ? 'browser_static' : 'static', dns: payload.dns === 'cloudflare' ? 'cloudflare' : 'system', javascript_executed: false, subresources_loaded: false };
  } catch (error) { report = unavailableReport(input, error.code || 'network_failed', demo ? 'demo_fixture' : 'live'); }
  process.send(report, () => process.disconnect());
});
