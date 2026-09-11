/**
 * Voltello -> TV dashboard bridge
 *
 * Runs on Cloudflare Workers (free tier).
 *
 *  - scheduled()  fires on the cron trigger, calls the Village Energy API,
 *                 normalises the response and stores it in KV.
 *  - fetch()      serves that stored snapshot to the dashboard page.
 *
 * The API token lives in a Worker secret, so it never reaches the browser.
 * Serving the JSON from the Worker also sidesteps CORS entirely.
 *
 * Secrets to set:   npx wrangler secret put VE_TOKEN
 * KV to create:     npx wrangler kv namespace create SNAPSHOT
 */

const KV_KEY = 'latest';

export default {

  /* ---------------- cron: pull from Voltello ---------------- */
  async scheduled(event, env, ctx) {
    try {
      const snapshot = await buildSnapshot(env);
      await env.SNAPSHOT.put(KV_KEY, JSON.stringify(snapshot));
    } catch (err) {
      // Keep the previous snapshot rather than blanking the screen.
      console.error('poll failed:', err.message);
    }
  },

  /* ---------------- browser: serve snapshot ---------------- */
  async fetch(request, env) {
    const stored = await env.SNAPSHOT.get(KV_KEY);

    if (!stored) {
      return json({ error: 'no data yet' }, 503);
    }
    return json(JSON.parse(stored));
  }
};


/* =====================================================================
   THE ONLY PART THAT NEEDS THE REAL API
   ---------------------------------------------------------------------
   Village Energy's spec is at
     https://docs.devices.village.energy/ve-x-api/index.html
   Once you have Customer Authorisation credentials, open that page,
   note the base URL and the asset / telemetry paths, and fill them in
   below. Everything else in this file stays as-is.
   ===================================================================== */

const VE_BASE = 'https://REPLACE-ME.village.energy';   // <- from the spec

async function buildSnapshot(env) {

  const headers = {
    'Authorization': `Bearer ${env.VE_TOKEN}`,
    'Accept': 'application/json'
  };

  // What hardware exists, and what it is doing right now.
  const [assets, telemetry] = await Promise.all([
    veGet('/assets',    headers),   // <- confirm path against the spec
    veGet('/telemetry', headers)    // <- confirm path against the spec
  ]);

  return normalise(assets, telemetry);
}


/* Maps a model string onto one of the dashboard's card icons. */
function iconType(model = '') {
  const m = model.toLowerCase();
  if (m.includes('inv'))    return 'inverter';
  if (m.includes('dongle')) return 'dongle';
  if (m.includes('meter'))  return 'meter';
  return 'generic';
}

async function veGet(path, headers) {
  const res = await fetch(VE_BASE + path, { headers });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}


/* ---------------------------------------------------------------------
   Reshape the Voltello response into what the dashboard expects.
   Adjust the right-hand side of each line to match the real field names.
   --------------------------------------------------------------------- */
function normalise(assets, telemetry) {

  return {
    updated: new Date().toISOString(),

    // Header band. Anything the API doesn't supply can simply be hardcoded
    // here — capacity and address don't change.
    site: {
      name:         assets.site?.name    ?? 'Lancefield',
      status:       assets.site?.status  ?? 'Normal',
      weather:      null,                  // see note at the foot of this file
      address:      '271 Parks Rd, Lancefield VIC 3435, Australia',
      capacity:     '80.00 kW',
      commissioned: '2025-08-01',
      contact:      null,
      contactInfo:  null,
      photo:        null                   // URL of a site photo, if you want one
    },

    metrics: {
      today:    telemetry.production?.today,
      revenue:  telemetry.revenue?.today ?? null,
      month:    telemetry.production?.month,
      year:     telemetry.production?.year,
      lifetime: telemetry.production?.lifetime
    },

    /* The page animates each wire from these. gridDir / batteryDir are the
       important bits — they decide which way the chevrons travel.

       Sign conventions vary between systems, so don't assume: check a real
       response at a moment you KNOW you're importing (after dark, say) and
       see whether grid power comes back positive or negative. Then set the
       comparison below to match. If you leave gridDir null the page falls
       back to comparing load against pv, which is right for a site with no
       battery. */
    flow: {
      pv:      telemetry.pv?.power,
      grid:    Math.abs(telemetry.grid?.power ?? 0),
      gridDir: telemetry.grid?.power < 0 ? 'import' : 'export',   // <- verify
      load:    telemetry.load?.power,

      battery:      telemetry.battery?.soc   ?? null,   // state of charge, %
      batteryPower: telemetry.battery?.power ?? null,   // kW
      batteryDir:   telemetry.battery?.power < 0 ? 'discharge' : 'charge'
    },

    devices: (assets.devices ?? []).map(d => ({
      name:   d.name ?? d.model,
      type:   iconType(d.model),
      status: d.state ?? (d.online ? 'Online' : 'Offline'),
      ok:     d.online !== false,
      fields: [
        ['SN',               d.serial               ],
        ['Model Name',       d.model                ],
        ['Active Power',     fmt(d.power,      'kW' )],
        ['Production Today', fmt(d.energyToday,'kWh')]
      ].filter(([, v]) => v !== undefined && v !== null)
    }))
  };
}

function fmt(v, unit) {
  return (v === null || v === undefined) ? null : `${Number(v).toFixed(2)} ${unit}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
}

/* ---------------------------------------------------------------------
   Note on the weather line in the header.

   The veXAPI is an energy API — it won't return "Sunny 13°C". If you want
   that line populated, add a second call in buildSnapshot() to a free
   weather service (open-meteo needs no key) using the site's lat/long,
   and set site.weather from it. Leave it null and the line just shows a
   dash.
   --------------------------------------------------------------------- */
