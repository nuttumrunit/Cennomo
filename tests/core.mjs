const base = process.env.CENNOMO_TEST_URL || 'http://127.0.0.1:4185';

async function request(path, options = {}, expected = 200) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (response.status !== expected) throw new Error(`${path}: expected ${expected}, received ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const checks = [];
const check = (name, condition) => {
  if (!condition) throw new Error(`failed: ${name}`);
  checks.push(name);
};

const health = await request('/api/health');
check('worker heartbeat online', health.workers >= 1);
check('credential vault configured', health.vaultConfigured === true);

const snapshot = await request('/api/snapshot');
check('13 official Tardigrade Agents', snapshot.metrics.officialOperators === 13);
check('7 credential-gated Tardigrade Agents remain learning', snapshot.operators.filter(operator => operator.state === 'learning' && operator.credential_required).length === 7);
check('persistent worker metric', snapshot.metrics.onlineWorkers >= 1);
check('official token CA is TBA', snapshot.config.tokenMint === null && snapshot.token.status === 'not_configured');
check('Treasury address is TBA', snapshot.config.treasuryAddress === null);
check('deployment and settlement are locked', snapshot.config.deployEnabled === false && snapshot.config.settlementEnabled === false);

const catalog = await request('/api/v1/skills');
check('13 unique Gateway tools', catalog.data.length === 13);
const providers = await request('/api/v1/skills/quote.fetch/providers');
check('provider router selected a Tardigrade Agent', providers.selected === 'jupiter-tardigrade-01' && providers.providers.length >= 1);

const call = await request('/api/v1/skills/repository.read/invoke', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
});
check('real Gateway execution succeeded', call.status === 'succeeded' && call.proof?.length === 64);
const audit = await request(`/api/v1/calls/${call.callId}`);
check('call audit persisted', audit.status === 'succeeded' && audit.proof === call.proof);

const mcp = await request('/mcp', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
});
check('MCP catalog publishes 13 tools', mcp.result.tools.length === 13);

const approval = await request('/api/v1/approvals', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ operator: 'stripe-tardigrade-09', capability: 'invoice.create', wallet: '11111111111111111111111111111111', input: { test: true } })
}, 201);
check('wallet approval challenge created', approval.challenge.includes(approval.approvalId));
const approvalState = await request(`/api/v1/approvals/${approval.approvalId}`);
check('approval is pending signature', approvalState.status === 'pending');

const settlement = await request('/api/v1/settlements');
check('settlement safely locked without fee policy', settlement.enabled === false && settlement.split.owner === 70);
await request('/api/v1/payment-intents', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ skill: 'quote.fetch', wallet: '11111111111111111111111111111111' })
}, 503);
checks.push('payment intents reject settlement without a fee policy');

console.log(`Core integration test passed: ${checks.length} checks`);
for (const name of checks) console.log(`  ✓ ${name}`);
