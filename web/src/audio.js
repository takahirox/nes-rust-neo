export class Sound {
  #context;
  #gain;
  #next = 0;
  #sources = new Set();
  #volume = 1;
  #muted = false;

  get muted() { return this.#muted; }
  get active() { return this.#context?.state === 'running'; }

  settings(volume, muted) {
    this.#volume = volume;
    this.#muted = muted;
    if (this.#gain) this.#gain.gain.value = muted ? 0 : volume;
    if (muted) this.clear();
  }

  async unlock() {
    if (!this.#context) {
      this.#context = new AudioContext({ latencyHint: 'interactive' });
      this.#gain = this.#context.createGain();
      this.#gain.connect(this.#context.destination);
      this.settings(this.#volume, this.#muted);
    }
    await this.#context.resume();
  }

  async resume() {
    if (this.#context) await this.#context.resume();
  }

  async suspend() {
    this.clear();
    if (this.#context) await this.#context.suspend();
  }

  clear() {
    for (const source of this.#sources) source.stop();
    this.#sources.clear();
    this.#next = 0;
  }

  queue(samples) {
    const context = this.#context;
    if (!this.active || this.#muted || !samples.length) return;
    const now = context.currentTime;
    if (this.#next > now + .10) return;
    if (this.#next < now) this.#next = now + .025;
    const buffer = context.createBuffer(1, samples.length, 48000);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gain);
    source.onended = () => { this.#sources.delete(source); source.disconnect(); };
    this.#sources.add(source);
    source.start(this.#next);
    this.#next += buffer.duration;
  }
}
