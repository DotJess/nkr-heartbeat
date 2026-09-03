// NKR reminder heartbeat — headless-browser caller.
//
// Navigates a real headless Chromium to the token endpoint so Cloudflare's
// managed challenge is solved (a plain fetch/curl is blocked with a 403
// "Just a moment"). The server side is throttled and idempotent, so calling
// this every ~15 min is exactly the intended cadence; the per-session Reminder
// Sent flag prevents any double-send.
//
// WAIT STRATEGY: do NOT use waitUntil:'networkidle' — Cloudflare's challenge
// page keeps network activity alive, so networkidle never settles and the nav
// times out. Instead we load with 'domcontentloaded', then POLL the body until
// the challenge has solved client-side and the real admin-ajax JSON appears.
//
// Exit codes: 0 ok, 1 no token, 2 challenge not solved (never reached PHP),
// 3 token rejected, 4 unexpected response — so a genuine failure shows red.

import { chromium } from 'playwright';

const TOKEN = process.env.NKR_TOKEN;
if (!TOKEN) {
  console.error('NKR_TOKEN env var is missing — set it as the Actions secret NKR_TOKEN.');
  process.exit(1);
}

const URL =
  'https://neurokindred.com/wp-admin/admin-ajax.php?action=nkr_trigger&token=' +
  encodeURIComponent(TOKEN);

const browser = await chromium.launch({
  args: ['--disable-blink-features=AutomationControlled'],
});
try {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-AU',
  });
  const page = await ctx.newPage();

  // domcontentloaded, not networkidle. Ignore a nav timeout here; the poll below
  // is the real readiness check.
  await page
    .goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch((e) => console.log('initial goto note:', e.message.split('\n')[0]));

  // Poll up to ~50s for the challenge to solve and the JSON to appear.
  let body = '';
  let reachedPhp = false;
  for (let i = 0; i < 25; i++) {
    body = await page
      .evaluate(() => (document.body ? document.body.innerText : ''))
      .catch(() => '');
    if (body.includes('"success"')) {
      reachedPhp = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  console.log('Final body (first 300):', body.slice(0, 300).replace(/\s+/g, ' '));

  if (!reachedPhp) {
    console.error(
      'Did NOT reach PHP within timeout — Cloudflare challenge was not solved from this runner IP.'
    );
    process.exit(2);
  }

  let json;
  try {
    json = JSON.parse(body.trim());
  } catch {
    json = null;
  }

  if (json && json.success === true) {
    console.log(
      'OK — reminder window pass fired. last_window_run =',
      json.data && json.data.last_window_run
    );
    process.exit(0);
  }
  if (
    json &&
    json.success === false &&
    String(json.data).toLowerCase().includes('bad token')
  ) {
    console.error('Endpoint reached but token REJECTED — check the NKR_TOKEN secret.');
    process.exit(3);
  }

  console.error('Unexpected response — treating as failure so it is visible.');
  process.exit(4);
} finally {
  await browser.close();
}
