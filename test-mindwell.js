const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('/home/claude/mindwell/public/index.html', 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail=''){
  if(cond){ pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  const spoken = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window){
      // ---- stub Web Speech synthesis ----
      window.SpeechSynthesisUtterance = class {
        constructor(text){ this.text = text; }
      };
      window.speechSynthesis = {
        _voices: [
          {name:'Samantha', lang:'en-US', voiceURI:'sam', default:true},
          {name:'Daniel',   lang:'en-GB', voiceURI:'dan'},
          {name:'Milena',   lang:'ru-RU', voiceURI:'mil'},
          {name:'Yuri',     lang:'ru-RU', voiceURI:'yur'},
        ],
        getVoices(){ return this._voices; },
        speak(u){ spoken.push(u.text); if(u.onstart) u.onstart(); if(u.onend) u.onend(); },
        cancel(){},
        onvoiceschanged: null
      };
      // ---- stub speech recognition ----
      window.webkitSpeechRecognition = class {
        constructor(){ window.__recInstance = this; }
        start(){ this._started = true; }
        stop(){ this._started = false; if(this.onend) this.onend(); }
        abort(){ this._started = false; }
      };
      // ---- stub localStorage quirks ----
      // jsdom has localStorage; fine.
      // ---- stub fetch (Claude API) ----
      window.fetch = async (url, opts) => {
        window.__lastUrl = url;
        const body = JSON.parse(opts.body);
        window.__lastRequest = body;
        return {
          ok: true,
          json: async () => ({ reply: 'Test reply: I hear you. Let us try one small CBT step together.' })
        };
      };
      window.scrollTo = ()=>{};
      window.HTMLElement.prototype.scrollTo = function(o){ this.scrollTop = (o && o.top) || 0; };
    }
  });

  const { window } = dom;
  const doc = window.document;
  await new Promise(r => setTimeout(r, 300)); // let scripts run

  const $ = s => doc.querySelector(s);
  const $$ = s => [...doc.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  console.log('\n== 1. Initial render ==');
  check('Welcome message rendered', $$('.msg.ai').length >= 1);
  check('Mood card rendered with 5 emoji', $$('.mood-card .moods button').length === 5);
  check('Approach chips rendered (7)', $$('.chip').length === 7);
  check('Placeholder localized (default en)', $('#input').placeholder.includes('mind'));
  check('Disclaimer present', $('#disclaimer').textContent.length > 20);
  check('Scroll-down button exists', !!$('#scrollDown'));

  console.log('\n== 2. Mood check-in flow ==');
  $$('.mood-card .moods button')[3].dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(50);
  check('Mood card removed after tap', !$('.mood-card'));
  check('Mood echoed as user msg', $$('.msg.user').some(m=>m.textContent.includes('🙂')));
  check('Quick prompts appear (6)', $$('.quick button').length === 6);

  console.log('\n== 3. Sending a message → API → reply ==');
  $('#input').value = 'I feel stressed about work';
  $('#sendBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(200);
  check('User message rendered', $$('.msg.user').some(m=>m.textContent==='I feel stressed about work'));
  check('AI reply rendered', $$('.msg.ai').some(m=>m.textContent.startsWith('Test reply')));
  check('Reply spoken via TTS', spoken.some(t=>t.includes('Test reply')));
  const req = window.__lastRequest;
  check('Calls OUR backend, not Anthropic', window.__lastUrl === '/api/chat');
  check('No model/system sent from client (server decides)', !req.model && !req.system);
  check('Sends approach + lang + session', req.approach === 'auto' && req.lang === 'en' && req.session >= 1);
  check('Sends mood context', req.mood === 'pretty good');
  check('History includes mood + message', req.messages.length === 2);

  console.log('\n== 4. Approach switching ==');
  const cbtChip = $$('.chip').find(c=>c.dataset.approach==='cbt');
  cbtChip.dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(50);
  check('CBT chip becomes active', cbtChip.classList.contains('active'));
  $('#input').value = 'more stress';
  $('#sendBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(200);
  check('Approach field switches to cbt', window.__lastRequest.approach === 'cbt');

  console.log('\n== 5. Crisis detection (multi-language) ==');
  check('No crisis card yet', !$('.crisis-card'));
  $('#input').value = 'sometimes I think about how to kill myself';
  $('#sendBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(200);
  check('Crisis card appears on English trigger', !!$('.crisis-card'));
  check('Crisis card mentions emergency number', $('.crisis-card').textContent.includes('112'));

  console.log('\n== 6. Language switching (Russian) ==');
  $('#langSelect').value = 'ru';
  $('#langSelect').dispatchEvent(new window.Event('change', {bubbles:true}));
  await sleep(50);
  check('Placeholder switches to Russian', $('#input').placeholder.includes('душе'));
  check('Disclaimer switches to Russian', $('#disclaimer').textContent.includes('MindWell'));
  check('Greeting in Russian added', $$('.msg.ai').some(m=>m.textContent.includes('Привет')));
  $('#input').value = 'мне тревожно';
  $('#sendBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(200);
  check('Language field switches to ru', window.__lastRequest.lang === 'ru');

  console.log('\n== 7. Voice selection (gender + specific) ==');
  // settings sheet population
  $('#settingsBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(50);
  const opts = $$('#voiceSelect option');
  check('Voice list filtered to Russian voices', opts.some(o=>o.textContent.includes('Milena')) && !opts.some(o=>o.textContent.includes('Samantha')));
  check('Gender symbols shown', opts.some(o=>o.textContent.includes('♀')) && opts.some(o=>o.textContent.includes('♂')));
  // pick male
  const maleBtn = $$('#genderSeg button').find(b=>b.dataset.g==='male');
  maleBtn.dispatchEvent(new window.Event('click', {bubbles:true}));
  spoken.length = 0;
  $('#testVoice').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(150);
  check('Test voice speaks after gender pick', spoken.length > 0);

  console.log('\n== 8. Voice replies toggle ==');
  spoken.length = 0;
  $('#voiceToggle').dispatchEvent(new window.Event('click', {bubbles:true})); // off
  $('#input').value = 'тест';
  $('#sendBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(200);
  check('No audible speech when toggled off', spoken.filter(t=>t.trim().length>0).length === 0, 'spoken: '+JSON.stringify(spoken));
  $('#voiceToggle').dispatchEvent(new window.Event('click', {bubbles:true})); // on
  await sleep(100);
  check('Confirmation spoken when toggled on', spoken.length > 0);

  console.log('\n== 9. Library sheet ==');
  check('Library has 12 frameworks', $$('#libList .lib-item').length === 12);
  check('Library mentions key books', $('#libList').textContent.includes('Atomic Habits') && $('#libList').textContent.includes('The Body Keeps the Score'));

  console.log('\n== 10. Composer layout ==');
  check('Classic mic button removed', !$('#micBtn'));
  check('Voice mode button present', !!$('#voiceModeBtn'));

  console.log('\n== 11. ChatGPT-style voice mode ==');
  const rec = window.__recInstance;
  const overlay = $('#voiceOverlay');
  $('#voiceModeBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(50);
  check('Overlay opens', overlay.classList.contains('open'));
  check('State = listening', overlay.classList.contains('listening'));
  check('Status text localized (ru)', $('#vmStatus').textContent.includes('Слушаю'));
  check('Recognition started', rec._started === true);
  check('Recognition lang follows app language', rec.lang === 'ru-RU');

  // simulate the user speaking
  const words = [{transcript:'мне грустно и одиноко'}]; words.isFinal = true;
  rec.onresult({results:[words]});
  check('Live caption shows transcript', $('#vmCaption').textContent.includes('грустно'));
  rec.onend();               // speech ended -> should send
  check('State = thinking after speech ends', overlay.classList.contains('thinking'));
  await sleep(330);          // fetch resolves, TTS stub speaks, loop resumes
  check('User voice message in chat', $$('.msg.user').some(m=>m.textContent.includes('грустно')));
  check('AI reply in chat', $$('.msg.ai').filter(m=>m.textContent.startsWith('Test reply')).length >= 3);
  check('Reply was spoken', spoken.some(t=>t.includes('Test reply')));
  check('Loop resumes: listening again', overlay.classList.contains('listening') && rec._started);

  // silence -> keeps listening
  rec.onend();
  await sleep(450);
  check('Silence restarts listening', overlay.classList.contains('listening') && rec._started);

  // mute / unmute
  $('#vmMuteBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  check('Mute state applied', overlay.classList.contains('muted') && rec._started === false);
  $('#vmMuteBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  check('Unmute resumes listening', overlay.classList.contains('listening') && rec._started === true);

  // close
  $('#vmCloseBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  check('Overlay closes', !overlay.classList.contains('open'));
  check('Recognition aborted on close', rec._started === false);

  // re-entering voice mode works after close
  $('#voiceModeBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(40);
  check('Can re-enter voice mode after closing', overlay.classList.contains('open') && overlay.classList.contains('listening'));
  $('#vmCloseBtn').dispatchEvent(new window.Event('click', {bubbles:true}));

  console.log(`\n========= RESULT: ${pass} passed, ${fail} failed =========`);
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error('HARNESS CRASH:', e); process.exit(2); });
