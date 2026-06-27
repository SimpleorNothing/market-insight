/*! update-badge.js — 도구모음 공용 업데이트 배지
 * 왼쪽 하단에 "update : YYYY.M.D HH:MM (내용)" 표시. 클릭 시 최근 변경 내역 패널.
 * 데이터 우선순위: window.__UPDATE_BADGE_DATA(인라인) → <meta app-updated> → 같은 출처의 version.json.
 * 의존성 없음 · 토큰 스타일 인라인 주입 · 어느 스택에 붙여도 동작.
 *
 *   <script defer src="/update-badge.js" data-src="/version.json"></script>
 */
(function () {
  if (window.__updateBadgeMounted) return;
  window.__updateBadgeMounted = true;
  var SRC = (document.currentScript && document.currentScript.getAttribute('data-src')) || window.__UPDATE_BADGE_SRC || 'version.json';
  var T = { bg:'#ffffff', surface:'#f6f7f9', text:'#1a1d21', muted:'#5b6470', border:'#e6e9ee', brand:'#1257d6' };
  function fmt(iso){ try{ var d=new Date(iso); if(isNaN(d))return iso; var p=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d).reduce(function(o,x){o[x.type]=x.value;return o;},{}); return p.year+'.'+p.month+'.'+p.day+' '+p.hour+':'+p.minute; }catch(e){return iso;} }
  function el(tag,css,txt){ var n=document.createElement(tag); if(css)n.style.cssText=css; if(txt!=null)n.textContent=txt; return n; }
  function mount(data){
    if(!data||!data.updated_at)return;
    var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
    var st=document.createElement('style');
    st.textContent='#ub-root{position:fixed;left:16px;bottom:16px;z-index:2147483000;font-family:Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}#ub-btn{display:inline-flex;align-items:center;gap:7px;max-width:62vw;padding:6px 11px;border:1px solid '+T.border+';border-radius:999px;background:'+T.bg+';color:'+T.muted+';font-size:12px;line-height:1;cursor:pointer;box-shadow:0 1px 2px rgba(16,22,34,.06)}#ub-btn:hover{color:'+T.text+';border-color:#d3d8e0}#ub-btn:focus-visible{outline:2px solid '+T.brand+';outline-offset:2px}#ub-dot{width:7px;height:7px;border-radius:50%;background:'+T.brand+';flex:0 0 auto'+(reduce?'':';animation:ub-pulse 2.4s ease-in-out infinite')+'}#ub-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#ub-txt b{color:'+T.text+';font-weight:600}@keyframes ub-pulse{0%,100%{box-shadow:0 0 0 0 rgba(18,87,214,.45)}50%{box-shadow:0 0 0 4px rgba(18,87,214,0)}}#ub-panel{position:absolute;left:0;bottom:42px;width:320px;max-width:78vw;max-height:50vh;overflow:auto;background:'+T.bg+';border:1px solid '+T.border+';border-radius:14px;box-shadow:0 12px 28px rgba(16,22,34,.16);padding:14px 14px 10px;animation:ub-rise .14s ease-out}#ub-panel[hidden]{display:none}@keyframes ub-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.ub-h{font-size:12px;color:'+T.muted+';margin:0 0 8px;display:flex;justify-content:space-between;align-items:center}.ub-x{border:0;background:transparent;color:'+T.muted+';font-size:16px;line-height:1;cursor:pointer;padding:2px 5px;border-radius:6px}.ub-x:hover{background:'+T.surface+';color:'+T.text+'}.ub-item{padding:9px 0;border-top:1px solid '+T.border+'}.ub-item:first-of-type{border-top:0}.ub-when{font-size:11px;color:'+T.muted+';font-variant-numeric:tabular-nums}.ub-what{font-size:13px;color:'+T.text+';margin-top:3px;word-break:break-word;line-height:1.45}@media (max-width:600px){#ub-root{left:12px;bottom:12px}}';
    document.head.appendChild(st);
    var root=el('div');root.id='ub-root';
    var btn=el('button');btn.id='ub-btn';btn.type='button';btn.setAttribute('aria-expanded','false');
    var dot=el('span');dot.id='ub-dot';
    var txt=el('span');txt.id='ub-txt';
    txt.appendChild(document.createTextNode('update : '));
    var b=el('b',null,fmt(data.updated_at));txt.appendChild(b);
    if(data.summary)txt.appendChild(document.createTextNode(' ('+data.summary+')'));
    btn.appendChild(dot);btn.appendChild(txt);
    var panel=el('div');panel.id='ub-panel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','업데이트 내역');
    var head=el('div');head.className='ub-h';head.appendChild(el('span',null,'업데이트 내역'));
    var x=el('button',null,'\u00d7');x.className='ub-x';x.type='button';x.setAttribute('aria-label','닫기');head.appendChild(x);
    panel.appendChild(head);
    var log=(data.log&&data.log.length)?data.log:[{at:data.updated_at,summary:data.summary||'\u2014'}];
    log.forEach(function(it){var item=el('div');item.className='ub-item';var when=el('div',null,fmt(it.at));when.className='ub-when';var what=el('div',null,it.summary||'\u2014');what.className='ub-what';item.appendChild(when);item.appendChild(what);panel.appendChild(item);});
    function open(o){panel.hidden=!o;btn.setAttribute('aria-expanded',o?'true':'false');}
    btn.addEventListener('click',function(){open(panel.hidden);});
    x.addEventListener('click',function(){open(false);btn.focus();});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!panel.hidden){open(false);btn.focus();}});
    document.addEventListener('click',function(e){if(!root.contains(e.target))open(false);});
    root.appendChild(panel);root.appendChild(btn);document.body.appendChild(root);
  }
  function fromMeta(){ var t=document.querySelector('meta[name="app-updated"]'); if(!t||!t.content)return null; var n=document.querySelector('meta[name="app-update-note"]'); var note=(n&&n.content)||''; return{updated_at:t.content,summary:note,log:[{at:t.content,summary:note||'최신 배포'}]}; }
  function boot(){ if(window.__UPDATE_BADGE_DATA){mount(window.__UPDATE_BADGE_DATA);return;} var m=fromMeta(); if(m){mount(m);return;} fetch(SRC,{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(d){if(d)mount(d);}).catch(function(){}); }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot); else boot();
})();
