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
// Exit codes: 0 ok (includes a CONFIRMED Cloudflare-challenge skip — see
// below), 1 no token, 2 did not reach PHP and no CF challenge marker
// found — a real outage (site down, WP 500, empty body), stays red on
// purpose, 3 token rejected, 4 unexpected response. The reminder path
// ALONE decides red or green; nothing about the feed refresh below ever
// changes the exit code, it only ever logs (including as a ::warning::
// annotation).
//
// CLOUDFLARE SKIP (28/09/2026, Maryon condition, re-checked after a FAIL
// on the first cut): only skip-and-exit-0 when the page POSITIVELY shows
// a Cloudflare challenge (one of CF_CHALLENGE_MARKERS below matched in
// the body/HTML) — the first version keyed off the mere ABSENCE of a
// success JSON, which would have let a real outage (site down, WP 500,
// empty body, origin 5xx) go silently green. Anything that doesn't match
// a marker — empty body, a 5xx/error page, anything unrecognised — stays
// RED (exit 2), same as before this feature existed. Real reminder
// faults (bad token, unexpected response) still fail red as before too.
//
// FEED REFRESH (28/09/2026, TA a26d0f33): after the reminder hit, reuse
// this same page — Cloudflare is already cleared — to also ping
// nkta_feed_refresh so TA hub programme edits show within this cadence
// instead of the 15-min TTL. Order is fixed: reminder first, always.
// Bounded to 10s so a hung feed request can't hang the job. A 403 here
// means the feed action rejected a token the reminder JUST accepted —
// that is a server-side mismatch on the nkta_feed_refresh handler, not a
// bad secret (a bad NKR_TOKEN would already have failed nkr_trigger
// above) — logged loud as a warning, never a reason to rotate NKR_TOKEN,
// and never a reason to fail the job.

import { chromium } from 'playwright';

const TOKEN = process.env.NKR_TOKEN;
if (!TOKEN) {
  console.error('NKR_TOKEN env var is missing — set it as the Actions secret NKR_TOKEN.');
  process.exit(1);
}

// Redacts TOKEN out of any string before it hits the (public repo) log —
// Playwright's own navigation-error text can otherwise echo the full URL,
// token included.
const maskToken = (str) => str.split(TOKEN).join('[REDACTED]');

// Positive signals of an actual Cloudflare challenge page — checked against
// the page's HTML (script tags included) and its visible body text. Only a
// match here counts as a routine skip; anything else that fails to reach
// PHP (empty body, a 5xx/error page, a dead origin) is a real outage.
// Note: cf-mitigated is an HTTP response header, not body content, so it
// is deliberately not checked here as a body-text marker (it would never
// match and gives false confidence). A future header-based check would
// need to read the goto() response object directly.
const CF_CHALLENGE_MARKERS = [
  { name: 'Just a moment', test: (html, text) => text.includes('Just a moment') },
  {
    name: 'Enable JavaScript and cookies',
    test: (html, text) => text.includes('Enable JavaScript and cookies'),
  },
  { name: 'challenge-platform script', test: (html) => html.includes('challenge-platform') },
];

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
    .catch((e) => console.log('initial goto note:', maskToken(e.message.split('\n')[0])));

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
    const html = await page.content().catch(() => '');
    const matched = CF_CHALLENGE_MARKERS.find((m) => m.test(html, body));
    if (matched) {
      console.log(
        `::warning::skipped: Cloudflare challenge (marker: ${matched.name}) — did not reach PHP within timeout (runner IP not cleared). Routine site-side flakiness, not a code fault; exiting 0 so it does not alert.`
      );
      process.exit(0);
    }
    console.error(
      'Did NOT reach PHP within timeout AND no Cloudflare challenge marker was found — treating as a real outage/error, not a routine skip.'
    );
    process.exit(2);
  }

  let json;
  try {
    json = JSON.parse(body.trim());
  } catch {
    json = null;
  }

  let reminderExitCode;
  if (json && json.success === true) {
    console.log(
      'OK — reminder window pass fired. last_window_run =',
      json.data && json.data.last_window_run
    );
    reminderExitCode = 0;
  } else if (
    json &&
    json.success === false &&
    String(json.data).toLowerCase().includes('bad token')
  ) {
    console.error('Endpoint reached but token REJECTED — check the NKR_TOKEN secret.');
    reminderExitCode = 3;
  } else {
    console.error('Unexpected response — treating as failure so it is visible.');
    reminderExitCode = 4;
  }

  // Reminder is done and logged. Now, same page/context, fire the feed
  // refresh. Bounded to 10s. Nothing in this block ever changes the exit
  // code — the reminder result above is the only thing that decides red
  // or green.
  try {
    const FEED_URL =
      'https://neurokindred.com/wp-admin/admin-post.php?action=nkta_feed_refresh&token=' +
      encodeURIComponent(TOKEN);
    const feed = await Promise.race([
      page.evaluate(async (url) => {
        const r = await fetch(url);
        return { status: r.status, text: await r.text() };
      }, FEED_URL),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('feed refresh timed out after 10s')), 10000)
      ),
    ]);
    console.log('Feed refresh status:', feed.status, '(token masked)');
    if (feed.status === 200) {
      console.log('Feed refresh OK — hub rebuilt.');
    } else if (feed.status === 429) {
      console.log('Feed refresh rate-limited (429) — not a failure, skipping.');
    } else if (feed.status === 403) {
      console.log(
        '::warning::Feed refresh REJECTED (403) — nkr_trigger just accepted this same NKR_TOKEN, so this is a SERVER-SIDE mismatch on the nkta_feed_refresh handler, not a bad secret. Do NOT rotate NKR_TOKEN. Check the nkta_feed_refresh token check on the WP side.'
      );
    } else {
      console.log(
        'Feed refresh unexpected status', feed.status, '— logged, not failing the job.'
      );
    }
  } catch (e) {
    console.log(
      'Feed refresh request errored or timed out:', maskToken(e.message.split('\n')[0]), '— logged, not failing the job.'
    );
  }

  process.exit(reminderExitCode);
} finally {
  await browser.close();
}
