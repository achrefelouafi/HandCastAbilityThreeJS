import { Vector2 } from 'three';
import { EventEmitter } from '../utils/EventEmitter.js';

/**
 * Normalises pointer + keyboard input into a small event vocabulary.
 *
 * Events:
 *   `pointer:move` (ndc)          — every move, armed or not
 *   `pointer:confirm` (ndc)       — left click on the viewport
 *   `pointer:release` (ndc)       — the left button coming back up, anywhere.
 *                                   Nothing aimed needs it; the drone holds
 *                                   fire for as long as the button is down.
 *   `action` (name, slot)         — everything else, already named by intent.
 *                                   `ability` carries the 0-based slot index,
 *                                   which App maps through `ELEMENTS`.
 *
 * Pointer events that begin on top of DOM UI (the editor, the HUD) are ignored
 * so dragging a slider never fires the ability.
 */
export class InputManager extends EventEmitter {
  constructor(domElement) {
    super();
    this.dom = domElement;
    this.pointer = new Vector2(); // NDC
    this.keys = new Set();
    this.enabled = true;

    this._bind();
  }

  _bind() {
    this.dom.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this.dom.addEventListener('contextmenu', this._onContextMenu);
  }

  _onContextMenu = (event) => event.preventDefault();

  _updatePointer(event) {
    this.pointer.set(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
  }

  _onPointerDown = (event) => {
    if (!this.enabled) return;
    if (event.target !== this.dom) return; // started on UI

    this._updatePointer(event);

    if (event.button === 0) {
      this.emit('pointer:confirm', this.pointer);
    } else if (event.button === 2) {
      // Right button also orbits (OrbitControls owns the drag); putting an armed
      // cast away on the same press is the convention players expect. It says
      // which button it was, because the same action from Escape means more
      // to a drone than it does to an arrow.
      this.emit('action', 'cancel', 'pointer');
    }
  };

  _onPointerUp = (event) => {
    if (event.button !== 0) return;
    this._updatePointer(event);
    this.emit('pointer:release', this.pointer);
  };

  _onPointerMove = (event) => {
    this._updatePointer(event);
    this.emit('pointer:move', this.pointer);
  };

  _onKeyDown = (event) => {
    if (event.repeat) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    this.keys.add(event.code);

    switch (event.code) {
      // Ability slots. Keep these in step with `ELEMENTS` and
      // `ELEMENT_META[...].key`: the three line casts first, then the four
      // far casts, then the two summons — the Monowheel Bot, and the Sentinel
      // Drone last. The letter is the ability's; the digit is the slot's.
      case 'KeyQ':
      case 'Digit1':
        this.emit('action', 'ability', 0);
        break;
      case 'KeyE':
      case 'Digit2':
        this.emit('action', 'ability', 1);
        break;
      case 'KeyR':
      case 'Digit3':
        this.emit('action', 'ability', 2);
        break;
      case 'KeyX':
      case 'Digit4':
        this.emit('action', 'ability', 3);
        break;
      case 'KeyB':
      case 'Digit5':
        this.emit('action', 'ability', 4);
        break;
      case 'KeyZ':
      case 'Digit6':
        this.emit('action', 'ability', 5);
        break;
      case 'KeyF':
      case 'Digit7':
        this.emit('action', 'ability', 6);
        break;
      case 'KeyV':
      case 'Digit8':
        this.emit('action', 'ability', 7);
        break;
      case 'KeyY':
      case 'Digit9':
        this.emit('action', 'ability', 8);
        break;
      case 'Escape':
        this.emit('action', 'cancel');
        break;
      case 'KeyH':
        this.emit('action', 'toggleHelp');
        break;
      case 'KeyG':
        this.emit('action', 'toggleEditor');
        break;
      case 'KeyC':
        this.emit('action', 'clear');
        break;
      case 'KeyP':
        this.emit('action', 'togglePause');
        break;
      case 'KeyT':
        this.emit('action', 'resetDummies');
        break;
      case 'KeyM':
        this.emit('action', 'toggleCamera');
        break;
      case 'KeyJ':
        this.emit('action', 'swapHands');
        break;
      default:
        break;
    }
  };

  _onKeyUp = (event) => {
    this.keys.delete(event.code);
  };

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.dom.removeEventListener('contextmenu', this._onContextMenu);
    this.clear();
  }
}
