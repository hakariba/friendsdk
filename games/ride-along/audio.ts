// 音。ブレーキの「シャーッ」、ベルの「チリン」、転びそうなときの「ピッピッ」、Friend が跳ねるときの「ピピッ」、転んだときの「コテン」、Friend の鼻歌（BGM の代わり）。
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

// ---- Friend の鼻歌（2026-09-28 builder「BGM を Friend の鼻歌にする」）----------------------------------
// BGM の代わりに、Friend が機嫌しだいで鼻歌を歌う。1 フレーズ歌ったら HUM_GAP 拍休む。
// 気分（mood）はゲームが毎フレーム渡す: rest = 黙る（止まっている・遅い・「!」・転倒・スタミナ切れ・メニュー）／walk = ふつう／fast = 速い（テンポと音程が上がる）／climb = 急な登り（ゆっくり低く）。
// rest になったらその場で フッと止め、rest 以外が HUM_WAIT 秒続いたら次のフレーズから歌いだす。
// 声: 三角波を低めのフィルタで丸め（ハミングらしく）、音と音はすべらせてつなぎ、伸ばす音だけビブラート
export type HumMood = "rest" | "walk" | "fast" | "climb";
const HUM_ON = true;
const HUM_LEVEL = 0.045;      // （0.05 → 0.045・2026-09-30 builder「音量 9 割に」）
const HUM_LOWPASS = 1100;      // Hz
const HUM_BASE = 523.25;       // Hz（ド = C5。音階の 0）
const HUM_WAIT = 1.2;          // s
const HUM_GAP = 20;            // 拍（8 分音符の数）（4 → 20・2026-09-30 builder「鼻歌、頻度下げよう」。歌っている割合 約 75% → 約 40%）
const HUM_GLIDE = 0.035;       // s  次の音へすべる時間
const HUM_VIBRATO = [5.5, 0.008] as const; // [Hz, 深さ（周波数の割合）]
// 気分ごとの [8 分音符の長さ s, 移調（半音）]
const HUM_STYLE: Readonly<Record<Exclude<HumMood, "rest">, readonly [number, number]>> = {
  walk: [0.24, 0], fast: [0.19, 5], climb: [0.34, -3],
};
// フレーズ: [音階（ド=0 の半音）, 長さ（8 分音符の数）]。null は休み。のんびりした 5 音音階の歌を 4 つ、順に回す
const HUM_PHRASES: readonly (readonly (readonly [number | null, number])[])[] = [
  [[4, 1], [7, 1], [9, 2], [7, 1], [4, 1], [2, 2], [0, 1], [2, 1], [4, 4]],
  [[4, 1], [7, 1], [9, 2], [12, 1], [9, 1], [7, 2], [4, 1], [7, 1], [9, 4]],
  [[9, 1], [12, 1], [14, 2], [12, 1], [9, 1], [7, 2], [null, 1], [4, 1], [7, 1], [9, 3]],
  [[7, 1], [4, 1], [2, 2], [4, 1], [2, 1], [0, 2], [null, 1], [2, 1], [4, 1], [0, 3]],
];
// 急な登りは息が続かない: 各フレーズの最初の半分だけ（途切れ途切れ）
const HUM_CLIMB_NOTES = 4;

export type RideSound = {
  /** プレイヤーの操作の中で呼ぶ。2回目以降は止まっていれば再開するだけ */
  unlock(): void;
  /** 毎フレーム。v = m/s、braking = ブレーキ中、active = 走っている（止め・メニュー・転倒中は false）、mood = 鼻歌の気分 */
  update(v: number, braking: boolean, active: boolean, mood?: HumMood): void;
  /** 鼻歌のフレーズを歌っている最中か（音が出ているときだけ true。ミュート・音がまだ有効でないときは false） */
  humming(): boolean;
  /** Friend の声の高さ（1 = 基準） */
  setVoice(ratio: number): void;
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
  // 鼻歌の状態: 歌っているフレーズ（止めるための音とゲイン・終わる時刻）、次に歌えるようになる時刻、何番目のフレーズか、声の高さ
  let phrase: { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode; endsAt: number } | null = null;
  let singSince = -1, nextPhraseAt = 0, phraseIndex = 0, voice = 1;

  const stopPhrase = () => {
    if (!ctx || !phrase) return;
    const now = ctx.currentTime;
    phrase.gain.gain.cancelScheduledValues(now);
    phrase.gain.gain.setTargetAtTime(0, now, 0.05);
    phrase.osc.stop(now + 0.4); phrase.lfo.stop(now + 0.4);
    phrase = null;
  };
  const startPhrase = (mood: Exclude<HumMood, "rest">) => {
    if (!ctx || !master) return;
    const [beat, shift] = HUM_STYLE[mood];
    const notes = HUM_PHRASES[phraseIndex % HUM_PHRASES.length];
    phraseIndex++;
    const sung = mood === "climb" ? notes.slice(0, HUM_CLIMB_NOTES) : notes;
    const start = ctx.currentTime + 0.05;
    const soften = ctx.createBiquadFilter(); soften.type = "lowpass"; soften.frequency.value = HUM_LOWPASS; soften.connect(master);
    const gain = ctx.createGain(); gain.gain.setValueAtTime(0, start); gain.connect(soften);
    const osc = ctx.createOscillator(); osc.type = "triangle";
    const lfo = ctx.createOscillator(); lfo.frequency.value = HUM_VIBRATO[0];
    const depth = ctx.createGain(); depth.gain.value = 0;
    lfo.connect(depth); depth.connect(osc.frequency); osc.connect(gain);
    let t = start, previous = 0;
    for (const [step, length] of sung) {
      const len = length * beat;
      if (step === null) {
        gain.gain.setTargetAtTime(0, t, 0.03);
      } else {
        const freq = HUM_BASE * voice * 2 ** ((step + shift) / 12);
        if (!previous) osc.frequency.setValueAtTime(freq, t);
        else { osc.frequency.setValueAtTime(previous, t); osc.frequency.exponentialRampToValueAtTime(freq, t + HUM_GLIDE); }
        previous = freq;
        // 音の頭で少しふくらみ、終わりに向けて少ししぼむ（音と音の区切り）
        gain.gain.setTargetAtTime(HUM_LEVEL, t, 0.025);
        gain.gain.setTargetAtTime(HUM_LEVEL * 0.6, t + len * 0.7, 0.04);
        // 伸ばす音（2 拍以上）だけ、後半にビブラート
        depth.gain.setValueAtTime(0, t);
        if (length >= 2) depth.gain.linearRampToValueAtTime(freq * HUM_VIBRATO[1], t + len * 0.9);
      }
      t += len;
    }
    gain.gain.setTargetAtTime(0, t - 0.05, 0.05);
    osc.start(start); lfo.start(start); osc.stop(t + 0.4); lfo.stop(t + 0.4);
    phrase = { osc, lfo, gain, endsAt: t };
    nextPhraseAt = t + HUM_GAP * beat;
  };

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
    update(v, braking, active, mood = "rest") {
      if (!ctx || !brake) return;
      const level = BRAKE_SOUND_ON && active && braking && v > 0.8 ? BRAKE_MAX * Math.min(1, v / 6) : 0;
      brake.gain.setTargetAtTime(level, ctx.currentTime, 0.03);
      // 鼻歌
      const now = ctx.currentTime;
      if (phrase && now > phrase.endsAt) phrase = null;
      if (!HUM_ON || mood === "rest" || muted || ctx.state !== "running") {
        stopPhrase(); singSince = -1;
        return;
      }
      if (singSince < 0) singSince = now;
      if (!phrase && now - singSince >= HUM_WAIT && now >= nextPhraseAt) startPhrase(mood);
    },
    humming() { return phrase !== null && !!ctx && ctx.currentTime <= phrase.endsAt; },
    setVoice(ratio) { voice = ratio; },
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
