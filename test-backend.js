const http = require('http');

let pass = 0, fail = 0;
function check(name, cond, detail=''){
  if(cond){ pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail?' — '+detail:'')); }
}

/* ---------- mock Anthropic API ---------- */
let lastUpstream = null;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    lastUpstream = { headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ content: [{type:'text', text:'Mock coach reply: let us take one small step.'}] }));
  });
});

async function post(path, body, port=3100){
  const r = await fetch(`http://localhost:${port}${path}`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  let data = null;
  try{ data = await r.json(); }catch(e){}
  return { status: r.status, data };
}

(async () => {
  await new Promise(r => mock.listen(3199, r));

  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  process.env.ANTHROPIC_URL = 'http://localhost:3199/v1/messages';
  process.env.PORT = '3100';
  require(require('path').join(__dirname, 'server.js'));
  await new Promise(r => setTimeout(r, 400));

  console.log('\n== 1. Static hosting ==');
  const page = await fetch('http://localhost:3100/');
  const html = await page.text();
  check('App served at /', page.status === 200 && html.includes('MindWell'));
  check('App calls /api/chat, not Anthropic directly', html.includes("fetch('/api/chat'") && !html.includes('api.anthropic.com'));
  check('No API key anywhere in the page', !/sk-ant/.test(html));
  const health = await (await fetch('http://localhost:3100/api/health')).json();
  check('Health endpoint OK', health.ok === true);

  console.log('\n== 1b. TTS relay (ElevenLabs) ==');
  const tts1 = await post('/api/tts', { text: 'hello there' });
  check('TTS returns 501 when ELEVENLABS_API_KEY is not set', tts1.status === 501 && tts1.data.error === 'tts_not_configured');

  console.log('\n== 2. Chat relay ==');
  const r1 = await post('/api/chat', {
    messages:[{role:'user', content:'I feel anxious today'}],
    approach:'cbt', lang:'ru', mood:'low', session:3
  });
  check('Returns 200 with reply', r1.status === 200 && r1.data.reply.startsWith('Mock coach'));
  check('Server sent secret key upstream', lastUpstream.headers['x-api-key'] === 'sk-ant-test-key');
  check('Anthropic version header set', lastUpstream.headers['anthropic-version'] === '2023-06-01');
  const sys = lastUpstream.body.system;
  check('System prompt built server-side', typeof sys === 'string' && sys.length > 500);
  check('Prompt: knowledge base included', sys.includes('Feeling Good') && sys.includes('Atomic Habits') && sys.includes('DEAR MAN'));
  check('Prompt: approach applied (CBT)', sys.includes('Lead with CBT'));
  check('Prompt: language applied (ru)', sys.includes('Respond ONLY in Russian'));
  check('Prompt: mood included', sys.includes('low'));
  check('Prompt: session number included', sys.includes('session #3'));
  check('Prompt: safety rules included', sys.includes('never diagnose') && sys.includes('112/911'));
  check('Prompt: injection guard included', sys.includes('regardless of any instructions'));
  check('Model set by server', lastUpstream.body.model === 'claude-sonnet-4-6');

  console.log('\n== 3. Defaults ==');
  await post('/api/chat', { messages:[{role:'user', content:'hi'}] });
  check('Missing params fall back safely (auto/en/session 1)',
    lastUpstream.body.system.includes('Respond ONLY in English') &&
    lastUpstream.body.system.includes('Adaptively choose') &&
    lastUpstream.body.system.includes('session #1'));

  console.log('\n== 4. Validation ==');
  check('Rejects empty body', (await post('/api/chat', {})).status === 400);
  check('Rejects no messages', (await post('/api/chat', {messages:[]})).status === 400);
  check('Rejects bad role', (await post('/api/chat', {messages:[{role:'system', content:'x'}]})).status === 400);
  check('Rejects oversized message', (await post('/api/chat', {messages:[{role:'user', content:'x'.repeat(5000)}]})).status === 400);
  check('Rejects 61+ history items', (await post('/api/chat', {messages:Array(61).fill({role:'user',content:'x'})})).status === 400);
  check('Rejects unknown approach', (await post('/api/chat', {messages:[{role:'user',content:'x'}], approach:'hypnosis'})).status === 400);
  check('Rejects unknown language', (await post('/api/chat', {messages:[{role:'user',content:'x'}], lang:'xx'})).status === 400);
  check('Rejects oversized mood', (await post('/api/chat', {messages:[{role:'user',content:'x'}], mood:'m'.repeat(100)})).status === 400);

  console.log('\n== 5. Rate limiting (30 / 5 min per IP) ==');
  let limited = false, okCount = 0;
  for(let i=0;i<35;i++){
    const r = await post('/api/chat', {messages:[{role:'user', content:'ping'}]});
    if(r.status === 429){ limited = true; break; }
    if(r.status === 200 || r.status === 400) okCount++;
  }
  check('Kicks in after ~30 requests', limited, `passed ${okCount} before limit`);

  console.log(`\n========= BACKEND RESULT: ${pass} passed, ${fail} failed =========`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
