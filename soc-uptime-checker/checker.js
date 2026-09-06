const tls = require('node:tls');

/*
 * Lightweight uptime checker: polls whatever the SOC has tagged as
 * monitorable and opens/links an incident on outage or upcoming TLS
 * certificate expiry.
 *
 * Targets are NOT configured here. Every sweep, this re-fetches
 * GET /assets and monitors every Asset whose monitoredUrl field is set —
 * adding or removing a site to watch is just editing that Asset in the
 * console, no redeploy of this container required. That also keeps "the
 * list of sites" living in exactly one place instead of drifting between
 * an env var and the Assets table.
 *
 * Per asset, checkThreshold/checkSeverity (both optional fields on the
 * Asset record) override this checker's own defaults below — a staging
 * site and a customer-facing API shouldn't necessarily page the same way.
 *
 * When a monitored asset crosses its consecutive-failure threshold, or its
 * certificate drops under the expiry warning window, this:
 *   1. Checks whether a matching OPEN/INVESTIGATING/CONTAINED incident
 *      already exists on that asset (by title, since a down-incident and
 *      a cert-expiry incident on the same asset are different problems and
 *      shouldn't suppress each other) — if one does, nothing new is
 *      created. This is what makes a container restart mid-outage safe:
 *      in-memory failure-streak state resets on restart, but the check
 *      against the SOC's own incident list prevents a duplicate incident
 *      from firing once the streak re-crosses the threshold.
 *   2. Otherwise opens a new incident, raises an alert linked to it, and
 *      attaches the asset — the same three records an analyst would
 *      otherwise create by hand.
 *
 * Every sweep prints exactly one line even when nothing is wrong —
 * `[ok] N asset(s) checked, all healthy` — so `docker compose logs` always
 * has a recent line to point to as proof the process is alive and actually
 * reaching the SOC API, instead of a fully healthy run looking identical
 * in the logs to a silently stuck one.
 *
 * No dependencies — Node's built-in fetch and tls module are enough for a
 * GET-and-time-it check, a certificate read, and a few small SOC API calls.
 *
 *   SOC_API_URL          base URL of the SOC backend, e.g. http://localhost:4000
 *   SOC_USERNAME         a service account with the ANALYST role — creating
 *                        alerts, incidents, and asset links all require it
 *                        (see alerts/incidents/assets controllers)
 *   SOC_PASSWORD
 *   INTERVAL_MS          how often to re-fetch assets and sweep them (default 60000)
 *   TIMEOUT_MS           per-request timeout, for both the HTTP check and the
 *                        TLS handshake (default 10000)
 *   FAIL_THRESHOLD       default consecutive failures before an incident opens,
 *                        for assets without their own checkThreshold (default 3,
 *                        to absorb a single blip rather than paging on noise)
 *   CHECK_RETRIES        immediate retries within one sweep before a check
 *                        counts as a single failure toward that threshold
 *                        (default 2 — so one dropped packet doesn't count the
 *                        same as a real outage)
 *   RETRY_DELAY_MS       delay between those in-sweep retries (default 1000)
 *   CERT_WARN_DAYS       open a MEDIUM incident once an https target's
 *                        certificate has this many days or fewer left
 *                        (default 14); an already-expired certificate (0 or
 *                        fewer days) opens a CRITICAL one instead
 */

const SOC_API_URL = requireEnv('SOC_API_URL').replace(/\/+$/, '');
const SOC_USERNAME = requireEnv('SOC_USERNAME');
const SOC_PASSWORD = requireEnv('SOC_PASSWORD');
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 60_000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 10_000);
const FAIL_THRESHOLD = Number(process.env.FAIL_THRESHOLD ?? 3);
const CHECK_RETRIES = Number(process.env.CHECK_RETRIES ?? 2);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 1_000);
const CERT_WARN_DAYS = Number(process.env.CERT_WARN_DAYS ?? 14);

/*
 * An outage isn't over just because the incident got closed — CLOSED and
 * RESOLVED both mean a human already decided this outage is handled, so a
 * fresh one starting later should open its own incident rather than being
 * silently absorbed into the old one.
 */
const OPEN_INCIDENT_STATUSES = new Set(['OPEN', 'INVESTIGATING', 'CONTAINED']);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Access tokens expire; rather than guess the lifetime, re-login lazily
 * whenever a call comes back 401 and cache the token in between.
 */
let cachedToken = null;

async function login() {
  const response = await fetch(`${SOC_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: SOC_USERNAME, password: SOC_PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(`SOC login failed: ${response.status} ${await response.text()}`);
  }

  const { accessToken } = await response.json();
  cachedToken = accessToken;
  return accessToken;
}

/*
 * Every SOC call goes through here so the 401-retry-once-after-relogin
 * logic lives in one place instead of being copy-pasted per call site.
 */
async function apiCall(method, path, body) {
  const token = cachedToken ?? (await login());

  const attempt = async (bearer) =>
    fetch(`${SOC_API_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  let response = await attempt(token);

  if (response.status === 401) {
    response = await attempt(await login());
  }

  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }

  return response.status === 204 ? null : response.json();
}

/*
 * Pulls every monitorable asset. take=100 is the API's own hard cap
 * (PaginationQueryDto) — fine for the number of assets a single SOC
 * deployment realistically has; a deployment with more than 100 assets
 * would need real pagination here instead of one flat fetch.
 */
async function fetchMonitoredAssets() {
  const page = await apiCall('GET', '/assets?take=100');
  return page.data.filter((asset) => Boolean(asset.monitoredUrl));
}

/*
 * The dedup check: an asset's own incident list is the source of truth for
 * "is there already an open incident for this exact problem", not this
 * process's memory, which is what makes a mid-outage container restart
 * safe. Matched by exact title rather than "any open incident on this
 * asset" so a down-incident and a cert-expiry incident on the same asset
 * don't suppress each other.
 */
async function hasOpenIncidentTitled(assetId, title) {
  const asset = await apiCall('GET', `/assets/${assetId}`);
  return asset.incidents.some(
    (link) => link.incident.title === title && OPEN_INCIDENT_STATUSES.has(link.incident.status),
  );
}

/*
 * Opens the incident, raises an alert linked to it, and attaches the
 * asset — the same three records an analyst would otherwise create by
 * hand. Shared by both the outage flow and the cert-expiry flow below;
 * only the title/description/severity differ between the two.
 */
async function openLinkedIncident(asset, { title, description, severity }) {
  const incident = await apiCall('POST', '/incidents', { title, description, severity });

  await apiCall('POST', '/alerts', {
    title,
    description,
    severity,
    source: 'uptime-checker',
    incidentId: incident.id,
  });

  await apiCall('POST', `/assets/${asset.id}/incidents/${incident.id}`);

  return incident;
}

/*
 * A plain GET with a timeout; "up" just means "responded before the
 * timeout with a non-5xx status" — a 404 or redirect loop is a site
 * problem too, but that's a product decision to refine later, not part of
 * this sketch.
 */
async function checkOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (response.status >= 500) {
      return { ok: false, reason: `HTTP ${response.status}`, latencyMs };
    }

    return { ok: true, latencyMs, status: response.status };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const reason = error.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : error.message;
    return { ok: false, reason, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

/*
 * A single dropped packet shouldn't count the same toward the failure
 * streak as a real outage, so a failed check gets a few immediate retries
 * within the same sweep before it's accepted as this sweep's result. The
 * cross-sweep FAIL_THRESHOLD is what actually decides "is this worth an
 * incident" — this just makes each individual data point more trustworthy.
 */
async function checkWithRetries(url) {
  let result = await checkOnce(url);

  for (let attempt = 0; !result.ok && attempt < CHECK_RETRIES; attempt += 1) {
    await sleep(RETRY_DELAY_MS);
    result = await checkOnce(url);
  }

  return result;
}

/*
 * Reads the peer certificate without validating trust (rejectUnauthorized:
 * false) — a self-signed or otherwise untrusted cert is a different
 * problem than "is it about to expire", and this only cares about the
 * latter. Returns days remaining; negative means already expired.
 */
function checkCertExpiry(url) {
  return new Promise((resolve, reject) => {
    let hostname;
    let port;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        resolve(null);
        return;
      }
      hostname = parsed.hostname;
      port = Number(parsed.port) || 443;
    } catch (error) {
      reject(error);
      return;
    }

    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();

        if (!cert || !cert.valid_to) {
          reject(new Error('No certificate returned'));
          return;
        }

        const daysRemaining = Math.floor(
          (new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000,
        );
        resolve(daysRemaining);
      },
    );

    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`TLS handshake timed out after ${TIMEOUT_MS}ms`));
    });
  });
}

async function checkCertificate(asset) {
  let daysRemaining;
  try {
    daysRemaining = await checkCertExpiry(asset.monitoredUrl);
  } catch (error) {
    console.error(`[cert-error] ${asset.name}: ${error.message}`);
    return true;
  }

  if (daysRemaining === null || daysRemaining > CERT_WARN_DAYS) {
    return false;
  }

  const expired = daysRemaining <= 0;
  const title = `${asset.name} TLS certificate ${expired ? 'has expired' : 'expiring soon'}`;

  try {
    if (await hasOpenIncidentTitled(asset.id, title)) {
      return true;
    }

    const incident = await openLinkedIncident(asset, {
      title,
      description: expired
        ? `${asset.monitoredUrl}'s TLS certificate expired ${Math.abs(daysRemaining)} day(s) ago.`
        : `${asset.monitoredUrl}'s TLS certificate expires in ${daysRemaining} day(s).`,
      severity: expired ? 'CRITICAL' : 'MEDIUM',
    });
    console.log(`[cert-incident] opened ${incident.id} for ${asset.name} (${daysRemaining}d remaining)`);
    return true;
  } catch (error) {
    console.error(`[error] could not raise cert-expiry incident for ${asset.name}: ${error.message}`);
    return true;
  }
}

/*
 * consecutiveFailures resets whenever an asset drops out of the monitored
 * list (monitoredUrl cleared) and rebuilds from scratch if it comes back —
 * simplest correct behaviour, and avoids the state map growing forever
 * across asset churn.
 */
const state = new Map();

/*
 * Both check functions return true when they logged something (a status
 * change, an incident, a skip, an error) and false when the check was
 * fully uneventful — that's what lets sweep() tell "silently healthy"
 * apart from "silently never ran" and print a heartbeat instead of
 * leaving every good sweep looking identical to a stuck process.
 */
async function checkAvailability(asset) {
  const threshold = asset.checkThreshold ?? FAIL_THRESHOLD;
  const severity = asset.checkSeverity ?? 'HIGH';
  const title = `${asset.name} is unreachable`;

  const result = await checkWithRetries(asset.monitoredUrl);
  const s = state.get(asset.id) ?? { consecutiveFailures: 0 };
  state.set(asset.id, s);

  if (result.ok) {
    if (s.consecutiveFailures >= threshold) {
      console.log(`[recovered] ${asset.name} responded (${result.status}, ${result.latencyMs}ms)`);
      s.consecutiveFailures = 0;
      return true;
    }
    s.consecutiveFailures = 0;
    return false;
  }

  s.consecutiveFailures += 1;
  console.log(`[down] ${asset.name} (${s.consecutiveFailures}/${threshold}): ${result.reason}`);

  if (s.consecutiveFailures !== threshold) {
    // Either below threshold (not yet worth acting on) or already past it
    // on an earlier sweep (already handled — see hasOpenIncidentTitled
    // above for why this process doesn't need to remember that itself).
    return true;
  }

  try {
    if (await hasOpenIncidentTitled(asset.id, title)) {
      console.log(`[skip] ${asset.name} already has an open incident, not creating another`);
      return true;
    }

    const incident = await openLinkedIncident(asset, {
      title,
      description: `${asset.monitoredUrl} failed ${s.consecutiveFailures} consecutive checks. Last error: ${result.reason}`,
      severity,
    });
    console.log(`[incident] opened ${incident.id} for ${asset.name}, linked to asset ${asset.id}`);
    return true;
  } catch (error) {
    // Step the counter back so the next sweep retries hitting threshold
    // instead of silently giving up on a real outage because the SOC
    // API blipped.
    s.consecutiveFailures = threshold - 1;
    console.error(`[error] could not raise incident for ${asset.name}: ${error.message}`);
    return true;
  }
}

async function sweep() {
  let assets;
  try {
    assets = await fetchMonitoredAssets();
  } catch (error) {
    console.error(`[error] could not fetch assets: ${error.message}`);
    return;
  }

  const seenIds = new Set(assets.map((asset) => asset.id));
  for (const id of state.keys()) {
    if (!seenIds.has(id)) {
      state.delete(id);
    }
  }

  if (assets.length === 0) {
    console.log(
      '[ok] no assets are currently monitored — set monitoredUrl on an Asset to add one',
    );
    return;
  }

  let loggedSomething = false;
  for (const asset of assets) {
    const availabilityLogged = await checkAvailability(asset);
    const certLogged = await checkCertificate(asset);
    loggedSomething = loggedSomething || availabilityLogged || certLogged;
  }

  /*
   * A fully uneventful sweep otherwise prints nothing, which is
   * indistinguishable in the logs from the process having silently died —
   * this is what turns "no news" into an actual visible heartbeat, once
   * per sweep, so `docker compose logs -f` always has a recent line to
   * point to as proof it's alive and actually reached the SOC API.
   */
  if (!loggedSomething) {
    console.log(`[ok] ${assets.length} asset(s) checked, all healthy`);
  }
}

async function main() {
  console.log(`Uptime checker starting: polling monitored assets every ${INTERVAL_MS}ms`);
  for (;;) {
    await sweep();
    await sleep(INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
