// Opening logo animation (Version 33).
// Plays on the first open, and again when the app is opened after being away for an hour or more.
// It does NOT play when you switch back quickly (for example to log a set), and it is skipped when
// iOS "Reduce Motion" is on. Timings come from the numbers tuned in the Animation Tuner.
(function () {
  var splash = document.getElementById('splash');
  if (!splash) return;
  var KEY = 'wt_last_open', AWAY = 60 * 60 * 1000;
  var running = false;

  function getLast() { try { return parseInt(localStorage.getItem(KEY), 10) || 0; } catch (e) { return 0; } }
  function stamp() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function $(id) { return document.getElementById(id); }

  // the tuned numbers
  var V = { draw: 1000, stroke: 2.5, fstart: 600, fdur: 1400, fsoft: 29, dist: 12, sdur: 2700, sdel: 75,
            pdel: 225, pstag: 350, pdist: 19, pdur: 1550, shdel: -25, shdur: 900, shop: 1, rhold: 0, rdur: 600 };
  var LUXE = 'cubic-bezier(.33,0,.15,1)', SOFT = 'cubic-bezier(.4,0,.2,1)', T0 = 150;
  var GEO = { oL: [22, 71, 15, 37, 7], iL: [38, 60, 15, 59, 7], bar: [53, 83, 74, 13, 0], iR: [127, 60, 15, 59, 7], oR: [143, 71, 15, 37, 7] };
  var ANIMATED = ['oL', 'iL', 'bar', 'iR', 'oR', 'f_oL', 'f_iL', 'f_bar', 'f_iR', 'f_oR', 'wipeR', 'spAll', 'spBand', 'splash'];

  function A(el, kf, o) { o.fill = 'both'; return el.animate(kf, o); }

  function finish() {
    running = false;
    ANIMATED.forEach(function (id) { $(id).getAnimations().forEach(function (a) { a.cancel(); }); });
    splash.style.display = 'none';
  }

  function play(isLoad) {
    if (running || reduced() || !splash.animate) return false;
    running = true;
    splash.style.display = 'grid';
    ANIMATED.forEach(function (id) { $(id).getAnimations().forEach(function (a) { a.cancel(); }); });
    var h = V.stroke / 2;
    $('sf1').setAttribute('offset', V.fsoft / 100); $('sf2').setAttribute('offset', 1 - V.fsoft / 100);
    $('spMid').setAttribute('stop-opacity', V.shop);
    var timing = { bar: [T0, 0], iL: [T0 + V.pdel, V.pdist], iR: [T0 + V.pdel, V.pdist],
                   oL: [T0 + V.pdel + V.pstag, V.pdist], oR: [T0 + V.pdel + V.pstag, V.pdist] };
    var fs = T0 + V.fstart, fe = fs + V.fdur, partsEnd = fe;
    Object.keys(GEO).forEach(function (id) {
      var g = GEO[id], e = $(id), f = $('f_' + id), d = timing[id][0], drop = timing[id][1];
      // outline drawn just inside the final edge so the logo never changes size
      var w = g[2] - 2 * h, ht = g[3] - 2 * h, r = Math.max(0, g[4] - h);
      e.setAttribute('x', g[0] + h); e.setAttribute('y', g[1] + h); e.setAttribute('width', w); e.setAttribute('height', ht); e.setAttribute('rx', r);
      var P = 2 * (w + ht) - (8 - 2 * Math.PI) * r;
      e.style.strokeDasharray = P + ' ' + P;
      A(e, [{ strokeDashoffset: P + 'px', strokeWidth: V.stroke + 'px' }, { strokeDashoffset: '0px', strokeWidth: V.stroke + 'px' }], { delay: d, duration: V.draw, easing: LUXE });
      A(e, [{ strokeWidth: V.stroke + 'px' }, { strokeWidth: '0px' }], { delay: Math.max(fe - 500, d + V.draw), duration: 500, easing: 'linear' });
      A(f, [{ opacity: 0 }, { opacity: 1 }], { delay: d + V.draw * 0.55, duration: 250, easing: 'linear' });
      if (drop > 0) {
        var kf = [{ transform: 'translateY(' + (-drop) + 'px)' }, { transform: 'none' }];
        A(e, kf, { delay: d, duration: V.pdur, easing: LUXE }); A(f, kf, { delay: d, duration: V.pdur, easing: LUXE });
      }
      partsEnd = Math.max(partsEnd, d + V.draw);
    });
    A($('wipeR'), [{ transform: 'scaleX(.02)' }, { transform: 'scaleX(1.25)' }], { delay: fs, duration: V.fdur, easing: LUXE });
    A($('spAll'), [{ transform: 'translateY(' + (-V.dist) + 'px)' }, { transform: 'none' }], { delay: V.sdel, duration: V.sdur, easing: SOFT });
    var end = Math.max(partsEnd, V.sdel + V.sdur);
    var st = Math.max(0, partsEnd + V.shdel);
    A($('spBand'), [{ transform: 'skewX(-18deg) translateX(-60px)' }, { transform: 'skewX(-18deg) translateX(300px)' }], { delay: st, duration: V.shdur, easing: 'cubic-bezier(.45,0,.2,1)' });
    end = Math.max(end, st + V.shdur);
    var rv = end + V.rhold;
    var out = A(splash, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.05)' }], { delay: rv, duration: V.rdur, easing: LUXE });
    out.onfinish = finish;
    // Home rises in underneath as the logo screen fades (first open only)
    if (isLoad) setTimeout(function () { if (running && window.animateIn) window.animateIn('homeView'); }, rv);
    return true;
  }

  // tapping the version number on Home replays the animation, and explains if it cannot play
  window.replaySplash = function () {
    if (!splash.animate) { alert('This browser cannot play the animation.'); return; }
    if (reduced()) { alert('The animation is skipped because Reduce Motion is on (Settings > Accessibility > Motion). Turn it off to see it.'); return; }
    if (running) return;
    play(false);
  };

  // tap to skip
  splash.addEventListener('click', function () { if (running) finish(); });

  // first open (or opened after an hour or more away)
  var last = getLast();
  if (!last || Date.now() - last >= AWAY) play(true);
  stamp();

  // coming back to an app that was left running
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { stamp(); return; }
    if (Date.now() - getLast() >= AWAY) play(false);
    stamp();
  });
  window.addEventListener('pagehide', stamp);
})();
