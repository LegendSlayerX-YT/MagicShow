/* ===========================================================
   Magic background — drifting card suits + twinkling sparkles
   Lightweight canvas animation, respects reduced-motion.
   =========================================================== */
(function () {
  var canvas = document.getElementById('magic-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var W, H, DPR;
  var suits = ['♠', '♥', '♦', '♣']; // ♠ ♥ ♦ ♣
  var cards = [];
  var sparkles = [];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function makeCards() {
    var count = Math.max(10, Math.round(W / 90));
    cards = [];
    for (var i = 0; i < count; i++) {
      cards.push({
        x: rand(0, W),
        y: rand(0, H),
        size: rand(18, 42),
        suit: suits[Math.floor(rand(0, suits.length))],
        speed: rand(8, 26),
        drift: rand(-12, 12),
        rot: rand(0, Math.PI * 2),
        rotSpeed: rand(-0.4, 0.4),
        alpha: rand(0.05, 0.16),
        red: Math.random() > 0.5
      });
    }
  }

  function makeSparkles() {
    var count = Math.max(40, Math.round((W * H) / 14000));
    sparkles = [];
    for (var i = 0; i < count; i++) {
      sparkles.push({
        x: rand(0, W),
        y: rand(0, H),
        r: rand(0.4, 1.8),
        base: rand(0.1, 0.5),
        twinkle: rand(0.5, 2.2),
        phase: rand(0, Math.PI * 2)
      });
    }
  }

  var last = 0;
  function frame(t) {
    var dt = Math.min((t - last) / 1000, 0.05) || 0;
    last = t;
    ctx.clearRect(0, 0, W, H);

    // sparkles
    for (var i = 0; i < sparkles.length; i++) {
      var s = sparkles[i];
      s.phase += s.twinkle * dt;
      var a = s.base + Math.sin(s.phase) * s.base * 0.8;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 240, 225,' + Math.max(0, a) + ')';
      ctx.fill();
    }

    // drifting card suits
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      c.y -= c.speed * dt;
      c.x += c.drift * dt;
      c.rot += c.rotSpeed * dt;
      if (c.y < -60) { c.y = H + 40; c.x = rand(0, W); }
      if (c.x < -60) c.x = W + 40;
      if (c.x > W + 60) c.x = -40;

      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.font = c.size + 'px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = c.red
        ? 'rgba(255, 90, 96,' + c.alpha + ')'
        : 'rgba(255, 235, 220,' + c.alpha + ')';
      ctx.fillText(c.suit, 0, 0);
      ctx.restore();
    }

    requestAnimationFrame(frame);
  }

  function drawStatic() {
    // single non-animated frame for reduced-motion users
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < sparkles.length; i++) {
      var s = sparkles[i];
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 240, 225,' + s.base + ')';
      ctx.fill();
    }
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.font = c.size + 'px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = c.red
        ? 'rgba(255, 90, 96,' + c.alpha + ')'
        : 'rgba(255, 235, 220,' + c.alpha + ')';
      ctx.fillText(c.suit, 0, 0);
      ctx.restore();
    }
  }

  function init() {
    resize();
    makeCards();
    makeSparkles();
    if (reduceMotion) drawStatic();
    else requestAnimationFrame(frame);
  }

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      makeCards();
      makeSparkles();
      if (reduceMotion) drawStatic();
    }, 150);
  });

  init();
})();
