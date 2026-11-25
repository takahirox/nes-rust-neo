const keys = new Map([
  ['KeyX', 1], ['KeyZ', 2], ['ShiftLeft', 4], ['ShiftRight', 4], ['Enter', 8],
  ['ArrowUp', 16], ['ArrowDown', 32], ['ArrowLeft', 64], ['ArrowRight', 128],
]);

export function controls(panel, enabled, gesture) {
  const keyboard = new Set();
  const pointers = new Map();
  const keyboardButtons = new Set();
  const buttons = [...panel.querySelectorAll('[data-pad]')];
  const dpad = panel.querySelector('#dpad');
  const blockedPads = new Set();

  function connectedPads() {
    try { return navigator.getGamepads?.() ?? []; }
    catch { return []; }
  }

  function clear() {
    keyboard.clear();
    pointers.clear();
    keyboardButtons.clear();
    for (const pad of connectedPads()) {
      if (pad) blockedPads.add(pad.index);
    }
    for (const button of buttons) button.removeAttribute('data-active');
  }
  window.addEventListener('blur', clear);
  window.addEventListener('gamepaddisconnected', event => blockedPads.delete(event.gamepad.index));
  window.addEventListener('keydown', event => {
    if (!enabled() || event.ctrlKey || event.altKey || event.metaKey ||
        event.target.closest?.('input, select, #help, #cartridge-picker') ||
        (event.code === 'Enter' && event.target.closest?.('button'))) return;
    if (keys.has(event.code)) {
      event.preventDefault();
      keyboard.add(event.code);
      if (!event.repeat) gesture();
    }
  });
  window.addEventListener('keyup', event => keyboard.delete(event.code));

  function direction(event) {
    const rect = dpad.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < -.15 || x > 1.15 || y < -.15 || y > 1.15) return 0;
    return (x < 1 / 3 ? 64 : x > 2 / 3 ? 128 : 0) | (y < 1 / 3 ? 16 : y > 2 / 3 ? 32 : 0);
  }
  function start(target, event, mask) {
    if (!enabled() || event.button !== 0) return;
    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, mask);
    gesture();
  }
  function release(event) { pointers.delete(event.pointerId); }
  panel.addEventListener('contextmenu', event => event.preventDefault());
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) panel.addEventListener(type, release);
  dpad.addEventListener('pointerdown', event => start(dpad, event, direction(event)));
  dpad.addEventListener('pointermove', event => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, direction(event));
  });
  for (const button of buttons) {
    const mask = Number(button.dataset.pad);
    button.disabled = true;
    if (!dpad.contains(button)) {
      button.addEventListener('pointerdown', event => start(button, event, mask));
    }
    button.addEventListener('keydown', event => {
      if (enabled() && (event.code === 'Space' || event.code === 'Enter')) {
        event.preventDefault();
        keyboardButtons.add(mask);
        if (!event.repeat) gesture();
      }
    });
    function releaseKey() { keyboardButtons.delete(mask); }
    button.addEventListener('keyup', releaseKey);
    button.addEventListener('blur', releaseKey);
  }

  function gamepad(pad) {
    const pressed = index => pad.buttons[index]?.pressed;
    const [x, y] = pad.axes;
    const bits = [pressed(1), pressed(0), pressed(8), pressed(9),
      pressed(12) || y < -.45, pressed(13) || y > .45,
      pressed(14) || x < -.45, pressed(15) || x > .45];
    const mask = bits.reduce((value, on, i) => on ? value | (1 << i) : value, 0);
    if (!mask) blockedPads.delete(pad.index);
    return blockedPads.has(pad.index) ? 0 : mask;
  }

  function clean(mask) {
    if ((mask & 0x30) === 0x30) mask &= ~0x30;
    if ((mask & 0xc0) === 0xc0) mask &= ~0xc0;
    return mask;
  }

  return {
    clear,
    setEnabled(value) {
      for (const button of buttons) button.disabled = !value;
    },
    sample() {
      let local = 0;
      for (const key of keyboard) local |= keys.get(key);
      for (const mask of pointers.values()) local |= mask;
      for (const mask of keyboardButtons) local |= mask;
      const pads = Array.from(connectedPads()).filter(pad => pad?.mapping === 'standard');
      const first = clean(local | (pads[0] ? gamepad(pads[0]) : 0));
      for (const button of buttons) button.toggleAttribute('data-active', Boolean(first & Number(button.dataset.pad)));
      return [first, pads[1] ? clean(gamepad(pads[1])) : 0];
    },
  };
}
