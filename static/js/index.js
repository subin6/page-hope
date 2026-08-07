/* HOPE project page — clip switching, lazy playback, reveal-on-scroll. */
(function () {
  'use strict';

  var VIDEOS = './media/videos/';
  var POSTERS = './media/posters/';
  var THUMBS = './media/thumbs/';

  // `webm` mirrors media/videos/manifest.json: the build drops a webm when VP9
  // comes out bigger than H.264, and listing a source that 404s costs a request
  // on every load.
  // Each strip on the page opens on a different clip, so the three sections do
  // not all greet the reader with the same frame.
  var WILD_CLIPS = [
    { id: 'segment_037', name: 'Stirring a pan', webm: true },
    { id: 'gopro_20', name: 'Desk assembly', webm: true },
    { id: 'rashult_20', name: 'Stand assembly', webm: true },
    { id: 'segment_018', name: 'Kitchen counter', webm: true },
    { id: 'video_0', name: 'Setting a table', webm: true }
  ];
  var PAIR_CLIPS = [
    { id: 'rashult_20_pair', name: 'Stand assembly', webm: true },
    { id: 'gopro_20_pair', name: 'Desk assembly', webm: true }
  ];

  /* ---------------------------------------------------- lazy playback */

  var playObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var video = entry.target;
      if (entry.isIntersecting) {
        video.dataset.visible = 'true';
        // The fetch starts here, not when the sources are attached: calling
        // load() up front overrides preload="none" and pulls megabytes for
        // videos that may be several screens down.
        if (video.dataset.pending === 'true') {
          video.dataset.pending = 'false';
          video.load();
        }
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        video.dataset.visible = 'false';
        video.pause();
      }
    });
  }, { rootMargin: '200px' });

  // Formats are listed as <source> children rather than picked with
  // canPlayType, so the browser does the negotiating.
  function setSource(video, clip) {
    if (video.dataset.clip === clip.id) return;
    video.dataset.clip = clip.id;
    video.poster = POSTERS + clip.id + '.jpg';
    video.innerHTML = '';
    var formats = clip.webm === false
      ? [['mp4', 'video/mp4']]
      : [['webm', 'video/webm'], ['mp4', 'video/mp4']];
    formats.forEach(function (fmt) {
      var s = document.createElement('source');
      s.src = VIDEOS + clip.id + '.' + fmt[0];
      s.type = fmt[1];
      video.appendChild(s);
    });
    if (video.dataset.visible === 'true') {
      video.dataset.pending = 'false';
      video.load();
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    } else {
      video.dataset.pending = 'true';
    }
  }

  /* ------------------------------------------------------ clip strips */

  function buildStrip(stripEl, video, clips) {
    if (!stripEl || !video) return;
    var buttons = clips.map(function (clip, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thumb' + (i === 0 ? ' is-active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');

      var img = document.createElement('img');
      img.src = THUMBS + clip.id + '.jpg';
      img.alt = clip.name;
      img.loading = 'lazy';
      btn.appendChild(img);

      var label = document.createElement('span');
      label.className = 'thumb__name';
      label.textContent = clip.name;
      btn.appendChild(label);

      btn.addEventListener('click', function () {
        buttons.forEach(function (b) {
          b.classList.remove('is-active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('is-active');
        btn.setAttribute('aria-selected', 'true');
        setSource(video, clip);
      });

      stripEl.appendChild(btn);
      return btn;
    });

    setSource(video, clips[0]);
    playObserver.observe(video);
  }

  buildStrip(document.getElementById('wildStrip'), document.getElementById('wildVideo'), WILD_CLIPS);
  buildStrip(document.getElementById('pairStrip'), document.getElementById('pairVideo'), PAIR_CLIPS);

  /* --------------------------------------------------- reveal on scroll */

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var revealables = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if (reduced) {
    revealables.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    revealables.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ---------------------------------------------------------- bibtex */

  var copyBtn = document.getElementById('copyBibtex');
  var bibtex = document.getElementById('bibtexCode');
  if (copyBtn && bibtex && navigator.clipboard) {
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(bibtex.textContent).then(function () {
        copyBtn.textContent = 'Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1600);
      });
    });
  } else if (copyBtn) {
    copyBtn.hidden = true;
  }

  /* -------------------------------------------- disabled resource links */

  Array.prototype.forEach.call(document.querySelectorAll('a[aria-disabled="true"]'), function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); });
  });
})();
