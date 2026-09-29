// Depth marks — page UI: picker rows, the "at your mark" strip, and the three
// sheets (add a place, add a mark, report a reading). Talks to /api/marks,
// /api/places, /api/readings; the math lives in marks-math.js (MarksMath).
(function(){
  "use strict";
  var MARK_KEY="blythe_mark_v1", DEV_KEY="blythe_device_v1";
  var MARKS=[], MARKS_BY_SPOT={}, UPLACES=[], RD_CACHE={}, loaded=false, loadErr=null;
  function deviceId(){ var d=null; try{ d=localStorage.getItem(DEV_KEY); }catch(e){} if(!d){ d="d-"+Math.random().toString(36).slice(2,10)+"-"+Math.random().toString(36).slice(2,10)+"-"+Date.now().toString(36); try{ localStorage.setItem(DEV_KEY,d); }catch(e){} } return d; }
  function branch(){ var h=location.hostname||""; if(/^dev--/.test(h) || /localhost|127\.0\.0\.1/.test(h)) return "dev"; var m=h.match(/^([a-z0-9-]+)--/); return m?m[1]:"main"; }
  function api(method, path, body){ return fetch(path, {method:method, headers:{"content-type":"application/json","x-device":deviceId()}, body:body?JSON.stringify(body):undefined, cache:"no-store"}).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||("HTTP "+r.status)); return j; }); }); }
  function $(id){ return document.getElementById(id); }
  function ago(t){ var m=Math.round((Date.now()-t)/60000); if(m<2) return "just now"; if(m<60) return m+" min ago"; var h=Math.round(m/60); if(h<36) return h+" h ago"; return Math.round(h/24)+" days ago"; }
  function currentMarkId(){ return store.get(MARK_KEY)||null; }
  function currentMark(){ var id=currentMarkId(); if(!id) return null; for(var i=0;i<MARKS.length;i++) if(MARKS[i].id===id) return MARKS[i]; return null; }
  function setMark(id){ store.set(MARK_KEY, id||null); RD_CACHE={}; if(typeof rebuild==="function") setTimeout(rebuild,0); }
  window.MarksUI={ marksFor:function(k){ return MARKS_BY_SPOT[k]||[]; }, myMarks:function(){ return MARKS.filter(function(m){ return m.mine; }); }, currentMarkId:currentMarkId, setMark:setMark, loaded:function(){ return loaded; } };

  // ---- load marks + user places (once per page load, then on demand) ----
  function load(){
    return Promise.all([api("GET","/api/places"), api("GET","/api/marks")]).then(function(rs){
      UPLACES=rs[0].places||[]; MARKS=rs[1].marks||[]; MARKS_BY_SPOT={};
      MARKS.forEach(function(m){ (MARKS_BY_SPOT[m.spot]=MARKS_BY_SPOT[m.spot]||[]).push(m); });
      if(typeof addUserPlaces==="function") addUserPlaces(UPLACES);
      loaded=true; loadErr=null;
      var want=location.pathname.match(/^\/s\/(u:[a-z0-9]+)/); // deep link to a user place
      if(want && !store.get(PLACE_KEY) && typeof setPlace==="function") setPlace(want[1], {replace:true});
      if(typeof rebuild==="function") setTimeout(rebuild,0);
    }).catch(function(e){ loadErr=e.message; loaded=true; });
  }
  // ---- picker additions: mark rows under a spot, and the add buttons ----
  function markRows(p){
    var ms=MARKS_BY_SPOT[p.key]||[], cur=currentMarkId();
    return ms.map(function(m){ return '<button class="row sub'+(m.id===cur?' on':'')+'" data-mark="'+m.id+'" data-k="'+p.key+'"><span class="rs">⤳</span><span class="rn">'+esc(m.name)+(m.status!=="approved"?' <span class="tagp">'+(m.status==="pending"?"pending":m.status)+'</span>':'')+'</span><span class="rl">mark</span></button>'; }).join("");
  }
  function addButtons(){ return loadErr?'<p class="note" style="padding:0 8px">Marks couldn\u2019t load ('+esc(loadErr)+').</p>':''; }
  // one mark row that also names its spot (for the "Yours" section)
  function markRowAt(m){ var p=PLACES.find(function(x){ return x.key===m.spot; }); if(!p) return ""; var cur=currentMarkId(); return '<button class="row sub'+(m.id===cur?' on':'')+'" data-mark="'+m.id+'" data-k="'+p.key+'"><span class="rs">\u2933</span><span class="rn">'+esc(m.name)+' <span class="muted-sm">\u00b7 at '+esc(p.name)+'</span>'+(m.status!=="approved"?' <span class="tagp">'+(m.status==="pending"?"pending":m.status)+'</span>':'')+'</span><span class="rl">mark</span></button>'; }
  window.MarksUI.markRows=markRows; window.MarksUI.markRowAt=markRowAt; window.MarksUI.addButtons=addButtons;

  // ---- the strip under the tiles ----
  function stageForCfs(pl, v){ return (typeof stageAbsAt==="function") ? stageAbsAt(pl, v) : null; }
  function readingsFor(id, cb){ var c=RD_CACHE[id]; if(c && Date.now()-c.at<60000){ cb(c.data); return; } if(c && c.pending){ c.cbs.push(cb); return; } RD_CACHE[id]={pending:true, cbs:[cb]}; api("GET","/api/readings?mark="+encodeURIComponent(id)).then(function(j){ var cbs=RD_CACHE[id].cbs; RD_CACHE[id]={at:Date.now(), data:j}; cbs.forEach(function(f){ f(j); }); }).catch(function(e){ var cbs=RD_CACHE[id].cbs; RD_CACHE[id]={at:Date.now(), data:{error:e.message}}; cbs.forEach(function(f){ f({error:e.message}); }); }); }
  function phraseAt(m, sum, pl, cfs){
    var st=stageForCfs(pl, cfs); if(st==null) return null;
    var bits=[];
    var d=(sum.curve)?MarksMath.depthAt(sum.curve, st):null; if(d!=null) bits.push('<b class="mono">'+MarksMath.fmtDepth(d)+'</b>');
    var r=(m.ladder&&m.ladder.length)?MarksMath.rungAt(sum.ladder, m.ladder, st):null; if(r) bits.push(r.text);
    return bits.length?bits.join(" · "):null;
  }
  function renderStrip(){
    var el=$("mark-strip"); if(!el) return;
    var pl=currentPlace(), m=currentMark();
    if(!m || m.spot!==pl.key){ if(m && m.spot!==pl.key){ /* moved spots: drop the mark quietly */ store.set(MARK_KEY,null); }
      var ms=MARKS_BY_SPOT[pl.key]||[];
      if(!ms.length){ el.style.display="none"; el.innerHTML=""; return; }
      el.style.display="block";
      el.innerHTML='<div class="ms-hd"><span>Depth marks here</span></div><div class="ms-body">'+ms.map(function(x){ return '<button class="chip" data-pick-mark="'+x.id+'">⤳ '+esc(x.name)+(x.status!=="approved"?' <span class="tagp">pending</span>':'')+'</button>'; }).join(" ")+'</div><p class="note">Pick a mark to see the water in its own terms — depth at that exact spot, or which landmark it’s at.</p>';
      return;
    }
    el.style.display="block";
    var M=heroModel();
    el.innerHTML='<div class="ms-hd"><span>At <b>'+esc(m.name)+'</b>'+(m.status!=="approved"?' <span class="tagp">'+(m.status==="pending"?"awaiting approval · only you see it":m.status)+'</span>':'')+'</span><button class="tbtn" id="ms-report">✎ Report a reading</button></div><div class="ms-body" id="ms-body">Loading readings…</div>';
    readingsFor(m.id, function(j){
      var body=$("ms-body"); if(!body) return;
      if(j.error){ body.innerHTML='<span class="muted-sm">Couldn’t load readings ('+esc(j.error)+').</span>'; return; }
      var sum=j.summary||{}, n=sum.n||0, html="";
      if(!M.ok){ body.innerHTML='<span class="muted-sm">No sensor reading yet.</span>'; return; }
      if(!n){ html='<div class="ms-line">No readings yet — be the first. Each reading teaches this mark how the depth here follows the sensor.</div>'; }
      else {
        var now=Date.now(), nowP=M.f?phraseAt(m, sum, pl, M.f.v):null;
        html+='<div class="ms-line ms-now">'+(nowP?nowP+' <span class="muted-sm">now</span>':'<span class="muted-sm">no level yet</span>')+'</div>';
        (M.events||[]).slice(0,2).forEach(function(e){ var p=phraseAt(m, sum, pl, e.v); if(p) html+='<div class="ms-line">'+(e.type==="high"?"▲ high":"▼ low")+' '+p+' <span class="muted-sm">~'+azClock(e.t)+(dayKey(e.t)!==dayKey(now)?' '+azDay(e.t):'')+'</span></div>'; });
        var q=[]; q.push(n+' reading'+(n===1?'':'s')); if(sum.lastT) q.push('last '+ago(sum.lastT)); if(sum.curve&&sum.curve.method==="fit") q.push('curve fitted'); else if(sum.curve) q.push('tracking the sensor 1:1 until 5+ readings span 1.5 ft'); if(sum.flagged) q.push(sum.flagged+' flagged for review');
        html+='<div class="muted-sm">'+q.join(' · ')+'</div>';
      }
      body.innerHTML=html;
    });
    el.querySelector("#ms-report").addEventListener("click", openReading);
  }
  // ---- sheets ----
  function openS(id){ $(id).classList.add("open"); $("sheet-bg").classList.add("open"); }
  function closeAll(){ ["mk-sheet","pl-sheet","rd-sheet"].forEach(function(id){ var e=$(id); if(e) e.classList.remove("open"); }); var sh=$("sheet"), al=$("al-sheet"); if(!(sh&&sh.classList.contains("open")) && !(al&&al.classList.contains("open"))) $("sheet-bg").classList.remove("open"); }
  window.MarksUI.closeAll=closeAll;
  function geo(cb){ if(!navigator.geolocation){ toast("Location isn’t available in this browser."); return; } toast("Getting your location…", 5000); navigator.geolocation.getCurrentPosition(function(pos){ cb(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy); }, function(err){ toast(err&&err.code===1?"Location permission was denied.":"Couldn’t get your location."); }, {enableHighAccuracy:true, timeout:12000, maximumAge:60000}); }
  // A pasted waypoint in any common form -> [lat, lon]. Accepts decimal pairs
  // ("33.7123, -114.5012"), degrees-minutes-seconds with N/S/E/W, and Google /
  // Apple Maps links (@lat,lon · q=lat,lon · ll=lat,lon · !3d..!4d..).
  function parseCoords(str){
    var s=String(str||"").trim(); if(!s) return null;
    var m, lat=null, lon=null;
    if((m=s.match(/[@!]3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/))){ lat=+m[1]; lon=+m[2]; }
    else if((m=s.match(/[@?&](?:q|ll|query|center|destination|daddr|saddr)?=?(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/))){ lat=+m[1]; lon=+m[2]; }
    else {
      // DMS: 33°42'44.5"N 114°30'04"W  (also 33 42 44.5 N, 114 30 4 W)
      var dms=/(-?\d{1,3})[°\s]+(\d{1,2})['\u2032\s]+(\d{1,2}(?:\.\d+)?)?["\u2033\s]*([NSEW])?/gi, parts=[], q;
      while((q=dms.exec(s)) && parts.length<2){ var v=Math.abs(+q[1])+(+q[2])/60+(+(q[3]||0))/3600; var h=(q[4]||"").toUpperCase(); if(h==="S"||h==="W"||q[1].charAt(0)==="-") v=-v; parts.push({v:v, h:h}); }
      if(parts.length===2){ var a=parts[0], b=parts[1]; if(a.h==="E"||a.h==="W"||b.h==="N"||b.h==="S"){ lat=b.v; lon=a.v; } else { lat=a.v; lon=b.v; } }
      else if((m=s.match(/(-?\d{1,2}\.\d+)\s*°?\s*([NS])?\s*[, ]\s*(-?\d{1,3}\.\d+)\s*°?\s*([EW])?/i))){ lat=+m[1]*(/s/i.test(m[2]||"")?-1:1); lon=+m[3]*(/w/i.test(m[4]||"")?-1:1); }
    }
    if(lat==null || lon==null || !isFinite(lat) || !isFinite(lon)) return null;
    if(lon>0 && lon>100) lon=-lon; // a west longitude typed without the minus
    if(!(lat>=31.5 && lat<=36.5 && lon>=-116 && lon<=-113)) return {err:"That point isn\u2019t on this stretch of the Colorado (lat "+lat.toFixed(4)+", lon "+lon.toFixed(4)+")."};
    return [lat, lon];
  }
  window.MarksUI.parseCoords=parseCoords;
  function usePasted(sheetId, inputId, noteId, withMile){
    var r=parseCoords($(inputId).value);
    if(!r){ toast("Couldn\u2019t read a waypoint there \u2014 try \u201c33.7123, -114.5012\u201d or paste a Maps link."); return; }
    if(r.err){ toast(r.err, 5000); return; }
    $(sheetId)._pin=r;
    if(withMile){ var mi=mileFromPin(r[0], r[1]); if(mi){ $("pl-mile").value=mi.mile; $(noteId).textContent="Waypoint "+r[0].toFixed(4)+", "+r[1].toFixed(4)+" \u2014 about river mile "+mi.mile+", between "+mi.up.name+" and "+mi.down.name+(mi.dist>1.5?" ("+mi.dist.toFixed(1)+" mi off the river line \u2014 check the mile)":""); } else $(noteId).textContent="Waypoint set, but couldn\u2019t work out the river mile \u2014 type it."; }
    else $(noteId).textContent="Pinned at "+r[0].toFixed(4)+", "+r[1].toFixed(4);
  }
  // River mile from a pin: project the point onto the river line drawn through
  // the known spots in mile order (approved user places with pins included),
  // take the closest segment, and interpolate its two spots' miles. Reports
  // how far the pin sits from that line so a pin well off the river is flagged.
  function mileFromPin(lat, lon){
    var vs=[]; PLACES.forEach(function(p){ var g=PLACE_GEO[p.key] || (p.user && p.user.status==="approved" && p.user.lat!=null ? [p.user.lat, p.user.lon] : null); if(g && p.mile>0) vs.push({p:p, g:g}); });
    if(vs.length<2) return null;
    vs.sort(function(a,b){ return b.p.mile-a.p.mile; });
    var kx=69.1*Math.cos(lat*Math.PI/180), ky=69.1; // local miles per degree
    var best=null;
    for(var i=1;i<vs.length;i++){
      var A=vs[i-1], B=vs[i];
      var ax=(A.g[1]-lon)*kx, ay=(A.g[0]-lat)*ky, bx=(B.g[1]-lon)*kx, by=(B.g[0]-lat)*ky; // spots relative to the pin
      var dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy; if(!L2) continue;
      var t=Math.max(0, Math.min(1, -(ax*dx+ay*dy)/L2));
      var px=ax+t*dx, py=ay+t*dy, d=Math.sqrt(px*px+py*py);
      if(!best || d<best.d) best={d:d, t:t, A:A, B:B};
    }
    if(!best) return null;
    var mile=best.A.p.mile+(best.B.p.mile-best.A.p.mile)*best.t;
    var near=best.t<0.5?best.A.p:best.B.p, far=best.t<0.5?best.B.p:best.A.p;
    return { mile:+mile.toFixed(1), near:near, near2:far, up:best.A.p, down:best.B.p, dist:best.d };
  }
  // add a place
  function openPlace(){
    $("pl-name").value=""; $("pl-mile").value=""; $("pl-geo").textContent=""; $("pl-coords").value=""; $("pl-sheet")._pin=null;
    var cur=currentPlace(), opts=PLACES.filter(function(p){ return !/^u:/.test(p.key); }).slice().sort(function(a,b){ return b.mile-a.mile; });
    $("pl-anchor").innerHTML=opts.map(function(p){ return '<option value="'+p.key+'"'+(p.key===cur.key?' selected':'')+'>'+esc(p.name)+'</option>'; }).join("");
    openS("pl-sheet");
  }
  function useAnchor(){
    var p=PLACES.find(function(x){ return x.key===$("pl-anchor").value; }); if(!p) return;
    var side=$("pl-side").value, mile=p.mile+(side==="up"?0.5:side==="down"?-0.5:0);
    $("pl-mile").value=mile.toFixed(1);
    $("pl-geo").textContent="River mile "+mile.toFixed(1)+" \u2014 "+(side==="at"?"right at ":side==="up"?"about half a mile above ":"about half a mile below ")+p.name+". Adjust the mile if you know it better (1 mile \u2248 15 min of pulse travel).";
  }
  function savePlace(){
    var name=$("pl-name").value.trim(), mile=parseFloat($("pl-mile").value), pin=$("pl-sheet")._pin;
    if(name.length<2){ toast("Give the place a name."); return; }
    if(!(mile>=40 && mile<=280)){ toast("Use the location button, or type the river mile."); return; }
    api("POST","/api/places",{name:name, mile:mile, lat:pin?pin[0]:null, lon:pin?pin[1]:null, note:$("pl-note").value.trim()}).then(function(j){
      toast("Added — only you can see it until it’s approved.", 4000); closeAll();
      return load().then(function(){ setPlace("u:"+j.place.id); });
    }).catch(function(e){ toast(e.message, 4000); });
  }
  // add a mark
  function openMark(){ var pl=currentPlace(); $("mk-spot").textContent=pl.name; $("mk-name").value=""; $("mk-ref").value=""; $("mk-ladder").value=""; $("mk-geo").textContent=""; $("mk-coords").value=""; $("mk-sheet")._pin=null; openS("mk-sheet"); }
  function saveMark(){
    var pl=currentPlace(), name=$("mk-name").value.trim(), ref=$("mk-ref").value.trim(), pin=$("mk-sheet")._pin;
    if(name.length<2){ toast("Give the mark a name."); return; }
    if(ref.length<8){ toast("Describe exactly where the reading is taken."); return; }
    var ladder=$("mk-ladder").value.split("\n").map(function(l){ return l.trim(); }).filter(Boolean).map(function(l){ var mm=l.match(/^(.*?)\s*[@=:]\s*(-?\d+(?:\.\d+)?)\s*(?:ft)?\s*$/); return mm?{label:mm[1].trim(), h:+mm[2]}:{label:l}; });
    if(ladder.length===1){ toast("A ladder needs two or more landmarks (or leave it empty)."); return; }
    api("POST","/api/marks",{spot:pl.key, name:name, ref:ref, ladder:ladder, lat:pin?pin[0]:null, lon:pin?pin[1]:null}).then(function(j){
      toast("Mark added — only you can see it until it’s approved. You can report readings right away.", 5000); closeAll();
      return load().then(function(){ setMark(j.mark.id); });
    }).catch(function(e){ toast(e.message, 4000); });
  }
  // report a reading
  function openReading(){
    var m=currentMark(); if(!m) return;
    $("rd-mark").textContent=m.name; $("rd-ref").textContent=m.ref;
    var hasL=!!(m.ladder&&m.ladder.length);
    $("rd-kind-rung").style.display=hasL?"":"none"; $("rd-kind-rung").classList.toggle("on", false); $("rd-kind-depth").classList.add("on");
    $("rd-depth-wrap").style.display=""; $("rd-rung-wrap").style.display="none";
    $("rd-ft").value=""; $("rd-in").value=""; $("rd-note").value="";
    if(hasL){ var opts=m.ladder.map(function(r){ return '<option value="'+r.id+'">'+esc(r.label)+'</option>'; }).join(""); $("rd-rung").innerHTML=opts; $("rd-rung2").innerHTML=opts; }
    $("rd-when").value="now"; $("rd-time").style.display="none"; $("rd-time").value="";
    openS("rd-sheet");
  }
  function saveReading(){
    var m=currentMark(); if(!m) return;
    var when=$("rd-when").value, t=Date.now();
    if(when==="1h") t-=3600000; else if(when==="2h") t-=7200000; else if(when==="custom"){ var tv=$("rd-time").value; if(!tv){ toast("Pick the time you measured."); return; } var hm=tv.split(":"); var now=new Date(); var az=new Date(now.toLocaleString("en-US",{timeZone:"America/Phoenix"})); var azDate=new Date(az.getFullYear(), az.getMonth(), az.getDate(), +hm[0], +hm[1]); t=Date.now()-(az.getTime()-azDate.getTime()); if(t>Date.now()+60000) t-=86400000; }
    var body={mark:m.id, t:t, branch:branch(), note:$("rd-note").value.trim()};
    if($("rd-kind-depth").classList.contains("on")){ var ft=parseFloat($("rd-ft").value||"0"), inch=parseFloat($("rd-in").value||"0"); if(isNaN(ft)||isNaN(inch)||ft<0||inch<0){ toast("Enter the depth in feet and inches."); return; } body.kind="depth"; body.depth=+(ft+inch/12).toFixed(2); }
    else { var mode=$("rd-rmode").value; body.kind=mode; body.rung=$("rd-rung").value; if(mode==="between") body.rung2=$("rd-rung2").value; }
    var btn=$("rd-save"); btn.disabled=true;
    api("POST","/api/readings",body).then(function(j){
      btn.disabled=false; closeAll(); RD_CACHE={};
      var r=j.reading, s=j.summary||{};
      toast(r.status==="flagged" ? "Recorded, but it disagrees with earlier readings here ("+r.why+") — held for review." : "Recorded. This mark now has "+(s.n||1)+" reading"+((s.n||1)===1?"":"s")+".", 5000);
      if(typeof rebuild==="function") setTimeout(rebuild,0);
    }).catch(function(e){ btn.disabled=false; toast(e.message, 5000); });
  }
  // ---- wiring ----
  document.addEventListener("click", function(ev){
    var t=ev.target.closest && ev.target.closest("[data-pick-mark],#pick-add-mark,#pick-add-place,#mk-x,#pl-x,#rd-x,#mk-save,#pl-save,#rd-save,#mk-geo-btn,#pl-geo-btn,#mk-coords-btn,#pl-coords-btn,#pl-anchor-btn,#rd-kind-depth,#rd-kind-rung");
    if(!t) return;
    if(t.hasAttribute("data-pick-mark")){ setMark(t.getAttribute("data-pick-mark")); return; }
    switch(t.id){
      case "pick-add-mark": if(typeof closeSheet==="function") closeSheet(); if(!store.get(PLACE_KEY)){ toast("Pick your spot first."); return; } openMark(); break;
      case "pick-add-place": if(typeof closeSheet==="function") closeSheet(); openPlace(); break;
      case "mk-x": case "pl-x": case "rd-x": closeAll(); $("sheet-bg").classList.remove("open"); break;
      case "mk-save": saveMark(); break;
      case "pl-save": savePlace(); break;
      case "rd-save": saveReading(); break;
      case "mk-geo-btn": geo(function(lat,lon,acc){ $("mk-sheet")._pin=[lat,lon]; $("mk-geo").textContent="Pinned ("+(acc?"±"+Math.round(acc)+" m":"")+")"; }); break;
      case "pl-geo-btn": geo(function(lat,lon,acc){ var r=mileFromPin(lat,lon); $("pl-sheet")._pin=[lat,lon]; if(r){ $("pl-mile").value=r.mile; $("pl-geo").textContent="Pinned — about river mile "+r.mile+", between "+r.up.name+" and "+r.down.name+(r.dist>1.5?" ("+r.dist.toFixed(1)+" mi off the river line — check the mile)":""); } else $("pl-geo").textContent="Pinned, but couldn’t work out the river mile — type it."; }); break;
      case "pl-coords-btn": usePasted("pl-sheet","pl-coords","pl-geo",true); break;
      case "pl-anchor-btn": useAnchor(); break;
      case "mk-coords-btn": usePasted("mk-sheet","mk-coords","mk-geo",false); break;
      case "rd-kind-depth": $("rd-kind-depth").classList.add("on"); $("rd-kind-rung").classList.remove("on"); $("rd-depth-wrap").style.display=""; $("rd-rung-wrap").style.display="none"; break;
      case "rd-kind-rung": $("rd-kind-rung").classList.add("on"); $("rd-kind-depth").classList.remove("on"); $("rd-depth-wrap").style.display="none"; $("rd-rung-wrap").style.display=""; break;
    }
  });
  document.addEventListener("change", function(ev){ if(ev.target.id==="rd-when") $("rd-time").style.display=ev.target.value==="custom"?"":"none"; if(ev.target.id==="rd-rmode") $("rd-rung2-wrap").style.display=ev.target.value==="between"?"":"none"; });
  $("sheet-bg").addEventListener("click", closeAll);
  document.addEventListener("keydown", function(e){ if(e.key==="Escape") closeAll(); });
  // a picker click on a mark row: choose the spot AND the mark
  $("pick-list").addEventListener("click", function(ev){ var row=ev.target.closest && ev.target.closest(".row[data-mark]"); if(!row) return; ev.stopPropagation(); ev.preventDefault(); if(typeof closeSheet==="function") closeSheet(); if(typeof noteRecent==="function") noteRecent(row.getAttribute("data-k")); store.set(MARK_KEY,row.getAttribute("data-mark")); setPlace(row.getAttribute("data-k")); }, true);
  var prevRender=window.onRiverRender;
  window.onRiverRender=function(){ if(typeof prevRender==="function") prevRender(); try{ renderStrip(); }catch(e){ if(window.console) console.error(e); } };
  load();
})();
