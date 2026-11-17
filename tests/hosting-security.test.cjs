const test = require('node:test');
const assert = require('node:assert/strict');
const { headers } = require('../vercel.json');

const site = 'financas-yg.vercel.app';
const project = 'mhgagjhwsjjjwwvopjgu.supabase.co';
function documentHeaders(host) {
  return Object.fromEntries(headers
    .filter(rule => rule.source === '/(.*)' &&
      (!rule.has || rule.has.every(match => match.type === 'host' && match.value === host)))
    .flatMap(rule => rule.headers.map(header => [header.key, header.value])));
}

test('Production and previews forbid embedding and MIME sniffing', () => {
  for (const host of [site, 'preview.example']) {
    const h = documentHeaders(host);
    assert.equal(h['X-Frame-Options'], 'DENY');
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.match(h['Content-Security-Policy'], /(?:^|;\s*)frame-ancestors 'none'(?:;|$)/);
    assert.match(h['Content-Security-Policy'], /(?:^|;\s*)script-src 'self'(?:;|$)/);
  }
});

test('Official site restricts the data connection to its own Supabase project', () => {
  const policy = documentHeaders(site)['Content-Security-Policy'];
  const connect = policy.split(';').map(item => item.trim()).find(item => item.startsWith('connect-src ')).split(/\s+/);
  assert.ok(connect.includes('https://' + project));
  assert.ok(connect.includes('wss://' + project));
  assert.ok(!connect.some(source => source.includes('*.supabase.') || source === '*' || source === 'https:'));
  assert.ok(!connect.includes('https://api.anthropic.com'));
});

test('Hosting explicitly disables public caching of API responses', () => {
  const api = headers.find(rule => rule.source === '/api/:path*');
  assert.equal(api.headers.find(h => h.key === 'Cache-Control').value, 'private, no-store');
});
