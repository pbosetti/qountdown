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
    onExit: 'reset',         // on leaving fullscreen: 'reset' | 'pause' | 'continue'
    label: false,            // true | 'remaining' | 'elapsed'
    labelPosition: 'bl',     // 'bl' | 'br' | 'tr' | 'tl'
    keys: { toggle: 't', reset: 'T', set: 'M' }
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

  var CORNERS = {
    bl: 'bl', br: 'br', tl: 'tl', tr: 'tr',
    bottomleft: 'bl', bottomright: 'br', topleft: 'tl', topright: 'tr'
  };

  function corner(value) {
    var key = String(value == null ? '' : value).toLowerCase().replace(/[^a-z]/g, '');
    return CORNERS[key] || DEFAULTS.labelPosition;
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

      // Only a fullscreen-triggered clock resets itself on leaving fullscreen.
      if (raw.onExit === undefined && cfg.start !== 'fullscreen') cfg.onExit = 'continue';

      var labelCorner = corner(cfg.labelPosition);
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
        label.className = 'qountdown-label qountdown-label--' + labelCorner;
        label.setAttribute('aria-hidden', 'true');
        label.style.setProperty('--qountdown-overtime-color', cfg.overtimeColor);
      }

      // Type-in duration, in the spirit of the RevealJS jump-to-slide box.
      var prompt = null;
      var promptInput = null;
      if (cfg.keys.set) {
        prompt = document.createElement('div');
        prompt.className = 'qountdown-prompt';
        prompt.style.setProperty('--qountdown-color', cfg.color);

        promptInput = document.createElement('input');
        promptInput.type = 'text';
        promptInput.inputMode = 'numeric';
        promptInput.autocomplete = 'off';
        promptInput.setAttribute('aria-label', 'Minutes');
        prompt.appendChild(promptInput);

        var unit = document.createElement('span');
        unit.className = 'qountdown-prompt-unit';
        unit.textContent = 'min';
        prompt.appendChild(unit);
      }

      reveal.appendChild(el);
      if (label) reveal.appendChild(label);
      if (prompt) reveal.appendChild(prompt);

      // --- geometry -------------------------------------------------------
      var LABEL_INSET = 12; // px from the edge of the deck

      function visible(node) {
        if (!node) return false;
        var cs = window.getComputedStyle(node);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
      }

      // Width to keep clear so the clock does not sit on top of the menu
      // button, the slide number or the navigation arrows.
      function chromeWidth(selectors) {
        var widest = 0;
        selectors.forEach(function (selector) {
          var node = reveal.querySelector(selector) || document.querySelector(selector);
          if (!visible(node)) return;
          widest = Math.max(widest, node.getBoundingClientRect().width);
        });
        return widest ? widest + 8 : 0;
      }

      // Match the progress bar's height and stack on top of (or under) it.
      function layout() {
        var progress = reveal.querySelector('.progress');
        var progressHeight = visible(progress)
          ? (progress.getBoundingClientRect().height ||
             parseFloat(window.getComputedStyle(progress).height) || 0)
          : 0;

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

        if (prompt) prompt.style.bottom = (height + progressHeight + 6) + 'px';

        if (!label) return;

        label.style.top = '';
        label.style.bottom = '';
        label.style.left = '';
        label.style.right = '';

        var inset = LABEL_INSET;
        if (labelCorner === 'bl') {
          // Both bars, then a gap, then the clock.
          label.style.bottom = (height + progressHeight + 6) + 'px';
          inset += chromeWidth(['.slide-menu-button']);
        } else if (labelCorner === 'br') {
          label.style.bottom = (height + progressHeight + 6) + 'px';
          inset += chromeWidth(['.slide-number', '.controls']);
        } else {
          label.style.top = LABEL_INSET + 'px';
        }

        label.style[labelCorner.charAt(1) === 'l' ? 'left' : 'right'] = inset + 'px';
      }

      // --- timing ---------------------------------------------------------
      function elapsed() {
        return banked + (state === 'running' ? Date.now() - startedAt : 0);
      }

      function render() {
        var ms = elapsed();
        var fraction = ms / total;

        bar.style.width = Math.min(1, fraction) * 100 + '%';
        el.title = formatTime(ms) + ' / ' + formatTime(total);

        [el, label].forEach(function (node) {
          if (!node) return;
          node.classList.toggle('is-warning', fraction >= warningAt && fraction < 1);
          node.classList.toggle('is-overtime', fraction >= 1);
          node.classList.toggle('is-paused', state === 'paused');
          node.classList.toggle('is-idle', state === 'idle');
        });

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
        // Back to zero and idle, whatever the clock was doing.
        stop: function () {
          banked = 0;
          startedAt = 0;
          overtimeAnnounced = false;
          state = 'idle';
          tick(false);
          render();
          announce();
        },
        setMinutes: function (minutes) {
          total = minutesToMs(minutes);
          overtimeAnnounced = elapsed() >= total;
          render();
          announce();
        },
        // Open the type-in box; the elapsed time is left alone.
        promptMinutes: function () {
          openPrompt();
        },
        getState: function () {
          return { state: state, elapsed: elapsed(), total: total };
        }
      };

      // --- duration prompt ------------------------------------------------
      function openPrompt() {
        if (!prompt) return;
        promptInput.value = '';
        // The current allocation, as a hint of what is being replaced.
        promptInput.placeholder = String(Math.round(total / 600) / 100);
        prompt.classList.add('is-open');
        layout();
        promptInput.focus();
      }

      // Closing is also what `blur` does, hence the guard: `promptInput.blur()`
      // below comes straight back here.
      function closePrompt(apply) {
        if (!prompt || !prompt.classList.contains('is-open')) return;
        var minutes = parseInt(promptInput.value, 10);
        prompt.classList.remove('is-open');
        promptInput.blur();
        if (apply && isFinite(minutes) && minutes > 0) api.setMinutes(minutes);
      }

      if (prompt) {
        promptInput.addEventListener('input', function () {
          var digits = promptInput.value.replace(/[^0-9]/g, '').slice(0, 4);
          if (digits !== promptInput.value) promptInput.value = digits;
        });

        // The focused input already keeps RevealJS off these keystrokes;
        // stopping them here keeps other plugins out of the way too.
        promptInput.addEventListener('keydown', function (event) {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            closePrompt(true);
          } else if (event.key === 'Escape' || event.key === 'Esc') {
            event.preventDefault();
            closePrompt(false);
          }
        });

        // Clicking away is a cancel.
        promptInput.addEventListener('blur', function () { closePrompt(false); });
      }

      // --- triggers -------------------------------------------------------
      var sawFullscreenApi = false;

      function inFullscreen() {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          sawFullscreenApi = true;
          return true;
        }
        // F11-style browser fullscreen (and the macOS green button) does not
        // set fullscreenElement, so fall back to "the window fills the screen".
        // Once the deck has used the fullscreen API, though, that API is the
        // authority - otherwise leaving fullscreen would go unnoticed on a
        // window that happens to be screen sized.
        if (sawFullscreenApi) return false;
        return !!window.screen &&
          window.innerHeight >= window.screen.height - 2 &&
          window.innerWidth >= window.screen.width - 2;
      }

      // Only act on actual transitions: the resize listener below fires for
      // plain window resizes too.
      var wasFullscreen = false;

      function onFullscreenChange() {
        var now = inFullscreen();
        if (now === wasFullscreen) return;
        wasFullscreen = now;

        if (now) {
          if (cfg.start === 'fullscreen') api.start();
        } else if (cfg.onExit === 'reset') {
          api.stop();
        } else if (cfg.onExit === 'pause') {
          api.pause();
        }
      }

      if (cfg.start === 'immediate') api.start();

      if (cfg.start === 'fullscreen' || cfg.onExit !== 'continue') {
        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange);
        window.addEventListener('resize', onFullscreenChange);
        wasFullscreen = inFullscreen();
        if (wasFullscreen && cfg.start === 'fullscreen') api.start();
      }

      if (cfg.keys.toggle || cfg.keys.reset || cfg.keys.set) {
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
          } else if (cfg.keys.set && event.key === cfg.keys.set) {
            event.preventDefault();
            openPrompt();
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
