// 音。ブレーキの「シャーッ」、ベルの「チリン」、転びそうなときの「ピッピッ」、Friend が跳ねるときの「ピピッ」、転んだときの「コテン」。
// 2026-09-25: ブレーキのシャーッとベルだけに（builder「音はブレーキとチリンのみで OK」。同日の試作の風・タイヤ・空転・SDK の効果音は外した）
// 2026-09-27: 「!」と一緒に鳴る音を追加（builder「危ない時びっくりと一緒に音」）→ 同日「もう少し高く。今の音は Friend が動くときに使えそう」で
//   高くし、前の音（1200 → 1800Hz）は Friend が跳ねるときの hop() に回した。
//   同日ブレーキを高い鳴き（キキーッ: 2750Hz の三角波 2 本＋揺れ）にしたが、builder「前に戻そう、違和感が大きくなった」で元のシャーッに戻した
// 2026-09-27: 転んだときの「コテン」を追加（builder「こけたときの音追加したい。コテン的なやつ」）: 木を叩いたような短い音を 2 つ、2 つ目を低く長く
// どれも WebAudio でコードから合成する（録音素材なし＝ライセンスの記載が要らない）。
// AudioContext はプレイヤーの操作（最初のキー・タップ）の中で unlock() して作る（自動再生の制限）。
// unlock できなくてもゲームは音なしで成立する。
const MASTER = 0.55;           // 全体の大きさ
const BRAKE_MAX = 0.06;        // ブレーキのシャーッ（速いほど大きい。6 m/s で満額）
const BRAKE_SOUND_ON = true;   // 2026-09-26 builder「一旦不要」→ 同日「やっぱりあった方がいい、戻して」
// 短い矩形波を 2 つ、上がり調子で（[Hz, 遅れ s]）。角を LOWPASS Hz で少し丸める
const DANGER_NOTES = [[1600, 0], [2400, 0.08]] as const; // 「!」（前は 1200 → 1800）
const DANGER_LEVEL = 0.06;
const DANGER_LOWPASS = 5000;
const HOP_NOTES = [[1200, 0], [1800, 0.08]] as const;    // Friend が跳ねる
const HOP_LEVEL = 0.045;
const HOP_LOWPASS = 3500;
// コテン: [始まりの Hz, 終わりの Hz, 遅れ s, 長さ s, 大きさ]。三角波の音程を すっと下げて短く減衰させる
const FALL_KNOCKS = [[900, 480, 0, 0.07, 0.22], [640, 300, 0.13, 0.18, 0.2]] as const;

export type RideSound = {
  /** プレイヤーの操作の中で呼ぶ。2回目以降は止まっていれば再開するだけ */
  unlock(): void;
  /** 毎フレーム。v = m/s、braking = ブレーキ中、active = 走っている（止め・メニュー・転倒中は false） */
  update(v: number, braking: boolean, active: boolean): void;
  bell(): void;
  /** 転びそうになった瞬間の「ピッピッ」 */
  danger(): void;
  /** Friend が跳ねるときの「ピピッ」 */
  hop(): void;
  /** 転んだときの「コテン」 */
  fall(): void;
  setMuted(muted: boolean): void;
  dispose(): void;
};

export function createRideSound(): RideSound {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null, brake: GainNode | null = null;
  let muted = false;

  const blips = (notes: readonly (readonly [number, number])[], level: number, lowpass: number) => {
    if (!ctx || !master || muted) return;
    const now = ctx.currentTime;
    const soften = ctx.createBiquadFilter(); soften.type = "lowpass"; soften.frequency.value = lowpass; soften.connect(master);
    for (const [freq, delay] of notes) {
      const osc = ctx.createOscillator(); osc.type = "square"; osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(level, now + delay + 0.004);
      gain.gain.setValueAtTime(level, now + delay + 0.05);
      gain.gain.linearRampToValueAtTime(0, now + delay + 0.065);
      osc.connect(gain); gain.connect(soften);
      osc.start(now + delay); osc.stop(now + delay + 0.08);
    }
  };

  return {
    unlock() {
      if (ctx) { if (ctx.state === "suspended") void ctx.resume(); return; }
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      try { ctx = new Context(); } catch { ctx = null; return; }
      const context = ctx;
      master = context.createGain(); master.gain.value = muted ? 0 : MASTER; master.connect(context.destination);
      // ブレーキ: 高い帯を通したノイズ（決定論的なノイズ。乱数は使わない方針に合わせる）
      const noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      const data = noise.getChannelData(0);
      let seed = 12345;
      for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; data[i] = seed / 2 ** 31 - 1; }
      const source = context.createBufferSource(); source.buffer = noise; source.loop = true;
      const filter = context.createBiquadFilter(); filter.type = "bandpass"; filter.frequency.value = 3400; filter.Q.value = 2;
      brake = context.createGain(); brake.gain.value = 0;
      source.connect(filter); filter.connect(brake); brake.connect(master);
      source.start();
      if (context.state === "suspended") void context.resume();
    },
    update(v, braking, active) {
      if (!ctx || !brake) return;
      const level = BRAKE_SOUND_ON && active && braking && v > 0.8 ? BRAKE_MAX * Math.min(1, v / 6) : 0;
      brake.gain.setTargetAtTime(level, ctx.currentTime, 0.03);
    },
    bell() {
      if (!ctx || !master || muted) return;
      // チリン: 2つの高い正弦波を2回、少しずらして減衰させる
      const now = ctx.currentTime;
      for (const [freq, delay, level] of [[2640, 0, 0.18], [3960, 0, 0.08], [2640, 0.16, 0.14], [3960, 0.16, 0.06]] as const) {
        const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = freq;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now + delay);
        gain.gain.linearRampToValueAtTime(level, now + delay + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.9);
        osc.connect(gain); gain.connect(master);
        osc.start(now + delay); osc.stop(now + delay + 1);
      }
    },
    danger() { blips(DANGER_NOTES, DANGER_LEVEL, DANGER_LOWPASS); },
    hop() { blips(HOP_NOTES, HOP_LEVEL, HOP_LOWPASS); },
    fall() {
      if (!ctx || !master || muted) return;
      const now = ctx.currentTime;
      for (const [from, to, delay, len, level] of FALL_KNOCKS) {
        const osc = ctx.createOscillator(); osc.type = "triangle";
        osc.frequency.setValueAtTime(from, now + delay);
        osc.frequency.exponentialRampToValueAtTime(to, now + delay + len);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now + delay);
        gain.gain.linearRampToValueAtTime(level, now + delay + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + len);
        osc.connect(gain); gain.connect(master);
        osc.start(now + delay); osc.stop(now + delay + len + 0.02);
      }
    },
    setMuted(value) {
      muted = value;
      if (ctx && master) master.gain.setTargetAtTime(value ? 0 : MASTER, ctx.currentTime, 0.02);
    },
    dispose() {
      void ctx?.close();
      ctx = null;
    },
  };
}
