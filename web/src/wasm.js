const width = 256;
const height = 240;

export async function loadCore() {
  const response = await fetch(new URL('./nes_wasm.wasm', import.meta.url));
  if (!response.ok) throw new Error(`Wasm request failed (HTTP ${response.status})`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  const api = instance.exports;

  function stage(bytes) {
    const address = api.input_buffer(bytes.byteLength);
    if (!address) throw new Error('ROM file is too large (maximum 8 MiB).');
    new Uint8Array(api.memory.buffer, address, bytes.byteLength).set(bytes);
  }

  return {
    prepare(bytes) {
      stage(bytes);
      if (!api.prepare_rom()) {
        const error = new Uint8Array(api.memory.buffer, api.error_ptr(), api.error_len());
        throw new Error(new TextDecoder().decode(error));
      }
      return api.candidate_battery_len();
    },
    restore(bytes, candidate = false) {
      stage(bytes);
      return Boolean(candidate ? api.restore_candidate_battery() : api.restore_live_battery());
    },
    activate: api.activate_rom,
    reset: api.reset,
    runFrame: api.run_frame,
    peekRam: api.debug_peek_ram,

    draw(context, image) {
      image.data.set(new Uint8Array(api.memory.buffer, api.frame_ptr(), width * height * 4));
      context.putImageData(image, 0, 0);
    },
    audio() {
      return new Float32Array(api.memory.buffer, api.audio_ptr(), api.audio_len());
    },
    saveRevision: api.battery_revision,
    saveBytes() {
      return new Uint8Array(api.memory.buffer, api.battery_ptr(), api.battery_len()).slice();
    },
  };
}
