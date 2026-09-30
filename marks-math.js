// Depth marks: the math that turns user readings at a fixed reference (a
// "mark") into a local curve, and back into depths and landmark phrases.
// Pure functions; runs in the page (plain script) and in Node (CommonJS).
//
// A reading is { kind:"depth", depth } or { kind:"rung", rung } (or
// { kind:"between", rung, rung2 }, { kind:"over" }, { kind:"under" }), always
// with `stage`: the modeled ABSOLUTE stage (ft) at the reference sensor for the
// moment of the reading. Depth readings fit depth = a + b*stage; rung readings
// pin each rung's height on the same stage scale.
(function(root, factory){
  if(typeof module==="object" && module.exports) module.exports=factory();
  else root.MarksMath=factory();
})(typeof self!=="undefined"?self:this, function(){
  "use strict";
  var MAX_AGE_DAYS=120, DEPTH_TOL=0.5, RUNG_TOL=0.6, AT_TOL=0.15;
  function med(a){ if(!a.length) return null; var s=a.slice().sort(function(x,y){return x-y;}); var m=s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; }
  function usable(readings, now){
    now=now||Date.now();
    return (readings||[]).filter(function(r){ return r && r.status!=="hidden" && r.status!=="flagged" && r.stage!=null && isFinite(r.stage) && (now-(r.t||0))<MAX_AGE_DAYS*86400000; });
  }
  // depth = a + b*stage. Slope needs 5+ readings spanning 1.5 ft of stage;
  // otherwise slope 1 (the local water surface moves with the sensor's) and
  // the intercept is the median offset of the newest readings.
  function fitDepth(readings, now){
    var d=usable(readings, now).filter(function(r){ return r.kind==="depth" && r.depth!=null; }).sort(function(x,y){ return x.t-y.t; });
    if(!d.length) return null;
    var st=d.map(function(r){return r.stage;}), span=Math.max.apply(null,st)-Math.min.apply(null,st);
    var b=1, method="offset";
    if(d.length>=5 && span>=1.5){
      var slopes=[];
      for(var i=0;i<d.length;i++) for(var j=i+1;j<d.length;j++){ var dx=d[j].stage-d[i].stage; if(Math.abs(dx)>=0.3) slopes.push((d[j].depth-d[i].depth)/dx); }
      if(slopes.length>=6){ b=Math.max(0.5, Math.min(1.5, med(slopes))); method="fit"; }
    }
    var recent=d.slice(-12);
    var a=med(recent.map(function(r){ return r.depth-b*r.stage; }));
    var resid=d.map(function(r){ return Math.abs(r.depth-(a+b*r.stage)); });
    return { a:a, b:b, n:d.length, span:+span.toFixed(2), method:method, lastT:d[d.length-1].t, scatter:+(med(resid)||0).toFixed(2) };
  }
  function depthAt(curve, stage){ if(!curve || stage==null) return null; return curve.a+curve.b*stage; }
  // Each rung's height on the stage scale: median of the stages it was read at
  // (an "at rung X" reading says the water surface WAS that rung's height).
  // Owner-entered heights (relative to the bottom rung) seed a rung when it has
  // no readings, anchored by any rung that does have readings.
  function fitLadder(ladder, readings, now){
    if(!ladder || !ladder.length) return null;
    var u=usable(readings, now), out={}, anchor=null;
    ladder.forEach(function(rg, i){
      var st=u.filter(function(r){ return r.kind==="rung" && r.rung===rg.id; }).map(function(r){ return r.stage; });
      // a "between A and B" reading: with the owner's heights the fraction says
      // exactly where each rung sits; otherwise it pins the midpoint loosely.
      u.filter(function(r){ return r.kind==="between" && (r.rung===rg.id || r.rung2===rg.id); }).forEach(function(r){
        var A=ladder.find(function(x){ return x.id===r.rung; }), B=ladder.find(function(x){ return x.id===r.rung2; });
        var f=(r.frac!=null && isFinite(r.frac)) ? Math.max(0,Math.min(1,+r.frac)) : 0.5;
        if(A && B && A.h!=null && B.h!=null && B.h>A.h){ var gap=B.h-A.h; st.push(r.rung===rg.id ? r.stage-f*gap : r.stage+(1-f)*gap); }
        else st.push(r.stage + (r.rung===rg.id ? -0.25 : 0.25));
      });
      out[rg.id]={ id:rg.id, label:rg.label, i:i, n:st.length, stage:st.length?med(st):null, spread:st.length>=3?+(med(st.map(function(v){ return Math.abs(v-med(st)); })) ).toFixed(2):null };
      if(st.length>=1 && !anchor) anchor={i:i, stage:out[rg.id].stage, h:rg.h};
    });
    // seed unread rungs from owner heights (h = ft above the bottom rung)
    ladder.forEach(function(rg){ var o=out[rg.id]; if(o.stage==null && rg.h!=null && anchor && anchor.h!=null){ o.stage=anchor.stage+(rg.h-anchor.h); o.seeded=true; } });
    // ordering check: a rung read below the one under it is suspect
    var prev=null;
    ladder.forEach(function(rg){ var o=out[rg.id]; if(o.stage==null) return; if(prev && o.stage<prev.stage-AT_TOL){ o.disorder=true; prev.disorder=true; } prev=o; });
    return out;
  }
  // Where the water sits on the ladder for a given stage.
  function rungAt(fit, ladder, stage){
    if(!fit || !ladder || stage==null) return null;
    var known=ladder.map(function(rg){ return fit[rg.id]; }).filter(function(o){ return o && o.stage!=null; });
    if(!known.length) return null;
    for(var i=0;i<known.length;i++){ if(Math.abs(stage-known[i].stage)<=AT_TOL) return {kind:"at", rung:known[i], text:"right at "+known[i].label}; }
    if(stage<known[0].stage) return {kind:"under", rung:known[0], text:(known[0].stage-stage).toFixed(1)+" ft below "+known[0].label};
    var top=known[known.length-1];
    if(stage>top.stage) return {kind:"over", rung:top, text:(stage-top.stage).toFixed(1)+" ft over "+top.label};
    for(var j=1;j<known.length;j++){ if(stage<known[j].stage) return {kind:"between", lo:known[j-1], hi:known[j], frac:(stage-known[j-1].stage)/((known[j].stage-known[j-1].stage)||1), text:"between "+known[j-1].label+" and "+known[j].label}; }
    return null;
  }
  // Where the water sits on the photo (0 = top, 1 = bottom) for a stage, from
  // rungs that have both a fitted stage and a tapped position. Two are enough;
  // beyond the end rungs it extrapolates a little, then clamps.
  function waterlineY(fit, ladder, stage){
    if(!fit || !ladder || stage==null) return null;
    var pts=ladder.map(function(rg){ var o=fit[rg.id]; return (o && o.stage!=null && rg.px && rg.px.y!=null) ? {s:o.stage, y:+rg.px.y, bad:!!o.disorder} : null; }).filter(Boolean);
    if(pts.length<2 || pts.some(function(p){ return p.bad; })) return null; // an out-of-order ladder can't place the water
    pts.sort(function(a,b){ return a.s-b.s; });
    for(var k=1;k<pts.length;k++){ if(pts[k].y>=pts[k-1].y) return null; } // higher water must sit higher in the photo
    var i=0; while(i<pts.length-2 && stage>pts[i+1].s) i++;
    var a=pts[i], b=pts[i+1]; if(!(b.s>a.s)) return null;
    var t=(stage-a.s)/(b.s-a.s), y=a.y+(b.y-a.y)*t;
    var lo=Math.min(a.y,b.y), hi=Math.max(a.y,b.y), pad=0.35*(hi-lo);
    return Math.max(0.02, Math.min(0.98, Math.max(lo-pad, Math.min(hi+pad, y))));
  }
  // Does a new reading disagree with what the mark already knows?
  function flagReading(r, curve, ladderFit){
    if(!r || r.stage==null) return null;
    if(r.kind==="depth" && curve && curve.n>=3){ var pred=depthAt(curve, r.stage), tol=Math.max(DEPTH_TOL, 1.5*(curve.scatter||0)); if(pred!=null && Math.abs(r.depth-pred)>tol) return "reads "+Math.abs(r.depth-pred).toFixed(1)+" ft off the mark's curve"; }
    if((r.kind==="rung") && ladderFit && ladderFit[r.rung] && ladderFit[r.rung].n>=3 && Math.abs(r.stage-ladderFit[r.rung].stage)>RUNG_TOL) return "puts "+ladderFit[r.rung].label+" "+Math.abs(r.stage-ladderFit[r.rung].stage).toFixed(1)+" ft from where other readings put it";
    if(r.kind==="depth" && r.depth<0) return "negative depth";
    return null;
  }
  function fmtDepth(ft){ if(ft==null||!isFinite(ft)) return null; if(ft<0) ft=0; var f=Math.floor(ft), i=Math.round((ft-f)*12); if(i===12){ f++; i=0; } return f+"′"+(i?i+"″":"")+(f===0&&i===0?" (dry)":""); }
  return { fitDepth:fitDepth, depthAt:depthAt, fitLadder:fitLadder, rungAt:rungAt, waterlineY:waterlineY, flagReading:flagReading, fmtDepth:fmtDepth, med:med, DEPTH_TOL:DEPTH_TOL };
});
