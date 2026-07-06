// netlify/functions/fundraiser.js
//
// Scrapes our public Give a Little fundraiser page SERVER-SIDE (this code
// runs on Netlify's servers, not in a visitor's browser) and returns a
// small, clean JSON summary that the site's front-end can safely fetch.
//
// Why this exists: Give a Little doesn't expose a public JSON API and
// doesn't set CORS headers that would let a browser fetch its page directly
// from another site. A server-to-server request has no such restriction,
// so this function does that fetch on our behalf and hands back just the
// numbers we need.
//
// Response shape:
//   { raised: number, goal: number|null, percent: number|null,
//     currency: "NZD", source: string, updatedAt: string }

const FUNDRAISER_URL = "https://givealittle.co.nz/fundraiser/join-us-help-keep-someone-warm-this-winter";

// In-memory cache. This helps on "warm" invocations (the same function
// instance handling back-to-back requests) but does NOT persist across
// cold starts — the Cache-Control header below is what actually protects
// Give a Little from being hit on every single page load.
let cache = { data: null, fetchedAt: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

function parseAmount(str) {
  return parseInt(str.replace(/,/g, ""), 10);
}

// Give a Little's page renders the total in one of a few different ways
// depending on whether the campaign has a capped goal and/or has received
// any donations yet. We check each pattern in turn.
function scrapeTotals(html) {
  // Has donations AND a capped goal: "$X</span> of $Y goal"
  let m = html.match(/text-3xl text-orange-500 font-bold">\$([\d,]+)<\/span>\s*of\s*\$([\d,]+)\s*goal/);
  if (m) return { raised: parseAmount(m[1]), goal: parseAmount(m[2]) };

  // Has donations, no capped goal: "$X</span> donated"
  m = html.match(/text-3xl text-orange-500 font-bold">\$([\d,]+)<\/span>\s*donated/);
  if (m) return { raised: parseAmount(m[1]), goal: null };

  // No donations yet, goal shown alone: "$Y</span> goal"
  m = html.match(/text-3xl font-bold">\$([\d,]+)<\/span>\s*goal/);
  if (m) return { raised: 0, goal: parseAmount(m[1]) };

  return null;
}

exports.handler = async function () {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    // Browser + CDN cache for 5 minutes — the main defense against hammering
    // Give a Little's servers on every visitor page load.
    "Cache-Control": "public, max-age=300",
  };

  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_MS) {
    return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
  }

  try {
    const res = await fetch(FUNDRAISER_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ProjectDignitySite/1.0)" },
    });
    if (!res.ok) throw new Error("Give a Little responded with HTTP " + res.status);

    const html = await res.text();
    const totals = scrapeTotals(html);
    if (!totals) throw new Error("Could not find fundraiser totals in the page HTML");

    const goal = totals.goal;
    const percent = goal ? Math.min(100, Math.round((totals.raised / goal) * 1000) / 10) : null;

    const data = {
      raised: totals.raised,
      goal,
      percent,
      currency: "NZD",
      source: FUNDRAISER_URL,
      updatedAt: new Date().toISOString(),
    };

    cache = { data, fetchedAt: now };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    // Prefer serving stale-but-good data over a hard error.
    if (cache.data) {
      return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
    }
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Unable to fetch fundraiser data", detail: String(err) }),
    };
  }
};
