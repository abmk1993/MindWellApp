/* Multi-turn voice-mode loop test.

   Models the two real browser behaviours that the naive implementation
   trips over:
     1. Only ONE recognition session exists per page. Calling start()
        while a previous session is still tearing down throws.
     2. abort()/stop() release that session ASYNCHRONOUSLY, firing
        onend on a later tick — not synchronously.

   Chrome (especially on Android) behaves this way, which is why
   "abort(); start()" back-to-back silently leaves the app deaf. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail=''){
  if(cond){ pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  const spoken = [];
  const startErrors = [];

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window){
      window.SpeechSynthesisUtterance = class {
        constructor(text){ this.text = text; }
      };
      window.speechSynthesis = {
        _voices: [{name:'Samantha', lang:'en-US', voiceURI:'sam', default:true}],
        getVoices(){ return this._voices; },
        speak(u){
          spoken.push(u.text);
          if(u.onstart) u.onstart();
          // a real spoken reply lasts seconds, not milliseconds
          window.__pendingUtterance = u;
          setTimeout(()=>{ if(window.__pendingUtterance === u && u.onend) u.onend(); }, 600);
        },
        cancel(){
          const u = window.__pendingUtterance;
          window.__pendingUtterance = null;
          // Chrome fires the utterance's error event when cancelled mid-speech
          if(u && u.onerror) u.onerror({error:'canceled'});
        },
        onvoiceschanged: null
      };

      // ---- realistic single-session speech recognition ----
      let engineBusy = false;
      window.__recInstances = [];
      window.webkitSpeechRecognition = class {
        constructor(){
          this._started = false;
          window.__recInstance = this;
          window.__recInstances.push(this);
        }
        start(){
          if(engineBusy){
            const err = new Error('Failed to execute \'start\': recognition has already started.');
            err.name = 'InvalidStateError';
            startErrors.push(err);
            throw err;
          }
          engineBusy = true;
          this._started = true;
          window.__activeRec = this;
        }
        _release(){
          if(!this._started) return;
          this._started = false;
          engineBusy = false;
          if(window.__activeRec === this) window.__activeRec = null;
          // onend arrives on a later tick, never synchronously
          setTimeout(()=>{ if(this.onend) this.onend(); }, 5);
        }
        stop(){ this._release(); }
        abort(){ this._release(); }
      };

      window.fetch = async (url, opts) => {
        if(url === '/api/tts') return { ok:false, status:501, json: async()=>({error:'tts_not_configured'}) };
        const body = JSON.parse(opts.body);
        window.__lastRequest = body;
        const lastUser = [...body.messages].reverse().find(m=>m.role==='user');
        return { ok:true, json: async()=>({ reply: 'Reply to: ' + (lastUser ? lastUser.content : '?') }) };
      };
      window.scrollTo = ()=>{};
      window.HTMLElement.prototype.scrollTo = function(o){ this.scrollTop = (o && o.top) || 0; };
      window.HTMLMediaElement.prototype.play = function(){ return Promise.resolve(); };
      window.HTMLMediaElement.prototype.pause = function(){};
    }
  });

  const { window } = dom;
  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const $$ = s => [...doc.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const activeRec = () => window.__activeRec;

  await sleep(300);

  // speak an utterance into whichever recognition session is live
  async function say(text){
    const rec = activeRec();
    if(!rec) return false;
    const words = [{transcript:text}]; words.isFinal = true;
    if(rec.onresult) rec.onresult({results:[words]});
    rec._release();            // user stopped talking -> session ends
    await sleep(900);          // let onend -> vmSend -> fetch -> speak -> finish run
    return true;
  }

  console.log('\n== Voice mode: multi-turn conversation ==');
  $('#voiceModeBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(50);
  const overlay = $('#voiceOverlay');
  check('Overlay opens listening', overlay.classList.contains('open') && overlay.classList.contains('listening'));
  check('A recognition session is live', !!activeRec());

  // ---- turn 1 ----
  const heard1 = await say('first question about sleep');
  check('Turn 1: transcript accepted', heard1);
  check('Turn 1: user message in chat', $$('.msg.user').some(m=>m.textContent.includes('first question about sleep')));
  check('Turn 1: reply is for question 1', $$('.msg.ai').some(m=>m.textContent.includes('first question about sleep')));
  await sleep(200);
  check('Turn 1: listening again after reply', overlay.classList.contains('listening'), 'state=' + overlay.className);
  check('Turn 1: a live session exists for next question', !!activeRec(), 'no active recognition — app is deaf');

  // ---- turn 2 (the reported bug) ----
  const heard2 = await say('second question about anxiety');
  check('Turn 2: transcript accepted', heard2, 'no live session to speak into');
  check('Turn 2: user message in chat', $$('.msg.user').some(m=>m.textContent.includes('second question about anxiety')));
  const lastAi = $$('.msg.ai').slice(-1)[0];
  check('Turn 2: reply answers the NEW question',
    !!lastAi && lastAi.textContent.includes('second question about anxiety'),
    'last AI msg: ' + (lastAi ? lastAi.textContent : 'none'));
  check('Turn 2: request sent the new question',
    JSON.stringify(window.__lastRequest || {}).includes('second question about anxiety'));

  // ---- turn 3, to be sure the loop is stable ----
  await sleep(200);
  check('Turn 3: still listening', overlay.classList.contains('listening'));
  const heard3 = await say('third question about focus');
  check('Turn 3: transcript accepted', heard3, 'no live session');
  const lastAi3 = $$('.msg.ai').slice(-1)[0];
  check('Turn 3: reply answers the third question',
    !!lastAi3 && lastAi3.textContent.includes('third question about focus'),
    'last AI msg: ' + (lastAi3 ? lastAi3.textContent : 'none'));

  console.log('\n== Barge-in (talking over the reply) ==');
  await sleep(200);
  // start a turn whose reply we will interrupt
  const rec = activeRec();
  if(rec){
    const w = [{transcript:'tell me a long story'}]; w.isFinal = true;
    if(rec.onresult) rec.onresult({results:[w]});
    rec._release();
    await sleep(200); // solidly mid-reply now
  }
  check('Speaking state during reply', overlay.classList.contains('speaking'), 'state=' + overlay.className);
  const bargeRec = activeRec();
  check('Listening in background during reply', !!bargeRec, 'no background session to hear an interruption');
  if(bargeRec){
    const w2 = [{transcript:'wait stop I changed my mind'}]; w2.isFinal = true;
    if(bargeRec.onresult) bargeRec.onresult({results:[w2]});
    await sleep(30);
    check('Barge-in switches to listening', overlay.classList.contains('listening'), 'state=' + overlay.className);
    bargeRec._release();
    await sleep(900);
    const aiAfterBarge = $$('.msg.ai').slice(-1)[0];
    check('Barge-in question gets answered',
      !!aiAfterBarge && aiAfterBarge.textContent.includes('changed my mind'),
      'last AI msg: ' + (aiAfterBarge ? aiAfterBarge.textContent : 'none'));
  }

  console.log('\n== Echo rejection (AI hearing its own voice) ==');
  await sleep(250);
  const rec2 = activeRec();
  if(rec2){
    const w = [{transcript:'why do I feel tired'}]; w.isFinal = true;
    if(rec2.onresult) rec2.onresult({results:[w]});
    rec2._release();
    await sleep(200); // solidly mid-reply
  }
  check('Speaking after new question', overlay.classList.contains('speaking'), 'state=' + overlay.className);
  const echoRec = activeRec();
  if(echoRec){
    // mic picks up the AI's own reply text (with a typical recognition error)
    const echoed = 'reply to why do I feel tired';
    const w3 = [{transcript:echoed}]; w3.isFinal = true;
    if(echoRec.onresult) echoRec.onresult({results:[w3]});
    await sleep(30);
    check('Echo does NOT interrupt the reply', overlay.classList.contains('speaking'),
      'state=' + overlay.className + ' (AI cut itself off on its own voice)');
  }

  console.log('\n== Trailing echo just AFTER the reply ends ==');
  // The speaker is still emitting the tail of the reply (and the recognizer
  // lags behind the audio), so the AI's own words can land right after the
  // state has already flipped back to 'listening'. They must not be sent as
  // if they were the user's next question.
  await sleep(900);
  check('Listening after reply finished', overlay.classList.contains('listening'), 'state=' + overlay.className);
  const aiCountBefore = $$('.msg.ai').length;
  const userCountBefore = $$('.msg.user').length;
  const tailRec = activeRec();
  check('Live session after reply', !!tailRec);
  if(tailRec){
    const tail = [{transcript:'reply to why do I feel tired'}]; tail.isFinal = true;
    if(tailRec.onresult) tailRec.onresult({results:[tail]});
    tailRec._release();
    await sleep(900);
    check('Trailing echo not sent as a user question',
      $$('.msg.user').length === userCountBefore,
      'user msgs went ' + userCountBefore + ' -> ' + $$('.msg.user').length +
      ' (last: ' + ($$('.msg.user').slice(-1)[0] || {textContent:'none'}).textContent + ')');
    check('AI did not answer its own echo',
      $$('.msg.ai').length === aiCountBefore,
      'ai msgs went ' + aiCountBefore + ' -> ' + $$('.msg.ai').length);
    check('Still listening for the real question after ignoring echo',
      overlay.classList.contains('listening') && !!activeRec(),
      'state=' + overlay.className + ' activeRec=' + !!activeRec());
  }

  console.log('\n== A real question still gets through after an echo ==');
  const realHeard = await say('can you help me sleep better');
  check('Real question accepted after echo', realHeard);
  const finalAi = $$('.msg.ai').slice(-1)[0];
  check('Real question answered',
    !!finalAi && finalAi.textContent.includes('can you help me sleep better'),
    'last AI msg: ' + (finalAi ? finalAi.textContent : 'none'));

  console.log('\n== Follow-up that reuses the reply\'s common words ==');
  // Real replies are full of ordinary words ("you", "feel", "that", "about").
  // A genuine follow-up naturally reuses them and must NOT be mistaken for echo.
  window.fetch = async (url, opts) => {
    if(url === '/api/tts') return { ok:false, status:501, json: async()=>({error:'tts_not_configured'}) };
    const body = JSON.parse(opts.body);
    window.__lastRequest = body;
    return { ok:true, json: async()=>({
      reply: 'I hear that you feel anxious about work and that it is hard to switch off in the evening.'
    })};
  };
  await sleep(300);
  const followRec = activeRec();
  check('Session live before follow-up', !!followRec);
  if(followRec){
    const w = [{transcript:'I feel anxious'}]; w.isFinal = true;
    followRec.onresult({results:[w]});
    followRec._release();
    await sleep(900);
  }
  const userBefore = $$('.msg.user').length;
  const followUp = 'can you tell me why I feel that anxious about work';
  const heardFollow = await say(followUp);
  check('Follow-up transcript accepted', heardFollow);
  check('Follow-up reached the chat (not swallowed as echo)',
    $$('.msg.user').length > userBefore &&
    $$('.msg.user').some(m=>m.textContent.includes('why I feel that anxious about work')),
    'user msgs ' + userBefore + ' -> ' + $$('.msg.user').length);
  check('Follow-up was sent to the backend',
    JSON.stringify(window.__lastRequest || {}).includes('why I feel that anxious about work'));

  console.log(`\n========= RESULT: ${pass} passed, ${fail} failed =========`);
  if(startErrors.length) console.log(`(recognition start() rejected ${startErrors.length}x — session collisions)`);
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error('HARNESS CRASH:', e); process.exit(2); });
