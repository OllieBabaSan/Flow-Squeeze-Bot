import { readFile } from 'node:fs/promises';

const file = process.env.BREAKOUT_FEED_FILE || '/var/lib/flow-squeeze/alerts-data/breakout-live-feed.json';
const dashboardUrl = process.env.BREAKOUT_DASHBOARD_URL;
const writeToken = process.env.BREAKOUT_DASHBOARD_WRITE_TOKEN;
const sitesToken = process.env.BREAKOUT_DASHBOARD_SITES_TOKEN;
if (!dashboardUrl || !writeToken || !sitesToken) throw new Error('Dashboard URL and push credentials are required');

let lastPushedAt;
async function pushLatest() {
  const body = await readFile(file, 'utf8');
  const feed = JSON.parse(body);
  if (!feed.generatedAt || feed.generatedAt === lastPushedAt) return;
  const response = await fetch(dashboardUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${writeToken}`,
      'content-type': 'application/json',
      'oai-sites-authorization': `Bearer ${sitesToken}`,
    },
    body,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`dashboard push HTTP ${response.status}`);
  lastPushedAt = feed.generatedAt;
  console.log(`pushed ${lastPushedAt} active=${feed.activeCount}`);
}

console.log('breakout dashboard publisher started');
for (;;) {
  try { await pushLatest(); }
  catch (error) { console.error(`push_failed ${error.message || error}`); }
  await new Promise(resolve => setTimeout(resolve, 5_000));
}
