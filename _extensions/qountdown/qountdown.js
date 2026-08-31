/*!
 * Qountdown - a time bar for Quarto RevealJS presentations.
 *
 * Draws a second, thin bar stacked on the built-in progress bar. While the
 * progress bar tracks how much of the deck has been shown, this one tracks how
 * much of the allocated time has been used.
 */
window.RevealQountdown = function () {
  'use strict';

  var PLUGIN_ID = 'qountdown';

  var DEFAULTS = {
    minutes: 20,             // allocated time
    start: 'fullscreen',     // 'fullscreen' | 'immediate' | 'manual'
    position: 'above',       // 'above' | 'below' the progress bar
    height: null,            // px; defaults to the progress bar height
    color: '#f0a202',        // accent while on schedule
    warningColor: '#f25c05', // accent past `warningAt`
    overtimeColor: '#d7263d',// accent past the allocated time
    trackColor: 'rgba(0, 0, 0, 0.2)',
    warningAt: 0.8,          // fraction of the allocated time
    pauseOnExit: false,      // pause when leaving fullscreen
    label: false,            // true | 'remaining' | 'elapsed'
    keys: { toggle: 't', reset: 'T' }
  };

  function camelize(key) {
    return String(key).replace(/-+([a-z0-9])/gi, function (_, c) {
      return c.toUpperCase();
    });
  }

  // Accept both kebab-case (YAML habit) and camelCase option names.
  function normalize(raw) {
    var out = {};
    Object.keys(raw || {}).forEach(function (k) {
      out[camelize(k)] = raw[k];
    });
    return out;
  }

  // Allocated time in ms; fractional minutes are allowed, zero is not.
  function minutesToMs(minutes) {
    var m = Number(minutes);
    if (!isFinite(m) || m <= 0) m = DEFAULTS.minutes;
    return Math.max(0.01, m) * 60000;
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatTime(ms) {
    var sign = ms < 0 ? '-' : '';
    var total = Math.round(Math.abs(ms) / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return sign + (h > 0 ? h + ':' + pad(m) : String(m)) + ':' + pad(s);
  }

  return {
    id: PLUGIN_ID,

    init: function (deck) {
      var raw = normalize((deck.getConfig() || {})[PLUGIN_ID] || {});
      var cfg = Object.assign({}, DEFAULTS, raw);
      cfg.keys = raw.keys === false || raw.keys === null
        ? {}
        : Object.assign({}, DEFAULTS.keys, normalize(raw.keys || {}));

      // Nothing to show on the printed / PDF version of the deck.
      if (/print-pdf/gi.test(window.location.search)) return;

      var total = minutesToMs(cfg.minutes);
      var warningAt = Number(cfg.warningAt);
      if (!isFinite(warningAt)) warningAt = DEFAULTS.warningAt;
      warningAt = Math.min(1, Math.max(0, warningAt));

      var state = 'idle';   // 'idle' | 'running' | 'paused'
      var startedAt = 0;    // epoch ms of the current run
      var banked = 0;       // ms accumulated by previous runs
      var ticker = null;
      var overtimeAnnounced = false;

      // --- DOM ------------------------------------------------------------
      var reveal = deck.getRevealElement();

      var el = document.createElement('div');
      el.className = 'qountdown';
      el.setAttribute('aria-hidden', 'true');
      el.style.setProperty('--qountdown-color', cfg.color);
      el.style.setProperty('--qountdown-warning-color', cfg.warningColor);
      el.style.setProperty('--qountdown-overtime-color', cfg.overtimeColor);
      el.style.setProperty('--qountdown-track-color', cfg.trackColor);

      var bar = document.createElement('div');
      bar.className = 'qountdown-bar';
      el.appendChild(bar);

      var label = null;
      if (cfg.label) {
        label = document.createElement('div');
        label.className = 'qountdown-label';
        el.appendChild(label);
      }

      reveal.appendChild(el);

      // --- geometry -------------------------------------------------------
      // Match the progress bar's height and stack on top of (or under) it.
      function layout() {
        var progress = reveal.querySelector('.progress');
        var progressHeight = 0;
        if (progress && window.getComputedStyle(progress).display !== 'none') {
          progressHeight = progress.getBoundingClientRect().height ||
            parseFloat(window.getComputedStyle(progress).height) || 0;
        }

        var height = cfg.height != null
          ? parseFloat(cfg.height)
          : (progressHeight || 3);

        el.style.height = height + 'px';

        if (cfg.position === 'below' && progress) {
          el.style.bottom = '0px';
          progress.style.bottom = height + 'px';
        } else {
          el.style.bottom = progressHeight + 'px';
          if (progress) progress.style.bottom = '';
        }
      }

      // --- timing ---------------------------------------------------------
      function elapsed() {
        return banked + (state === 'running' ? Date.now() - startedAt : 0);
      }

      function render() {
        var ms = elapsed();
        var fraction = ms / total;

        bar.style.width = Math.min(1, fraction) * 100 + '%';
        el.classList.toggle('is-warning', fraction >= warningAt && fraction < 1);
        el.classList.toggle('is-overtime', fraction >= 1);
        el.classList.toggle('is-paused', state === 'paused');
        el.title = formatTime(ms) + ' / ' + formatTime(total);

        if (label) {
          label.textContent = cfg.label === 'elapsed'
            ? formatTime(ms)
            : formatTime(total - ms);
        }

        if (fraction >= 1 && !overtimeAnnounced) {
          overtimeAnnounced = true;
          deck.dispatchEvent({ type: 'qountdown-overtime', data: { elapsed: ms, total: total } });
        }
      }

      function tick(on) {
        if (ticker) {
          clearInterval(ticker);
          ticker = null;
        }
        if (on) ticker = setInterval(render, 200);
      }

      function announce() {
        deck.dispatchEvent({
          type: 'qountdown-state',
          data: { state: state, elapsed: elapsed(), total: total }
        });
      }

      var api = {
        start: function () {
          if (state === 'running') return;
          startedAt = Date.now();
          state = 'running';
          tick(true);
          render();
          announce();
        },
        pause: function () {
          if (state !== 'running') return;
          banked += Date.now() - startedAt;
          state = 'paused';
          tick(false);
          render();
          announce();
        },
        toggle: function () {
          if (state === 'running') api.pause();
          else api.start();
        },
        reset: function () {
          banked = 0;
          startedAt = Date.now();
          overtimeAnnounced = false;
          if (state !== 'running') state = 'idle';
          render();
          announce();
        },
        setMinutes: function (minutes) {
          total = minutesToMs(minutes);
          overtimeAnnounced = elapsed() >= total;
          render();
        },
        getState: function () {
          return { state: state, elapsed: elapsed(), total: total };
        }
      };

      // --- triggers -------------------------------------------------------
      function inFullscreen() {
        if (document.fullscreenElement || document.webkitFullscreenElement) return true;
        // F11-style browser fullscreen does not set fullscreenElement.
        return window.screen &&
          window.innerHeight >= window.screen.height - 2 &&
          window.innerWidth >= window.screen.width - 2;
      }

      function onFullscreenChange() {
        if (inFullscreen()) {
          if (state === 'idle' || cfg.pauseOnExit) api.start();
        } else if (cfg.pauseOnExit) {
          api.pause();
        }
      }

      if (cfg.start === 'immediate') {
        api.start();
      } else if (cfg.start === 'fullscreen') {
        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange);
        window.addEventListener('resize', onFullscreenChange);
        if (inFullscreen()) api.start();
      }

      if (cfg.keys.toggle || cfg.keys.reset) {
        document.addEventListener('keydown', function (event) {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          var target = event.target;
          if (target && (target.isContentEditable ||
            /^(input|textarea|select)$/i.test(target.nodeName))) return;

          if (cfg.keys.toggle && event.key === cfg.keys.toggle) {
            event.preventDefault();
            api.toggle();
          } else if (cfg.keys.reset && event.key === cfg.keys.reset) {
            event.preventDefault();
            api.reset();
          }
        });
      }

      deck.on('resize', layout);
      deck.on('ready', layout);
      layout();
      render();

      // Handy for custom bindings: Reveal.getPlugin('qountdown').api
      this.api = api;
      window.Qountdown = window.Qountdown || api;
    }
  };
};
