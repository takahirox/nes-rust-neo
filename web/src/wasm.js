const width = 256;
const height = 240;

export async function loadCore() {
  const response = await fetch(new URL('./nes_wasm.wasm', import.meta.url));
  if (!response.ok) throw new Error(`Wasm request failed (HTTP ${response.status})`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  const api = instance.exports;

  function stage(bytes) {
    const address = api.input_buffer(bytes.byteLength);
    if (!address) throw new Error('Input exceeds the emulator staging capacity.');
    new Uint8Array(api.memory.buffer, address, bytes.byteLength).set(bytes);
  }

  function error() {
    const bytes = new Uint8Array(api.memory.buffer, api.error_ptr(), api.error_len());
    return new Error(new TextDecoder().decode(bytes));
  }

  return {
    inspect(bytes) {
      stage(bytes);
      const kind = api.stage_media();
      if (!kind) throw error();
      return kind - 1;
    },
    prepare(bios = new Uint8Array()) {
      stage(bios);
      if (!api.prepare_machine()) throw error();
      return api.candidate_save_len();
    },
    restore(bytes, candidate = false) {
      stage(bytes);
      return Boolean(candidate ? api.restore_candidate_save() : api.restore_live_save());
    },
    activate: api.activate_machine,
    discard: api.discard_candidate,
    diskSide: api.disk_side,
    selectDisk: api.select_disk,
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
    saveRevision: api.save_revision,
    saveBytes() {
      return new Uint8Array(api.memory.buffer, api.save_ptr(), api.save_len()).slice();
    },
  };
}
