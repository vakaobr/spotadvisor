#!/usr/bin/env node
// scripts/smoke-test.js
const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function run() {
  console.log('Health:');
  console.log(await req('/api/health'));

  console.log('\nSpot prices (latest):');
  console.log(await req('/api/spot-prices'));

  console.log('\nCreate alert:');
  const created = await post('/api/alerts', {
    cloud: 'TEST',
    vmType: 'small',
    region: 'local',
    thresholdPrice: 1,
    notifyEmail: 'test@example.com'
  });
  console.log(created);
  const id = created && created.id;

  console.log('\nList alerts:');
  console.log(await req('/api/alerts'));

  if (id) {
    console.log(`\nDelete alert ${id}`);
    console.log(await del(`/api/alerts/${id}`));
  }

  console.log('\nHistory:');
  console.log(await req('/api/history?cloud=TEST&vmType=small&region=local&days=7'));

  console.log('\nDone.');
}

async function req(path) {
  const r = await fetch(BASE + path);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function del(path) {
  const r = await fetch(BASE + path, { method: 'DELETE' });
  try { return await r.json(); } catch { return null; }
}

run().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
