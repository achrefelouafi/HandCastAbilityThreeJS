import { ELEMENTS, ELEMENT_META } from '../config/settings.js';
import { ELEMENT_SIGILS } from './glyphs.js';
import { CONTACT_MARKUP, ContactCard } from './contact.js';
import { CAMERA_MARKUP, CameraPanel } from './CameraPanel.js';
import { DRONE_DECK_MARKUP, DroneControls } from './DroneControls.js';

/**
 * Heads-up display: the ability bar, controls, live stats and toasts.
 *
 * Plain DOM — no framework. The bar is built from `ELEMENTS`, so a new ability
 * appears in it on its own; the slots are the only interactive part, and they
 * mirror the keyboard shortcuts through `onAbility`.
 *
 * The cooldown sweep is a `conic-gradient` driven by a CSS custom property, so
 * updating it every frame is one `setProperty` call and never touches layout.
 */
export class HUD {
  constructor(root) {
    this.root = root;
    this.onAbility = null;
    this._toastTimer = 0;
    this._statsAccumulator = 0;
    this._frames = 0;
    this._fps = 0;
    /** Last sweep ratio pushed to the DOM, per element. */
    this._cooldownShown = new Map();
    this._armedShown = null;

    root.innerHTML = `
      <div class="hud__panel hud__title">
        Elemental Sandbox
        <span data-blurb>Press Q, E, R, F, V, X, B, Z, N, K, L, Y or I, aim, click to cast. U deploys the drone.</span>
      </div>

      <div class="hud__panel hud__stats">
        <div>FPS <b data-stat="fps">—</b></div>
        <div>Particles <b data-stat="particles">0</b></div>
        <div>Instances <b data-stat="spikes">0</b></div>
        <div>Draw calls <b data-stat="calls">0</b></div>
      </div>

      <div class="hud__panel hud__help">
        <div><strong>Q</strong> — Volcanic Horror Ward &nbsp; <strong>E</strong> — Caustic Bloom</div>
        <div><strong>R</strong> — Arborist's Growth &nbsp; <strong>F</strong> — Cyber Serpent</div>
        <div><strong>V</strong> — Crystallized Venom Surge</div>
        <div><strong>X</strong> — Brutalist Earth Blast</div>
        <div><strong>B</strong> — Ink-paint Water Zone</div>
        <div><strong>Z</strong> — Astral Void Blast &nbsp; <strong>N</strong> — Baleful Cascade</div>
        <div><strong>K</strong> — Celestial Rend &nbsp; <strong>L</strong> — Shimmering Flux</div>
        <div><strong>Y</strong> — Scorched Twilight of Rage</div>
        <div><strong>U</strong> — Sentinel Drone (toggle)</div>
        <div class="hud__help-note">Q, E, R, B, Z, N and K are far casts — aimed with a circle, not an arrow.</div>
        <div class="hud__help-note">U is a summon: press to deploy, press again to recall. Fly it with the stick or WASD, hold Space or click to fire. Nothing else casts while it is up.</div>
        <div><strong>Move</strong> — aim &nbsp; <strong>Left click</strong> — cast</div>
        <div><strong>Esc / right click</strong> — cancel the cast</div>
        <div><strong>Right drag</strong> — orbit &nbsp; <strong>Scroll</strong> — zoom</div>
        <div style="margin-top:6px">
          <kbd>G</kbd> editor &nbsp; <kbd>P</kbd> pause &nbsp; <kbd>C</kbd> clear
        </div>
        <div><kbd>T</kbd> reset targets &nbsp; <kbd>H</kbd> hide this</div>
        <div><kbd>M</kbd> camera mode &nbsp; <kbd>J</kbd> swap hands</div>
        <div class="hud__help-note">Camera: palm aims, fist casts, point left/right to swap.</div>
        <div class="hud__help-note">Camera + drone: palm off centre flies it, fist holds fire, point to recall.</div>
        <div class="hud__help-note">Any cast that reaches a target one-shots it.</div>
        <div class="hud__help-note">The Chrono-Summon picks its own: it cuts them in half.</div>
        <div class="hud__help-note">The Sumi Tide picks its own too: it drags them under.</div>
        <div class="hud__help-note">So does the Baleful Cascade: it throws its own blades at them.</div>
        <div class="hud__help-note">Paused still applies every editor change.</div>
      </div>

      <div class="hud__abilities">
        ${ELEMENTS.map((element) => {
          const meta = ELEMENT_META[element];
          return `
            <div class="ability-card" data-element="${element}" style="--accent:${meta.accent}">
              <div class="ability-card__sweep" data-sweep></div>
              <div class="ability-card__key">${meta.key}</div>
              <div class="ability-card__glyph">${ELEMENT_SIGILS[element] ?? ''}</div>
              <div class="ability-card__label">${meta.label}</div>
            </div>`;
        }).join('')}
      </div>

      ${CONTACT_MARKUP}
      ${CAMERA_MARKUP}
      ${DRONE_DECK_MARKUP}

      <div class="hud__toast" data-toast></div>
      <div class="hud__paused" data-paused>Paused</div>
    `;

    this.contact = new ContactCard(root);
    this.camera = new CameraPanel(root);
    this.drone = new DroneControls(root);
    this.cards = new Map();
    for (const card of root.querySelectorAll('.ability-card')) {
      this.cards.set(card.dataset.element, card);
      card.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        this.onAbility?.(card.dataset.element);
      });
    }

    this.stats = {
      fps: root.querySelector('[data-stat="fps"]'),
      particles: root.querySelector('[data-stat="particles"]'),
      spikes: root.querySelector('[data-stat="spikes"]'),
      calls: root.querySelector('[data-stat="calls"]')
    };
    this.help = root.querySelector('.hud__help');
    this.toast = root.querySelector('[data-toast]');
    this.pausedBadge = root.querySelector('[data-paused]');
    this.abilityBar = root.querySelector('.hud__abilities');
  }

  /** @param {{silent?: boolean}} [options] */
  setElement(element, options = {}) {
    for (const [key, card] of this.cards) {
      card.classList.toggle('is-active', key === element);
    }
    const meta = ELEMENT_META[element];
    this.contact.setAccent(meta?.accent);
    if (meta && !options.silent) this.showToast(`${meta.hint} selected`);
  }

  /**
   * Mark a slot as *running* — a summon that is out. Distinct from armed: an
   * armed slot is waiting for a click, a deployed one is already doing
   * something and the press that put it out is the press that brings it back.
   */
  setDeployed(element, on) {
    const card = this.cards.get(element);
    if (card) card.classList.toggle('is-deployed', on);
    // The deck wants the bottom-left corner, which is where the help panel's
    // tail ends up on a short window; the help stands down while it is up.
    this.root.classList.toggle('hud--drone', on);
  }

  /** Highlight the slot while a cast is armed. */
  setArmed(armed) {
    if (armed === this._armedShown) return;
    this._armedShown = armed;
    this.abilityBar.classList.toggle('is-armed', armed);
  }

  /**
   * Drive one slot's cooldown sweep. Cooldowns are per ability, so this is
   * called once per element each frame.
   *
   * @param {string} element
   * @param {number} remaining seconds left
   * @param {number} total     the full cooldown, for the sweep angle
   */
  setCooldown(element, remaining, total) {
    const card = this.cards.get(element);
    if (!card) return;

    const ratio = Math.max(0, Math.min(1, remaining / Math.max(total, 0.001)));
    // Only touch the DOM when the sweep visibly moves.
    if (Math.abs(ratio - (this._cooldownShown.get(element) ?? -1)) < 0.01) return;
    this._cooldownShown.set(element, ratio);
    card.style.setProperty('--cooldown', ratio);
    card.classList.toggle('is-cooling', ratio > 0.001);
  }

  /**
   * Swap the bottom-right corner over to the camera readout.
   *
   * The contact card and the preview want the same corner, so this is a class
   * on the HUD root rather than two independent visibilities — there is never
   * a width at which both should be on screen.
   */
  setCameraVisible(on) {
    this.root.classList.toggle('hud--camera', on);
    this.camera.setVisible(on);
  }

  /** Play the contact card's entrance once the loading veil is clearing. */
  reveal() {
    this.contact.reveal();
  }

  setPaused(paused) {
    this.pausedBadge.classList.toggle('is-visible', paused);
  }

  toggleHelp() {
    this.help.classList.toggle('is-hidden');
  }

  showToast(message, duration = 1600) {
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.remove('is-visible'), duration);
  }

  /**
   * @param {number} dt
   * @param {() => {particles:number, spikes:number, calls:number}} collect
   *   Called only when the readout actually refreshes, so gathering the numbers
   *   (which means walking the particle pools) stays off the hot path.
   */
  update(dt, collect) {
    this._frames++;
    this._statsAccumulator += dt;
    if (this._statsAccumulator < 0.4) return;

    this._fps = Math.round(this._frames / this._statsAccumulator);
    this._frames = 0;
    this._statsAccumulator = 0;

    const info = collect();
    this.stats.fps.textContent = this._fps;
    this.stats.particles.textContent = info.particles;
    this.stats.spikes.textContent = info.spikes;
    this.stats.calls.textContent = info.calls;
  }
}

/** Boot screen helper. */
export class LoadingScreen {
  constructor() {
    this.element = document.getElementById('loader');
    this.fill = document.getElementById('loader-fill');
    this.status = document.getElementById('loader-status');
  }

  setProgress(ratio, message) {
    this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    if (message) this.status.textContent = message;
  }

  hide() {
    this.setProgress(1);
    setTimeout(() => this.element.classList.add('is-hidden'), 220);
  }

  fail(message) {
    this.status.textContent = message;
    this.status.style.color = '#ff7a6a';
  }
}
