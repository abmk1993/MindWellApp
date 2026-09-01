/* Voice loop over the REAL ElevenLabs path (an <audio> element), not the
   native-speech fallback.

   test-voice-loop.js stubs /api/tts to 501, which forces speechSynthesis.
   In production ELEVENLABS_API_KEY is set, so replies play through a shared
   <audio> element instead — a code path with very different failure modes:
   on mobile that element can stall, be blocked, or simply never fire
   'ended'. If the app only ever resumes listening from the audio-finished
   callback, it goes permanently deaf. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail=''){
  if(cond){ pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

/* audioBehaviour: 'normal' fires ended shortly after play();
   'never-ends' resolves play() but never fires ended/error (mobile stall). */
async function runScenario(audioBehaviour){
  console.log(`\n######## TTS audio behaviour: ${audioBehaviour} ########`);

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window){
      window.SpeechSynthesisUtterance = class { constructor(text){ this.text = text; } };
      window.speechSynthesis = {
        getVoices(){ return []; },
        speak(u){ if(u.onstart) u.onstart(); setTimeout(()=>{ if(u.onend) u.onend(); }, 400); },
        cancel(){},
        onvoiceschanged: null
      };

      // continuous=false, so a session auto-ends after a stretch of silence —
      // it does NOT stay open waiting indefinitely. This is what makes the app
      // go deaf if nothing restarts recognition.
      const AUTO_END_MS = 500;
      let engineBusy = false;
      window.__recInstances = [];
      window.webkitSpeechRecognition = class {
        constructor(){ this._started = false; window.__recInstances.push(this); }
        start(){
          if(engineBusy){ const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
          engineBusy = true; this._started = true; window.__activeRec = this;
          this._silenceTimer = setTimeout(()=>{ this._release(); }, AUTO_END_MS);
        }
        _release(){
          if(!this._started) return;
          clearTimeout(this._silenceTimer);
          this._started = false; engineBusy = false;
          if(window.__activeRec === this) window.__activeRec = null;
          setTimeout(()=>{ if(this.onend) this.onend(); }, 5);
        }
        stop(){ this._release(); }
        abort(){ this._release(); }
      };

      // ---- ElevenLabs path is AVAILABLE (as in production) ----
      window.fetch = async (url, opts) => {
        if(url === '/api/tts'){
          return { ok:true, status:200, blob: async()=>({ type:'audio/mpeg', size: 1234 }) };
        }
        const body = JSON.parse(opts.body);
        window.__lastRequest = body;
        const lastUser = [...body.messages].reverse().find(m=>m.role==='user');
        return { ok:true, json: async()=>({ reply: 'Reply to: ' + (lastUser ? lastUser.content : '?') }) };
      };
      window.URL.createObjectURL = ()=> 'blob:fake-' + Math.random();
      window.URL.revokeObjectURL = ()=>{};

      window.HTMLMediaElement.prototype.play = function(){
        this.__playing = true;
        if(this.onplay) this.onplay();
        if(audioBehaviour === 'normal'){
          const el = this;
          setTimeout(()=>{ if(el.__playing){ el.__playing = false; if(el.onended) el.onended(); } }, 400);
        }
        // 'never-ends': playback silently stalls — no ended, no error, ever
        return Promise.resolve();
      };
      window.HTMLMediaElement.prototype.pause = function(){ this.__playing = false; };

      window.scrollTo = ()=>{};
      window.HTMLElement.prototype.scrollTo = function(o){ this.scrollTop = (o && o.top) || 0; };
    }
  });

  const { window } = dom;
  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const $$ = s => [...doc.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const activeRec = () => window.__activeRec;

  await sleep(300);

  // A real person talks for a second or two, so allow a short moment for a
  // session to be live — but not an unbounded one: if the mic stays dead
  // this long the user would experience it as "it isn't listening to me".
  async function say(text){
    let rec = activeRec();
    for(let i = 0; i < 12 && !rec; i++){ await sleep(50); rec = activeRec(); }
    if(!rec) return false;
    const w = [{transcript:text}]; w.isFinal = true;
    if(rec.onresult) rec.onresult({results:[w]});
    rec._release();
    await sleep(1200);
    return true;
  }

  $('#voiceModeBtn').dispatchEvent(new window.Event('click', {bubbles:true}));
  await sleep(60);
  const overlay = $('#voiceOverlay');
  check('Overlay listening on open', overlay.classList.contains('listening'));

  const ok1 = await say('first question about sleep');
  check('Turn 1 accepted', ok1);
  check('Turn 1 answered', $$('.msg.ai').some(m=>m.textContent.includes('first question about sleep')));

  // THE CRITICAL ASSERTION: after a reply the mic must come back, and come
  // back promptly — a long dead stretch is what makes it feel like the app
  // ignores you. Sessions cycle, so allow a brief gap but not a lasting one.
  async function micLiveWithin(ms){
    for(let waited = 0; waited <= ms; waited += 40){
      if(activeRec()) return waited;
      await sleep(40);
    }
    return -1;
  }
  const micBack = await micLiveWithin(600);
  check('Mic comes back within 600ms of the reply', micBack >= 0,
    'mic still dead after 600ms (state=' + overlay.className + ')');

  const ok2 = await say('second question about anxiety');
  check('Turn 2 accepted (heard the follow-up)', ok2, 'nothing was listening');
  const lastAi = $$('.msg.ai').slice(-1)[0];
  check('Turn 2 answered the NEW question',
    !!lastAi && lastAi.textContent.includes('second question about anxiety'),
    'last AI msg: ' + (lastAi ? lastAi.textContent : 'none'));

  const ok3 = await say('third question about focus');
  check('Turn 3 accepted', ok3, 'nothing was listening');
  const lastAi3 = $$('.msg.ai').slice(-1)[0];
  check('Turn 3 answered the third question',
    !!lastAi3 && lastAi3.textContent.includes('third question about focus'),
    'last AI msg: ' + (lastAi3 ? lastAi3.textContent : 'none'));

  dom.window.close();
}

(async () => {
  await runScenario('normal');
  await runScenario('never-ends');
  console.log(`\n========= RESULT: ${pass} passed, ${fail} failed =========`);
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error('HARNESS CRASH:', e); process.exit(2); });
