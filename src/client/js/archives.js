/* ===========================================================
   Archives — fetch the YouTube playlist from our backend
   (/api/playlist, which holds the API key server-side),
   apply per-video overrides, and render a zigzag of shows.
   Falls back to CONFIG.fallback when the backend is
   unreachable or returns nothing. Videos load as click-to-play
   facades so the page stays fast no matter how many shows.
   =========================================================== */
(function () {
  var cfg = window.CONFIG || {};
  var container = document.getElementById('shows');
  if (!container) return;

  function status(msg) {
    container.innerHTML = '<p class="archive-status">' + msg + '</p>';
  }

  // Merge YouTube data with any override defined in config.
  function applyOverride(video) {
    var o = (cfg.overrides || {})[video.id];
    if (o) {
      if (o.title) video.title = o.title;
      if (o.caption) video.caption = o.caption;
    }
    return video;
  }

  var MAIN_COUNT = 3;

  // Shared facade markup so the big shows and the scroll cards play the same way.
  function videoFacade(v) {
    var thumb = 'https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg';
    return '<div class="video" data-id="' + v.id + '" role="button" tabindex="0" aria-label="Play ' + escapeHtml(v.title) + '">' +
        '<img loading="lazy" src="' + thumb + '" alt="' + escapeHtml(v.title) + '" ' +
             'onerror="this.src=\'https://i.ytimg.com/vi/' + v.id + '/0.jpg\'">' +
        '<span class="video__play" aria-hidden="true"></span>' +
      '</div>';
  }

  // Full-width zigzag entry for the first few shows.
  function buildShow(v) {
    var caption = v.caption || '';
    var watchUrl = 'https://www.youtube.com/watch?v=' + v.id;
    var show = document.createElement('article');
    show.className = 'show';
    show.innerHTML =
      '<div class="show__media">' + videoFacade(v) + '</div>' +
      '<div class="show__text">' +
        '<h2 class="show__title">' + escapeHtml(v.title) + '</h2>' +
        (caption ? '<p class="show__caption">' + escapeHtml(caption) + '</p>' : '') +
        '<a class="show__link" href="' + watchUrl + '" target="_blank" rel="noopener">Watch on YouTube ↗</a>' +
      '</div>';
    return show;
  }

  // Compact card for the horizontal "more shows" scroll row.
  function buildCard(v) {
    var card = document.createElement('article');
    card.className = 'show-card';
    card.innerHTML =
      videoFacade(v) +
      '<h3 class="show-card__title">' + escapeHtml(v.title) + '</h3>';
    return card;
  }

  function render(videos) {
    if (!videos || !videos.length) {
      status('No shows to display yet — check back soon!');
      return;
    }
    container.innerHTML = '';

    // Drop any "more shows" row from a previous render.
    var oldMore = document.getElementById('more-shows');
    if (oldMore) oldMore.parentNode.removeChild(oldMore);

    videos.forEach(applyOverride);

    videos.slice(0, MAIN_COUNT).forEach(function (v) {
      container.appendChild(buildShow(v));
    });

    var rest = videos.slice(MAIN_COUNT);
    if (rest.length) {
      var more = document.createElement('section');
      more.id = 'more-shows';
      more.className = 'more-shows';
      more.innerHTML =
        '<h2 class="more-shows__title">More Shows</h2>' +
        '<div class="more-shows__row"></div>';
      var row = more.querySelector('.more-shows__row');
      rest.forEach(function (v) { row.appendChild(buildCard(v)); });
      container.parentNode.insertBefore(more, container.nextSibling);
      wirePlay(more);
    }

    wirePlay(container);
  }

  // Swap a facade for the real embedded player on click/Enter.
  function wirePlay(root) {
    root.querySelectorAll('.video').forEach(function (el) {
      function play() {
        var id = el.getAttribute('data-id');
        el.innerHTML =
          '<iframe src="https://www.youtube.com/embed/' + id + '?autoplay=1&rel=0" ' +
          'title="YouTube video player" allow="accelerometer; autoplay; clipboard-write; ' +
          'encrypted-media; gyroscope; picture-in-picture; web-share" ' +
          'allowfullscreen></iframe>';
      }
      el.addEventListener('click', play);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); }
      });
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function useFallback() {
    render((cfg.fallback || []).map(function (v) {
      return { id: v.id, title: v.title, caption: v.caption };
    }));
  }

  // ---- Live fetch from our backend (key stays server-side) ----
  function fetchLive() {
    fetch(cfg.apiUrl || '/api/playlist')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var videos = data && data.videos;
        if (!videos || !videos.length) { useFallback(); return; }
        render(videos);
      })
      .catch(function (err) {
        console.warn('Playlist fetch failed, using fallback:', err);
        useFallback();
      });
  }

  // ---- Boot ----
  fetchLive();
})();
