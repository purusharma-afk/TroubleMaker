const fs = require('node:fs');
const path = require('node:path');
const { ensureSchema, getOutageState } = require('../lib/observability');

const outagePage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>503 · Temporarily unavailable</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f8f4;color:#1d2a26;font:14px system-ui,sans-serif}.card{max-width:460px;padding:42px;background:#fff;border:1px solid #e7e8e2;box-shadow:0 12px 35px #1d2a2614}small{color:#8d4d42;font-weight:800;letter-spacing:1.5px;text-transform:uppercase}h1{font:500 42px Georgia;margin:14px 0}p{color:#75807a;line-height:1.7}button{border:0;background:#1d2a26;color:#fff;padding:12px 17px;cursor:pointer;font-weight:700}#status{font-size:12px;margin-top:14px}</style></head>
<body><main class="card"><small>503 · Synthetic outage</small><h1>Temporarily unavailable.</h1><p>This availability simulation is active so an SRE health monitor can detect the site as down.</p><button id="restore">Restore website</button><div id="status"></div></main>
<script>document.getElementById('restore').onclick=async function(){this.disabled=true;this.textContent='Restoring…';try{const r=await fetch('/api/outage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})});if(!r.ok)throw new Error('Restore failed');location.reload()}catch(e){this.disabled=false;this.textContent='Restore website';document.getElementById('status').textContent=e.message}}</script></body></html>`;

function html(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (status === 503) res.setHeader('Retry-After', '60');
  return res.end(value);
}

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    const state = await getOutageState();
    if (state.outage_enabled) return html(res, 503, outagePage);
    const index = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
    return html(res, 200, index);
  } catch (error) {
    return html(res, 503, '<!doctype html><title>503 · Service unavailable</title><h1>Service temporarily unavailable</h1>');
  }
};
