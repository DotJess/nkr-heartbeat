// NKR reminder heartbeat — headless-browser caller.
//
// Navigates a real headless Chromium to the token endpoint so Cloudflare's
// managed challenge is solved (a plain fetch/curl is blocked with a 403
// "Just a moment"). The server side is throttled and idempotent, so calling
// this every ~15 min is exactly the intended cadence; the per-session Reminder
// Sent flag prevents any double-send.
//
// Exit non-zero only on a genuine failure (challenge not solved, network error,
// or the endpoint reporting a bad token) so the Actions run shows red and the
// problem is visible rather than silently swallowed.

import { chromium } from 'playwright';

const TOKEN = process.env.NKR_TOKEN;
if (!TOKEN) {
  console.error('NKR_TOKEN env var is missing — set it as the Actions secret NKR_TOKEN.');
  process.exit(1);
}

const URL =
  'https://neurokindred.com/wp-admin/admin-ajax.php?action=nkr_trigger&token=' +
  encodeURIComponent(TOKEN);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  // networkidle so the CF challenge JS has time to run and redirect to the real
  // endpoint response before we read the body.
  const resp = await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  const status = resp ? resp.status() : 0;
  const body = await page.evaluate(() => document.body ? document.body.innerText : '');

  console.log('HTTP', status);
  console.log('Body:', body.slice(0, 500));

  if (/just a moment/i.test(body) || (resp && resp.headers()['cf-mitigated'])) {
    console.error('Cloudflare challenge was NOT solved — heartbeat did not reach PHP.');
    process.exit(2);
  }

  let json;
  try { json = JSON.parse(body); } catch { json = null; }

  if (json && json.success === true) {
    console.log('OK — reminder window pass fired. last_window_run =', json.data && json.data.last_window_run);
    process.exit(0);
  }
  if (json && json.success === false && String(json.data).toLowerCase().includes('bad token')) {
    console.error('Endpoint reached but token REJECTED — check the NKR_TOKEN secret matches NK_REMINDER_TOKEN.');
    process.exit(3);
  }

  console.error('Unexpected response — treating as failure so it is visible.');
  process.exit(4);
} finally {
  await browser.close();
}
