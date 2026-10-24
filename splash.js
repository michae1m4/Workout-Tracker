// Opening logo animation (Version 36).
// Plays on the first open, and again when the app is opened after being away for an hour or more.
// It does NOT play when you switch back quickly (for example to log a set), and it is skipped when
// iOS "Reduce Motion" is on. Timings are the numbers finalised in the Animation Tuner.
(function () {
  var splash = document.getElementById('splash');
  if (!splash) return;
  var KEY = 'wt_last_open', AWAY = 60 * 60 * 1000;
  var running = false;

  function getLast() { try { return parseInt(localStorage.getItem(KEY), 10) || 0; } catch (e) { return 0; } }
  function stamp() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function $(id) { return document.getElementById(id); }

  // the finalised numbers (ms unless noted; px values are for a 168px-wide logo and scale with the logo)
  var V = { bstart: 150, bfade: 500, draw: 1050, stroke: 2.5,
            pdel: 225, pstag: 350, pdist: 19, pdur: 1550,
            fstart: 575, fdur: 1400, fsoft: 29,
            sset: -1350, sdist: 10, sdur: 1950,
            goff: 1500, gdur: 2450, gs: 0.75, gsize: 240,
            tstart: 1400, tdur: 1350, tblur: 8, ttrack: 0.40, trise: 5, tsize: 31, tgap: -14,
            bgrot: 270, bglight: 0.25, bgtravel: 80, bgdur: 4000,
            shdel: -25, shdur: 900, rhold: 600, rdur: 600 };
  var LUXE = 'cubic-bezier(.33,0,.15,1)', SOFT = 'cubic-bezier(.4,0,.2,1)';
  var GEO = { oL: [22, 71, 15, 37, 7], iL: [38, 60, 15, 59, 7], bar: [53, 83, 74, 13, 0], iR: [127, 60, 15, 59, 7], oR: [143, 71, 15, 37, 7] };
  var ANIMATED = ['oL', 'iL', 'bar', 'iR', 'oR', 'f_oL', 'f_iL', 'f_bar', 'f_iR', 'f_oR', 'wipeR', 'spAll', 'spBand', 'spBg', 'spLight', 'spGlow', 'spWm', 'splash'];

  function A(el, kf, o) { o.fill = 'both'; return el.animate(kf, o); }
  function cancelAll() { ANIMATED.forEach(function (id) { $(id).getAnimations().forEach(function (a) { a.cancel(); }); }); }

  function finish() {
    running = false;
    cancelAll();
    splash.style.display = 'none';
  }

  // centre the logo and wordmark as one group, keeping the gap between them:
  // measure from the top of the dumbbell to the text baseline and put that block in the middle of the screen
  function centre() {
    var lk = $('spLockup'), mk = $('spMark'), wm = $('spWm');
    lk.style.transform = 'none';
    var top = mk.offsetTop + mk.offsetHeight * (60 / 180), bot = wm.offsetTop + $('spBl').offsetTop;
    lk.style.transform = 'translateY(' + (-(top + bot) / 2) + 'px)';
  }

  function play(isLoad) {
    if (running || reduced() || !splash.animate) return false;
    running = true;
    splash.style.display = 'block';
    cancelAll();

    var mk = $('spMark'), U = mk.offsetWidth / 168, h = V.stroke / 2;
    $('sf1').setAttribute('offset', V.fsoft / 100); $('sf2').setAttribute('offset', 1 - V.fsoft / 100);

    // wordmark and glow sizes
    var wm = $('spWm'), gl = $('spGlow'), lt = $('spLight');
    wm.style.fontSize = (V.tsize * U) + 'px'; wm.style.marginTop = (V.tgap * U) + 'px';
    gl.style.width = gl.style.height = (V.gsize * U) + 'px'; gl.style.marginLeft = gl.style.marginTop = (-V.gsize * U / 2) + 'px';
    gl.style.background = 'radial-gradient(circle, rgba(255,190,90,.55), rgba(255,190,90,0) 65%)';
    lt.style.width = lt.style.height = (360 * U) + 'px'; lt.style.marginLeft = lt.style.marginTop = (-180 * U) + 'px';
    centre();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (running) centre(); });

    // plan
    var t = { bar: V.bstart, iL: V.bstart + V.pdel, iR: V.bstart + V.pdel, oL: V.bstart + V.pdel + V.pstag, oR: V.bstart + V.pdel + V.pstag };
    var fs = V.fstart, fe = fs + V.fdur;
    var arrive = t.oL + V.pdur;
    var ss = Math.max(0, arrive + V.sset), se = ss + V.sdur;
    var sh = Math.max(0, fe + V.shdel), shEnd = sh + V.shdur;
    var gs0 = Math.max(0, V.bstart + V.goff), te = V.tstart + V.tdur;
    var end = Math.max(fe, arrive, se, shEnd, t.bar + V.draw, t.oL + V.draw, te, gs0 + V.gdur * 0.5);
    var rv = end + V.rhold;

    Object.keys(GEO).forEach(function (id) {
      var g = GEO[id], e = $(id), f = $('f_' + id), d = t[id];
      // the outline is drawn just inside the final edge so the logo never changes size
      var w = g[2] - 2 * h, ht = g[3] - 2 * h, r = Math.max(0, g[4] - h);
      e.setAttribute('x', g[0] + h); e.setAttribute('y', g[1] + h); e.setAttribute('width', w); e.setAttribute('height', ht); e.setAttribute('rx', r);
      var P = 2 * (w + ht) - (8 - 2 * Math.PI) * r;
      e.style.strokeDasharray = P + ' ' + P;
      A(e, [{ strokeDashoffset: P + 'px', strokeWidth: V.stroke + 'px' }, { strokeDashoffset: '0px', strokeWidth: V.stroke + 'px' }], { delay: d, duration: V.draw, easing: LUXE });
      A(e, [{ strokeWidth: V.stroke + 'px' }, { strokeWidth: '0px' }], { delay: Math.max(fe - 500, d + V.draw), duration: 500, easing: 'linear' });
      A(f, [{ opacity: 0 }, { opacity: 1 }], { delay: d + V.draw * 0.55, duration: 250, easing: 'linear' });
      if (id === 'bar') {
        A(e, [{ opacity: 0 }, { opacity: 1 }], { delay: d, duration: V.bfade, easing: 'linear' }); // the bar only fades in, it never moves
      } else {
        var dir = (id === 'iL' || id === 'oL') ? -1 : 1; // left plates slide in from the left, right plates from the right
        var kf = [{ transform: 'translateX(' + (dir * V.pdist) + 'px)' }, { transform: 'translateX(0px)' }];
        A(e, kf, { delay: d, duration: V.pdur, easing: LUXE }); A(f, kf, { delay: d, duration: V.pdur, easing: LUXE });
      }
    });
    A($('wipeR'), [{ transform: 'scaleX(.02)' }, { transform: 'scaleX(1.25)' }], { delay: fs, duration: V.fdur, easing: LUXE });
    A($('spAll'), [{ transform: 'translateY(' + (-V.sdist) + 'px)' }, { transform: 'translateY(0px)' }], { delay: ss, duration: V.sdur, easing: SOFT });
    A($('spBand'), [{ transform: 'skewX(-18deg) translateX(-60px)' }, { transform: 'skewX(-18deg) translateX(300px)' }], { delay: sh, duration: V.shdur, easing: 'cubic-bezier(.45,0,.2,1)' });

    // glow behind the logo
    A(gl, [{ opacity: 0, transform: 'scale(.55)', offset: 0 }, { opacity: V.gs, offset: 0.4 }, { opacity: V.gs * 0.35, transform: 'scale(1.1)', offset: 1 }], { delay: gs0, duration: V.gdur, easing: 'cubic-bezier(0,0,.2,1)' });
    // wordmark: comes into focus (soft and wide, tightening to sharp)
    var tk = V.ttrack + 'em';
    A(wm, [{ opacity: 0, filter: 'blur(' + V.tblur * U + 'px)', letterSpacing: tk, textIndent: tk, transform: 'translateY(' + V.trise * U + 'px)' },
           { opacity: 1, filter: 'blur(0px)', letterSpacing: '.02em', textIndent: '.02em', transform: 'translateY(0px)' }], { delay: V.tstart, duration: V.tdur, easing: LUXE });
    // background gradient turns slowly while a soft warm light drifts across it
    A($('spBg'), [{ transform: 'rotate(' + (-V.bgrot / 2) + 'deg)' }, { transform: 'rotate(' + (V.bgrot / 2) + 'deg)' }], { delay: 0, duration: V.bgdur, easing: SOFT });
    var tr = V.bgtravel * U;
    A(lt, [{ opacity: 0, transform: 'translate(' + (-tr * 0.6) + 'px,' + (-tr) + 'px)', offset: 0 }, { opacity: V.bglight, offset: 0.35 }, { opacity: V.bglight, offset: 0.7 },
           { opacity: 0, transform: 'translate(' + (tr * 0.6) + 'px,' + tr + 'px)', offset: 1 }], { delay: 0, duration: V.bgdur, easing: SOFT });

    // hand-off: the logo screen fades, Home rises in underneath (first open only)
    var out = A(splash, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.05)' }], { delay: rv, duration: V.rdur, easing: LUXE });
    out.onfinish = finish;
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
