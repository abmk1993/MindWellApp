/* Echo rejection against REALISTIC recognition behaviour.

   The other suites feed a transcript as one exact, complete, final result.
   Real recognition does not work that way: it streams interim results that
   grow a word or two at a time, and its transcription of the AI's own voice
   coming back through the speaker contains errors ("you're" -> "your", words
   dropped, words merged).

   That matters enormously here: a 1-2 word opening fragment cannot possibly
   contain 3 consecutive matching words, so a filter that demands one will
   declare the AI's own first words a "barge-in", cut the reply off, and then
   accept the rest of the echo as the user's next question. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail=''){
  if(cond){ pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

const REPLY = 'I hear that you are feeling stressed about work and it is hard to switch off in the evening';
/* what the mic picks up of that reply — same voice, imperfectly transcribed */
const ECHO_FINAL = 'i hear that your feeling stressed about work and its hard to switch off in the evening';

function buildDom(){
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window){
      window.SpeechSynthesisUtterance = class { constructor(text){ this.text = text; } };
      window.speechSynthesis = {
        getVoices(){ return []; },
        speak(u){
          window.__utt = u;
          if(u.onstart) u.onstart();
          setTimeout(()=>{ if(window.__utt === u && u.onend) u.onend(); }, 3000); // long reply
        },
        cancel(){ const u = window.__utt; window.__utt = null; if(u && u.onerror) u.onerror({error:'canceled'}); },
        get speaking(){ return !!window.__utt; },
        onvoiceschanged: null
      };

      const AUTO_END_MS = 900;
      let engineBusy = false;
      window.webkitSpeechRecognition = class {
        constructor(){ this._started = false; }
        start(){
          if(engineBusy){ const e = new Error('already started'); e.name='InvalidStateError'; throw e; }
          engineBusy = true; this._started = true; window.__activeRec = this;
          this._t = setTimeout(()=>this._release(), AUTO_END_MS);
        }
        _release(){
          if(!this._started) return;
          clearTimeout(this._t);
          this._started = false; engineBusy = false;
          if(window.__activeRec === this) window.__activeRec = null;
          setTimeout(()=>{ if(this.onend) this.onend(); }, 5);
        }
        keepAlive(){ clearTimeout(this._t); this._t = setTimeout(()=>this._release(), AUTO_END_MS); }
        stop(){ this._release(); }
        abort(){ this._release(); }
      };

      window.fetch = async (url, opts) => {
        if(url === '/api/tts') return { ok:false, status:501, json: async()=>({error:'no'}) };
        const body = JSON.parse(opts.body);
        window.__lastRequest = body;
        const lastUser = [...body.messages].reverse().find(m=>m.role==='user');
        window.__asked = lastUser ? lastUser.content : '?';
        return { ok:true, json: async()=>({ reply: REPLY }) };
      };
      window.scrollTo = ()=>{};
      window.HTMLElement.prototype.scrollTo = function(o){ this.scrollTop = (o && o.top) || 0; };
      window.HTMLMediaElement.prototype.play = function(){ return Promise.resolve(); };
      window.HTMLMediaElement.prototype.pause = function(){};
    }
  });
  return dom;
}

(async () => {
  const dom = buildDom();
  const { window } = dom;
  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const $$ = s => [...doc.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const activeRec = () => window.__activeRec;

  await sleep(300);

  /* Feed a phrase the way a recognizer really does: interim results that grow
     a couple of words at a time, then a final result. */
  async function stream(text, {final=true, stepMs=60}={}){
    const words = text.split(' ');
    for(let i = 2; i <= words.length; i += 2){
      const rec = activeRec();
      if(!rec) return false;
      const chunk = [{transcript: words.slice(0, i).join(' ')}];
      chunk.isFinal = false;
      if(rec.onresult) rec.onresult({results:[chunk]});
      rec.keepAlive();
      await sleep(stepMs);
    }
    const rec = activeRec();
    if(!rec) return false;
    if(final){
      const done = [{transcript:text}]; done.isFinal = true;
      if(rec.onresult) rec.onresult({results:[done]});
      rec._release();
    }
    return true;
  }

  console.log('\n== Setup: ask a question, get a long spoken reply ==');
  $('#voiceModeBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(60);
  const overlay = $('#voiceOverlay');
  check('Listening on open', overlay.classList.contains('listening'));

  await stream('why do I feel so tired lately');
  await sleep(400);
  check('Reply is speaking', overlay.classList.contains('speaking'), 'state=' + overlay.className);

  console.log('\n== The AI hears its own reply, streamed as real interim results ==');
  const userMsgsBefore = $$('.msg.user').length;
  const askedBefore = window.__asked;

  await stream(ECHO_FINAL, {stepMs:50});
  await sleep(600);

  check('Echo did not become a user message',
    $$('.msg.user').length === userMsgsBefore,
    'user msgs ' + userMsgsBefore + ' -> ' + $$('.msg.user').length +
    ' (last: "' + ($$('.msg.user').slice(-1)[0]||{textContent:''}).textContent + '")');
  check('Echo was never sent to the model as a question',
    window.__asked === askedBefore,
    'model was asked: "' + window.__asked + '"');
  check('Reply was not cut off by its own voice',
    overlay.classList.contains('speaking'),
    'state=' + overlay.className);

  console.log('\n== A real interruption still works ==');
  await sleep(200);
  const okBarge = await stream('actually can we talk about my sleep schedule instead', {stepMs:50});
  check('Interruption reached the mic', okBarge);
  await sleep(700);
  check('Real interruption was heard and sent',
    ($$('.msg.user').slice(-1)[0]||{textContent:''}).textContent.includes('sleep schedule'),
    'last user msg: "' + ($$('.msg.user').slice(-1)[0]||{textContent:'none'}).textContent + '"');

  console.log('\n== A normal follow-up after the reply finishes ==');
  await sleep(3200);   // let that reply play out fully
  const before2 = $$('.msg.user').length;
  await stream('what can I do about it tonight');
  await sleep(700);
  check('Follow-up after the reply was heard',
    $$('.msg.user').length > before2 &&
    ($$('.msg.user').slice(-1)[0]||{textContent:''}).textContent.includes('about it tonight'),
    'user msgs ' + before2 + ' -> ' + $$('.msg.user').length +
    ' (last: "' + ($$('.msg.user').slice(-1)[0]||{textContent:''}).textContent + '")');

  console.log(`\n========= RESULT: ${pass} passed, ${fail} failed =========`);
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error('HARNESS CRASH:', e); process.exit(2); });
