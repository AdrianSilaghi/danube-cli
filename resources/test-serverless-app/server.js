const http = require('node:http');
const Redis = require('ioredis');
const { Client } = require('pg');

const PORT = process.env.PORT || 8080;

// --- In-memory stats (resets on cold start) ---
const startTime = Date.now();
let totalRequests = 0;
let totalResponseTime = 0;
const requestTimestamps = [];
let peakRps = 0;

const SAFE_ENV_KEYS = ['NODE_ENV', 'PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION', 'HOSTNAME'];

function getUptime() {
  const ms = Date.now() - startTime;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return { hours: h, minutes: m, seconds: sec, totalSeconds: s };
}

function getRps() {
  const now = Date.now();
  const cutoff = now - 60000;
  while (requestTimestamps.length && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }
  const rps = requestTimestamps.length / 60;
  if (rps > peakRps) peakRps = rps;
  return rps;
}

function getStats() {
  const mem = process.memoryUsage();
  const uptime = getUptime();
  return {
    uptime: uptime,
    totalRequests,
    rps: Math.round(getRps() * 100) / 100,
    peakRps: Math.round(peakRps * 100) / 100,
    avgResponseTime: totalRequests > 0 ? Math.round(totalResponseTime / totalRequests * 100) / 100 : 0,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function getSafeEnv() {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function buildDashboardHtml() {
  const stats = getStats();
  const env = getSafeEnv();
  const pad = (n) => String(n).padStart(2, '0');
  const uptimeStr = `${pad(stats.uptime.hours)}:${pad(stats.uptime.minutes)}:${pad(stats.uptime.seconds)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DanubeData Serverless</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --green:#54A65D;--blue:#0073DB;--bg:#06182D;--card:#0a2240;
  --border:#162d4d;--text:#e2e8f0;--muted:#8899aa;--card-hover:#0d2a4d;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column}
header{background:linear-gradient(135deg,#071e36,#0a2a4a);border-bottom:1px solid var(--border);padding:1rem 1.5rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem}
.logo{display:flex;align-items:center;gap:.75rem;font-size:1.25rem;font-weight:700}
.logo svg{width:28px;height:28px}
.header-right{display:flex;align-items:center;gap:1rem}
.status{display:flex;align-items:center;gap:.5rem;font-size:.875rem;font-weight:500;color:var(--green)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.clock{font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-size:1.1rem;font-variant-numeric:tabular-nums;color:var(--text);letter-spacing:.5px}
main{flex:1;padding:1.5rem;max-width:1200px;width:100%;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1rem;margin-bottom:1rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;transition:background .2s}
.card:hover{background:var(--card-hover)}
.card-green{border-left:3px solid var(--green)}
.card-blue{border-left:3px solid var(--blue)}
.card h2{font-size:.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:1rem}
.card dl{display:grid;grid-template-columns:auto 1fr;gap:.5rem .75rem}
.card dt{color:var(--muted);font-size:.8125rem}
.card dd{font-size:.875rem;font-variant-numeric:tabular-nums;text-align:right}
.env-grid{display:grid;grid-template-columns:auto 1fr;gap:.35rem .75rem}
.env-grid dt{color:var(--green);font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-size:.8125rem}
.env-grid dd{font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-size:.8125rem;word-break:break-all;text-align:right}
.profiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin-bottom:1rem}
.profile{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1rem;text-align:center;transition:background .2s,border-color .2s}
.profile:hover{background:var(--card-hover);border-color:var(--green)}
.profile-name{font-weight:700;font-size:.9375rem;margin-bottom:.5rem;color:var(--green)}
.profile-spec{font-size:.75rem;color:var(--muted);margin-bottom:.25rem}
.profile-price{font-size:1.125rem;font-weight:700;margin-top:.5rem}
.pricing-details{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.25rem}
.pricing-details h2{font-size:.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:1rem}
.pricing-cols{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.pricing-cols h3{font-size:.8125rem;color:var(--blue);margin-bottom:.5rem;font-weight:600}
.pricing-cols ul{list-style:none;font-size:.8125rem;color:var(--muted)}
.pricing-cols li{padding:.2rem 0}
.pricing-cols li span{color:var(--text);float:right;font-variant-numeric:tabular-nums}
footer{border-top:1px solid var(--border);padding:.75rem 1.5rem;text-align:center;font-size:.75rem;color:var(--muted)}
footer a{color:var(--blue);text-decoration:none}
footer a:hover{text-decoration:underline}
@media(max-width:700px){
  header{flex-direction:column;text-align:center}
  .pricing-cols{grid-template-columns:1fr}
}
</style>
</head>
<body>
<header>
  <div class="logo">
    <svg viewBox="0 0 28 28" fill="none"><circle cx="14" cy="14" r="13" stroke="#54A65D" stroke-width="2"/><path d="M8 14l4 4 8-8" stroke="#54A65D" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    DanubeData Serverless
  </div>
  <div class="header-right">
    <span class="status"><span class="dot"></span>Running</span>
    <span class="clock" id="clock">${uptimeStr}</span>
  </div>
</header>
<main>
  <div class="grid">
    <div class="card card-green">
      <h2>Container Info</h2>
      <dl>
        <dt>Service</dt><dd>${env.K_SERVICE || 'local'}</dd>
        <dt>Revision</dt><dd>${env.K_REVISION || '—'}</dd>
        <dt>Runtime</dt><dd>Node ${process.version}</dd>
        <dt>Region</dt><dd>fsn1</dd>
        <dt>Uptime</dt><dd id="uptime">${uptimeStr}</dd>
      </dl>
    </div>
    <div class="card card-blue">
      <h2>Request Stats</h2>
      <dl>
        <dt>Total Requests</dt><dd id="s-total">${stats.totalRequests}</dd>
        <dt>Requests/sec</dt><dd id="s-rps">${stats.rps}</dd>
        <dt>Avg Response</dt><dd id="s-avg">${stats.avgResponseTime} ms</dd>
        <dt>Peak RPS</dt><dd id="s-peak">${stats.peakRps}</dd>
        <dt>Memory (RSS)</dt><dd id="s-mem">${formatBytes(stats.memory.rss)}</dd>
      </dl>
    </div>
  </div>
  <div class="card" style="margin-bottom:1rem">
    <h2>Environment</h2>
    <dl class="env-grid">
      ${Object.entries(env).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
      ${Object.keys(env).length === 0 ? '<dt style="color:var(--muted)">No Knative env vars detected</dt><dd>—</dd>' : ''}
    </dl>
  </div>
  <div class="profiles">
    <div class="profile"><div class="profile-name">Micro</div><div class="profile-spec">0.25 vCPU</div><div class="profile-spec">128 MB</div><div class="profile-price">&euro;5/mo</div></div>
    <div class="profile"><div class="profile-name">Small</div><div class="profile-spec">0.5 vCPU</div><div class="profile-spec">256 MB</div><div class="profile-price">&euro;10/mo</div></div>
    <div class="profile"><div class="profile-name">Medium</div><div class="profile-spec">1 vCPU</div><div class="profile-spec">512 MB</div><div class="profile-price">&euro;20/mo</div></div>
    <div class="profile"><div class="profile-name">Large</div><div class="profile-spec">2 vCPU</div><div class="profile-spec">1 GB</div><div class="profile-price">&euro;40/mo</div></div>
  </div>
  <div class="pricing-details">
    <h2>Pay-per-use Pricing</h2>
    <div class="pricing-cols">
      <div>
        <h3>Usage Rates</h3>
        <ul>
          <li>vCPU-second <span>&euro;0.000012</span></li>
          <li>GiB-second <span>&euro;0.000002</span></li>
          <li>Per 1M requests <span>&euro;0.12</span></li>
          <li>Egress per GB <span>&euro;0.09</span></li>
        </ul>
      </div>
      <div>
        <h3>Free Tier (monthly)</h3>
        <ul>
          <li>Requests <span>2,000,000</span></li>
          <li>vCPU-seconds <span>250,000</span></li>
          <li>GiB-seconds <span>500,000</span></li>
          <li>Egress <span>5 GB</span></li>
        </ul>
      </div>
    </div>
  </div>
</main>
<footer>Powered by <a href="https://danubedata.ro" target="_blank" rel="noopener">DanubeData</a> Serverless Platform</footer>
<script>
(function(){
  var startUptime=${stats.uptime.totalSeconds};
  var t0=Date.now();
  function pad(n){return String(n).padStart(2,'0')}
  function fmt(s){var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return pad(h)+':'+pad(m)+':'+pad(sec)}
  function fmtBytes(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB'}
  function tick(){
    var elapsed=Math.floor((Date.now()-t0)/1000);
    var cur=startUptime+elapsed;
    var str=fmt(cur);
    document.getElementById('clock').textContent=str;
    document.getElementById('uptime').textContent=str;
  }
  function poll(){
    fetch('/api/stats').then(function(r){return r.json()}).then(function(d){
      document.getElementById('s-total').textContent=d.totalRequests;
      document.getElementById('s-rps').textContent=d.rps;
      document.getElementById('s-avg').textContent=d.avgResponseTime+' ms';
      document.getElementById('s-peak').textContent=d.peakRps;
      document.getElementById('s-mem').textContent=fmtBytes(d.memory.rss);
      startUptime=d.uptime.totalSeconds;
      t0=Date.now();
    }).catch(function(){});
  }
  setInterval(tick,1000);
  setInterval(poll,2000);
  tick();
})();
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const start = Date.now();
  const method = req.method;
  const url = req.url;

  // Log every incoming request
  console.log(JSON.stringify({
    level: 'INFO',
    message: `${method} ${url}`,
    timestamp: new Date().toISOString(),
    method,
    url,
    remoteAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] || '-',
  }));

  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      level: res.statusCode >= 400 ? 'ERROR' : 'INFO',
      message: `${method} ${url} ${res.statusCode} ${duration}ms`,
      timestamp: new Date().toISOString(),
      method,
      url,
      statusCode: res.statusCode,
      durationMs: duration,
    }));
  });

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.url === '/api/stats') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(getStats()));
    return;
  }

  if (req.url === '/check/redis') {
    const host = process.env.REDIS_HOST;
    const port = parseInt(process.env.REDIS_PORT || '6379');
    const password = process.env.REDIS_PASSWORD;

    if (!host || !password) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'REDIS_HOST and REDIS_PASSWORD env vars are required' }));
      return;
    }

    const redis = new Redis({ host, port, password, connectTimeout: 5000, lazyConnect: true });
    redis.connect()
      .then(() => redis.ping())
      .then((pong) => redis.info('server').then((info) => ({ pong, info })))
      .then(({ pong, info }) => {
        const version = info.match(/redis_version:(.+)/)?.[1]?.trim();
        redis.disconnect();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'connected', ping: pong, version, host, port }));
      })
      .catch((err) => {
        try { redis.disconnect(); } catch (_) {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message, host, port }));
      });
    return;
  }

  if (req.url === '/check/pgsql') {
    const connectionString = process.env.PGSQL_URL;

    if (!connectionString) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'PGSQL_URL env var is required' }));
      return;
    }

    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    client.connect()
      .then(() => client.query('SELECT version()'))
      .then((versionResult) => client.query('SELECT NOW() as server_time').then((timeResult) => ({ versionResult, timeResult })))
      .then(({ versionResult, timeResult }) => {
        client.end();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'connected',
          version: versionResult.rows[0].version,
          serverTime: timeResult.rows[0].server_time,
          host: connectionString.replace(/\/\/.*@/, '//***@'),
        }));
      })
      .catch((err) => {
        try { client.end(); } catch (_) {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message, host: connectionString.replace(/\/\/.*@/, '//***@') }));
      });
    return;
  }

  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // Track stats for user-facing requests
  totalRequests++;
  requestTimestamps.push(Date.now());

  const html = buildDashboardHtml();
  const elapsed = Date.now() - start;
  totalResponseTime += elapsed;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(JSON.stringify({
    level: 'INFO',
    message: `Server started on port ${PORT}`,
    timestamp: new Date().toISOString(),
    port: PORT,
    nodeVersion: process.version,
    service: process.env.K_SERVICE || 'local',
    revision: process.env.K_REVISION || '-',
  }));
});
