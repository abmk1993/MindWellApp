/* iOS Safari behaviour.

   On iOS, speech recognition may only be started from inside a user gesture.
   The tap that opens voice mode covers the FIRST start; every later restart
   is programmatic — from a timer, or after the reply finishes — and is
   refused. Android has no such rule, which is why it works there and not
   here: the first question is answered and then the app never listens again.

   Modelled by allowing start() only while a real event is being dispatched. */
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
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.com/',
    beforeParse(window){
      window.SpeechSynthesisUtterance = class { constructor(t){ this.text = t; } };
      window.speechSynthesis = {
        getVoices(){ return []; },
        speak(u){ window.__u = u; if(u.onstart) u.onstart(); setTimeout(()=>{ if(window.__u===u && u.onend) u.onend(); }, 500); },
        cancel(){ const u = window.__u; window.__u = null; if(u && u.onerror) u.onerror({error:'canceled'}); },
        get speaking(){ return !!window.__u; }
      };

      let busy = false;
      window.__gestureDepth = 0;
      window.__blockedStarts = 0;
      window.webkitSpeechRecognition = class {
        constructor(){ this._started = false; }
        start(){
          if(busy){ const e = new Error('already started'); e.name='InvalidStateError'; throw e; }
          // ---- the iOS rule ----
          if(!window.__gestureDepth){
            window.__blockedStarts++;
            const err = new Error('start() requires a user gesture');
            err.name = 'NotAllowedError';
            // iOS reports it asynchronously as an error event as well
            setTimeout(()=>{ if(this.onerror) this.onerror({error:'not-allowed'}); }, 5);
            throw err;
          }
          busy = true; this._started = true; window.__activeRec = this;
          this._t = setTimeout(()=>this._release(), 1200);
        }
        _release(){
          if(!this._started) return;
          clearTimeout(this._t);
          this._started = false; busy = false;
          if(window.__activeRec === this) window.__activeRec = null;
          setTimeout(()=>{ if(this.onend) this.onend(); }, 5);
        }
        stop(){ this._release(); }
        abort(){ this._release(); }
      };

      window.fetch = async (url, opts) => {
        if(url === '/api/tts') return { ok:false, status:501, json: async()=>({}) };
        const b = JSON.parse(opts.body);
        const lu = [...b.messages].reverse().find(m=>m.role==='user');
        window.__asked = lu ? lu.content : '?';
        return { ok:true, json: async()=>({ reply:'Reply to: ' + (lu ? lu.content : '?') }) };
      };
      window.scrollTo = ()=>{};
      window.HTMLElement.prototype.scrollTo = function(){};
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

  // a real tap: handlers run synchronously inside this window
  function tap(sel){
    window.__gestureDepth++;
    try{ $(sel).dispatchEvent(new window.Event('click', {bubbles:true})); }
    finally{ window.__gestureDepth--; }
  }

  await sleep(300);

  console.log('\n== First question (started from the opening tap) ==');
  tap('#voiceModeBtn');
  await sleep(80);
  const overlay = $('#voiceOverlay');
  check('Voice mode opened', overlay.classList.contains('open'));
  check('Mic started from the opening tap', !!activeRec(), 'first start was refused too');

  const rec = activeRec();
  if(rec){
    const w = [{transcript:'why am I so tired'}]; w.isFinal = true;
    rec.onresult({results:[w]});
    rec._release();
  }
  await sleep(900);
  check('First question was answered',
    $$('.msg.ai').some(m=>m.textContent.includes('why am I so tired')),
    'no answer came back');

  console.log('\n== After the reply: iOS refuses programmatic restarts ==');
  await sleep(1200);
  check('Programmatic restarts were attempted and refused', window.__blockedStarts > 0,
    'the model of the iOS restriction never triggered');
  check('Mic is not silently open', !activeRec());

  // The app must not pretend it is listening when iOS will not let it.
  const status = $('#vmStatus').textContent;
  check('UI does not falsely claim to be listening',
    !overlay.classList.contains('listening') || /tap/i.test(status),
    'status says "' + status + '" while the mic is dead — user waits forever');

  console.log('\n== A tap must get the user talking again ==');
  tap('#orb');
  await sleep(80);
  check('Tapping the orb reopens the mic', !!activeRec(),
    'still no way to speak — voice mode is dead after one question');

  const rec2 = activeRec();
  if(rec2){
    const w2 = [{transcript:'what can I do about it'}]; w2.isFinal = true;
    rec2.onresult({results:[w2]});
    rec2._release();
  }
  await sleep(900);
  const lastAi = $$('.msg.ai').slice(-1)[0];
  check('Second question was answered',
    !!lastAi && lastAi.textContent.includes('what can I do about it'),
    'last AI msg: ' + (lastAi ? lastAi.textContent : 'none'));

  console.log(`\n========= RESULT: ${pass} passed, ${fail} failed =========`);
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error('HARNESS CRASH:', e); process.exit(2); });
