"use client";

// Ride Along — 操作プロトタイプの骨組み（2026-09-22 サブPCで作成・未実行）
// 物理の式と定数の根拠は同じフォルダの physics.md。数値は全部プレースホルダ。
// 範囲: SPEC 11章の優先度 1（操作）と 3（カゴの Friend）まで。
//       コイン・成長・ボーナス区間・音は入れていない。

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { createFriendReader, spriteFrame, GENERATION_SPRITE_MANIFEST, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import { GENERATION_ELIGIBILITY_ABI } from "@rarefriends/friendsdk/identity";
import { createPublicClient, http } from "viem";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";
import { createRideSound, type HumMood, type RideSound } from "./audio.js";

// 画面は 960×640。ただし描画は 192×128 の低解像度バッファに行い、整数5倍で引き伸ばす
// （SPEC 3章の決定）。台形もベジェも階段になり、Friend のドット粒度と世界が揃う。
// 内部解像度を変えるときは PIXEL_SCALE だけ触る（4 → 240×160 / 2 → 480×320）。
const SCREEN = { width: 960, height: 640 };
const PIXEL_SCALE = 5;
const VIEW = { width: SCREEN.width / PIXEL_SCALE, height: SCREEN.height / PIXEL_SCALE }; // 192×128
// runtime toolbar（左下ウォレット・右下メニュー）のぶん、画面下を空ける。
// **実 px で持つ**のが要点: canvas は container に合わせて縮むが toolbar は縮まないので、
// 内部座標に固定すると幅の狭い端末で toolbar がハンドルバーに重なる（420px 幅で実際に重なった）。
const TOOLBAR_DEVICE_PX = 34;
/** 表示中の canvas 高さから、内部座標で何px空ければよいかを求める。 */
function toolbarClearance(displayHeight: number) {
  if (!(displayHeight > 0)) return 12;
  return clamp(Math.ceil(TOOLBAR_DEVICE_PX * VIEW.height / displayHeight), 8, 40);
}

// ---- 物理定数（physics.md の表。触ったら作業ログに残す）------------------
const PEDAL_POWER = 0.35;     // m/s / 踏み（0.6 → 0.45 → 0.35・2026-09-23「もっとゆっくりスピードを上げたい」×2）
// ペダルが効く速さの上限（2026-09-25 builder「下り以外は Max 30km/h くらい・アベレージ 20〜25・登りは 15km/h くらいでさらにマイナス」）。
// 実車の「脚が回りきらない」: PEDAL_VMAX − PEDAL_KNEE を超えると、効きが PEDAL_TAIL ごとに約 1/e ずつ減る（0 にはならない）。
// 登りでは上限を勾配に比例して下げる（勾配 PEDAL_CLIMB_FULL 以上で PEDAL_VMAX_CLIMB）。30km/h を超える速さはほぼ下りの重力でしか出ない。
// 計算（ゆっくり 2 回/秒・リズム 3 回/秒・連打 7 回/秒）: 平地 24 / 29 / 30km/h、登り 4% 18 / 22 / 23、6% 14 / 17 / 19、9% 8 / 15 / 15
// 前は上限が無く、平地でも登りでも連打で約 37km/h 出て、下り（約 33km/h で頭打ち）と差が無かった。
// 2026-09-26: 上限の手前 6km/h で効きを直線で 0 にしていたのを、指数で減らす形に（builder「頭打ちになるんじゃなくて、かなり上昇が少なくなるように。
// ちょっと不自然」）。落ち着く速さはほぼ同じに合わせ、登りの上限は 20 → 18km/h
// 2026-09-26 builder「最高速をそれぞれ +3km/h」→ 同日「+2 にできる？」: 平地 32 → 34、登り 18 → 20（計算: リズム / 連打で 平地 31 / 32、9% 17 / 19）
const PEDAL_VMAX_FLAT = 36 / 3.6;  // m/s（34 → 36・2026-09-26 PEDAL_INV_FROM を入れて下がった最高速を戻すため）
const PEDAL_VMAX_CLIMB = 20 / 3.6; // m/s
const PEDAL_CLIMB_FULL = 0.07;
const PEDAL_KNEE = 4 / 3.6;        // m/s  上限のこれだけ手前から効きが減りはじめる
const PEDAL_TAIL = 3 / 3.6;        // m/s  これだけ速くなるごとに効きが約 1/e
// 1 踏みで増える速さは、PEDAL_INV_FROM より速いと速さに反比例して小さくなる（同じ仕事なら Δv ∝ 1/v・実車と同じ）。
// 2026-09-26 builder「速いときのペダル一押しで加速が大きい」→ 案 A。前は 20km/h 超で 1 踏み +1.0〜1.5km/h が一度に入り、速さによらず一定だった。
// 30km/h での一押し +1.3 → 約 +0.7km/h。16km/h 以下は変わらない。
// 計算（ゆっくり 2 / リズム 3 / 速め 5 / 連打 7 回/秒）: 平地 21 / 24 / 29.5 / 31、4% 16.5 / 22 / 24 / 24.5、9% 8 / 17 / 18 / 18
const PEDAL_INV_FROM = 16 / 3.6;   // m/s
// 上りだけペダルの力を上乗せ（2026-09-23 builder「登りがちょっときつすぎた。少しだけブースト」）。
// 勾配に比例し、勾配 0.07（長い登り）で 1 + CLIMB_BOOST 倍。短い登り（0.04）で約 1.11 倍。平地・下りは 1 倍
const CLIMB_BOOST = 0.4;      // 0.2 → 0.4・2026-09-24「登りのひとふみをもうちょい強く。揺れも大きいけど進む」
// 登りでは踏んだときの車体の振れ（PEDAL_ROLL）も大きくする＝立ち漕ぎ。勾配 0.07 で 1 + CLIMB_ROLL 倍（2026-09-24 追加）
const CLIMB_ROLL = 0.5;
// 下りで重力の加速をもらっている間（ブレーキを握っていないとき）は、揺れの元を弱める（2026-09-24 builder）。
// 弱めるのは ふらつき（NOISE）と 踏んだときの振れ（PEDAL_ROLL / PEDAL_ROLL_KICK）だけ。
// 倒れにくさ（安定度）そのものを上げると、まっすぐ戻る力が強くなって倒し込める量が減り、
// 下りの右急カーブの上限（約 33km/h）が約 30km/h に下がるので避けた
const DESCENT_CALM = 0.6;     // 勾配 DESCENT_FULL 以上の下りで、揺れの元をこの割合だけ減らす
const DESCENT_FULL = 0.07;
/** 下りの落ち着き具合の倍率（1 = そのまま）。ブレーキ中は 1 */
const descentCalm = (grade: number, braking: boolean) =>
  braking ? 1 : 1 - DESCENT_CALM * clamp(-grade / DESCENT_FULL, 0, 1);
const DRAG_LIN = 0.05;        // 1/s
const DRAG_SQ = 0.008;        // 1/m
// 30km/h を超えたぶんには、超えた量の2乗で抵抗を足す（2026-09-24 builder「30km/h 以上はだんだん抵抗がかかるように。下りで出すぎないように」）。
// 漕がない下り（-9% で約 28km/h で釣り合う）には効かない。連打したときの頭打ちは 平地 約 52 → 約 37km/h、-9% の下り 約 62 → 約 39km/h（計算）
// 下りでは空気抵抗（DRAG_LIN・DRAG_SQ の項）を弱める＝前かがみで風を切る扱い（2026-09-25 builder「下りのスピードが増える感がない」）。
// 前は -9% の下りを漕がずに下ると 12 → 25km/h で頭打ちになり、下りの途中から減速していた（抵抗が強すぎた・計算）。
// 0.5 倍で 12 → 32km/h まで上がり続ける（計算）。
// 勾配 DESCENT_FULL（0.07）以上で満額、緩い下りは比例。ブレーキ中は効かせない。OVER_V 超の抵抗（OVER_DRAG）は別で弱めない
const DESCENT_DRAG = 0.46;    // 0.5 → 0.44 → 0.46（2026-09-26「最高速 +3」→「+2」。漕がずに -7% 37 → 39、-8% 40 → 42、-10% 42 → 44km/h・計算）
// 30 → 40km/h（2026-09-25）。ペダルは 32km/h までしか効かなくなったので、これは下りだけの頭打ち。
// 漕がずに -7% で約 37km/h、-8% で約 40km/h（計算）。急カーブ（曲がれる上限 約 33km/h）の下りではブレーキが要る
const OVER_V = 42 / 3.6;      // m/s（40 → 43 → 42・2026-09-26）
const OVER_DRAG = 0.3;        // 1/m
const TURN_DRAG = 0.2;        // 1/(rad*s)  曲がる＝減速
const G_SLOPE = 9.8;          // m/s^2
const V_HALF = 2.0;           // m/s        安定度の半値速度
const K_RESTORE = 3.0;        // 1/s        まっすぐ戻る力（速度に比例して効く）
// ハンドルを離しているときは、まっすぐ戻る力（K_RESTORE の項）をこの倍率に弱める（2026-09-23 builder「離したときの戻る力を弱く」）。
// 押しているときは 1 倍のまま＝ハンドルの効きは変えない。
// （同日いったん逆に取って「離したときだけ戻りを足す」K_RELEASE = 2.0 を入れていた。削除済み）
const RELEASE_RESTORE = 0.75;
// 速いときは、離したときの戻りをさらに「ほぼ 0」へ（2026-09-23 builder「15km/h 以上でもっと弱く、0 に近くても」）。
// 本当に 0 にすると倒れる力（K_TOPPLE の項）が勝って速くてもじわじわ倒れるので、
// 「倒れる力と釣り合う＋RELEASE_NET だけ戻る」ところを 0 とみなす。
// RELEASE_FAST_FROM〜RELEASE_FAST_FULL で RELEASE_RESTORE からそこへ直線で移す
const RELEASE_FAST_FROM = 4.17; // m/s  15km/h
const RELEASE_FAST_FULL = 5.56; // m/s  20km/h
const RELEASE_NET = 0.2;      // 1/s  速いときに離したときの、正味の戻りの速さ
const K_TOPPLE = 3.8;         // 1/s        低速で倒れる力（3.0 → 3.8・2026-09-23）
const STEER_RATE = 0.5;       // rad/s      ハンドルの効き（0.6 → 0.5・2026-09-23「効きを少し弱く」）
// ちょい押しは微調整（2026-09-24 builder）。押し始めは STEER_TAP 倍、押し続けると STEER_RAMP 秒で 1 倍まで直線で上がる。
// 長押しの効きは STEER_RATE のまま。視界の傾き・ハンドルの見た目（steerView）も同じ強さに連動
const STEER_TAP = 0.35;
const STEER_RAMP = 0.35;      // s
const NOISE_AMP = 0.8;        // rad/s      低速のふらつき
// 10km/h 未満だけ、ふらつきを上乗せ（2026-09-26 builder「10km/h 未満のふらつき、もうちょっとだけ大きくても」）。
// LOW_WOBBLE_FROM で 0、LOW_WOBBLE_FULL 以下で +LOW_WOBBLE。倒れる力（K_TOPPLE）は変えない＝揺れだけ増える
const LOW_WOBBLE = 0.3;
const LOW_WOBBLE_FROM = 10 / 3.6, LOW_WOBBLE_FULL = 5 / 3.6; // m/s
// 登りだけ少し安定（2026-09-26 builder「最後の登りがちょいきつい。ほんの少し安定させて、登りだけでいい」）。
// 急な登りは 8〜15km/h で、上の LOW_WOBBLE（+30%）がまともに効いてきつくなった。ふらつきを 25% 減らす（+30% をほぼ打ち消す）＋倒れる力を 10% 減らす
const CLIMB_STEADY_FULL = 0.07; // この勾配以上で満額（緩い登りは比例）
// 同日 builder「そんなに減らさなくていい」→ 半分に（0.25 → 0.12、0.1 → 0.05）
const CLIMB_NOISE_CUT = 0.12;
const CLIMB_TOPPLE_CUT = 0.05;
const TURN_GAIN = 9.8;        // m/s^2      同じ傾きでの曲がりの鋭さ
const V_FLOOR = 2.5;          // m/s        これより遅いと、傾きが向きを変える量を速度に比例して弱める
                              // （1.0 で割るだけ → 2.5 で v 比例・2026-09-23。0km/h 発進で1踏みの傾きが向きを 45° 振り、道から外れていた）
const THETA_MAX = 0.38;       // rad        転倒する傾き（0.5=29度 → 0.38=22度・2026-09-23）
// 速いときだけ転倒の傾きを少し緩める（2026-09-23 追加）。低速側は THETA_MAX のまま。
// EASE_FROM 以下は +0、EASE_FULL 以上で +THETA_EASE、その間は直線。
const THETA_EASE = 0.06;      // rad        高速での上乗せ（約3.4度。0.38 → 0.44）
const EASE_FROM = 4.0;        // m/s        ここから緩め始める（約14km/h）
const EASE_FULL = 8.0;        // m/s        ここで上乗せ最大（約29km/h）
// 踏み込みの長さ（2026-09-23 追加）。低速では「押している間に力が入る」。
// 1踏みで出る力（PEDAL_POWER）は同じで、出し切るのに要る押し時間だけが速度で変わる。
// STROKE_SLOW_V 以下は STROKE_TIME、STROKE_FAST_V 以上は 0（押した瞬間に全部出る＝従来どおり）、その間は直線。
// 押し時間は**実時間**で計る（フレームの dt で積むと、粗いフレームで押し時間が水増しされ、
// 叩くだけで約4割出ていた・2026-09-23 実測）。
// 踏み始めの STROKE_DEAD の割合は力ゼロ。短く叩いても進まない（builder 要望・2026-09-23）。
const STROKE_TIME = 0.35;     // s          低速で1踏みを出し切るのに要る押し時間
const STROKE_SLOW_V = 4.4;    // m/s        ここ以下は STROKE_TIME まるごと（約16km/h。2.0 → 3.3 → 4.4）
const STROKE_FAST_V = 5.6;    // m/s        ここ以上は押し時間ゼロ（約20km/h。5.0 → 4.2 → 5.6）
const STROKE_DEAD = 0.3;      // 押し時間のうち最初のこの割合は力が出ない（0.35s なら 0.105s）
// スタミナ（2026-09-26 builder「スタミナ今機能してない。上限減らす？リズムよく押すことを促せるかも」）。
// 前（0.01 / 踏み・0.06 / s）は 6 回/秒まで減らず、連打でもほぼ減らなかった。
// 今は尽きずに漕げるのが 5 回/秒まで（= STAM_RECOVER / STAM_COST）。連打すると約 5 秒で尽き、力が STAM_FLOOR まで落ちる。
// 計算（平地の落ち着く速さ・回/秒）: 3 → 24、4 → 27、5 → 29、6 → 25、7 → 24km/h ＝ リズムよく 5 回/秒がいちばん速い。
// 登りは 1 踏みに 0.35 秒かかるので 3 回/秒も踏めず、減らない
// 2026-09-26 builder「3.5 回試していい？」→ 上限 5 → 3.5 回/秒（0.04 → 0.057）。計算: 3 / 3.5 / 5 / 7 回で 24 / 26 / 21 / 23km/h
const STAM_COST = 0.057;      // / 踏み（0.01 → 0.04 → 0.057。3.5 回/秒で確定・2026-09-26 builder）
const STAM_RECOVER = 0.2;     // 1/s（0.06 → 0.2）
const STAM_FLOOR = 0.4;       // 切らしても残る出力の割合
// スタミナ切れの合図（2026-09-26 builder「スタミナ切れ、点滅と Friend の焦りっぽい動きか応援」）: この値を下回ったら
// バーを点滅（reduced-motion では色だけ）、Friend が正面で左右に揺れながら跳ねて応援する（1 秒に 1.75 回＝漕ぐ上限 3.5 回/秒の半分）
const STAMINA_LOW = 0.2;
const CHEER_UP_RATE = 1.75;   // 回/s
const CHEER_UP_HOP = 3;       // 内部px
// Friend の能力（力・スタミナ・バランス）を固定する（2026-09-26 builder「一回固定で 1.1 に」＝少し強めの条件でベストを測って壁にする）。
// builder のベスト 2:03.1 はこの 1.1 で測った。2026-09-27 に Friend ごと（null・上の friendTraits）へ戻した
const FIXED_TRAITS: number | null = null;
const BRAKE_DECEL = 2.5;      // m/s^2      ブレーキの減速（2026-09-23 追加。暫定値）
// 発進（2026-09-23 追加。builder 案「0 から少しプラスの加速度でスタート／足をついていて安定、
// 3〜7km/h も高め、だんだん安定」）。それまでは約11km/h（v=3）からいきなり走っていた。
// - スタートと転倒からの再開は v=0・足をついた状態。倒れない。最初のペダルで足を離す
// - 足を離した直後 LAUNCH_PUSH 秒は、地面を蹴った分の加速 LAUNCH_ACCEL が乗る
// - 発進中は安定度を LAUNCH_STAB へ持ち上げる。持ち上げは LAUNCH_HOLD_V まで満額、
//   LAUNCH_END_V で 0（その速度の素の安定度 0.6 とつながる）。一度 LAUNCH_END_V に届いたら発進は終わり、
//   以降は低速でも素の式（遅いと倒れる）に戻る
const LAUNCH_ACCEL = 0.6;     // m/s^2      蹴り出しの加速
const LAUNCH_PUSH = 1.0;      // s          蹴り出しが効く時間（計 +0.6 m/s ≒ 2km/h）
const LAUNCH_STAB = 0.6;      // 発進中の安定度（素の式だと v=2 で 0.5、v=0.5 で 0.2。0.85 → 0.65 → 0.6・2026-09-23「LR押すだけでこけない」「もうちょっとだけ不安定でも」）
// 踏み込みで車体が踏んだ側へ振れる（2026-09-23 追加）。ペダルを踏むだけではまっすぐ走れず、
// ハンドルで立て直す必要を作る。(1 - 素の安定度) を掛けるので低速ほど強く、速いと弱い。
const PEDAL_ROLL = 0.6;       // rad/s  踏み込み中に θ を踏んだ側へ動かす速さ（低速の押し込み）
const PEDAL_ROLL_KICK = 0.08; // rad    速くて押した瞬間に全部出るときの1踏みぶんの振れ
const LAUNCH_HOLD_V = 2.0;    // m/s        ここまでは満額（約7km/h）
const LAUNCH_END_V = 3.0;     // m/s        ここで持ち上げ 0・発進終わり（約11km/h）
const HALF_WIDTH = 3.0;       // m          道幅の半分
const GRASS_DRAG = 4.0;       // コース外に出たときに DRAG_LIN にかける倍率（即転倒にしない）

// ---- 描画定数 -------------------------------------------------------------
const HORIZON_Y = 50;         // 地平線の内部Y（画面上では 250px）
const CAM_DEPTH = 0.9;        // 投影の強さ（視野の狭さ）
// 坂を見やすく（2026-09-24 builder「下りと登りが視覚的に分かるように」）。描くときだけ高低差を SLOPE_VIEW 倍にする。
// 目線は水平なので、登りは道の先が遠景の地平線より上へ、下りは下へ来る。その差が 7% の登りでも画面の約4%しかなかった。
// 物理・高度表示は変えない
const SLOPE_VIEW = 2.0;
// 前後傾は勾配に連動（2026-09-24 夜 builder「加減速ではなく上り・下りに使う」。前は加速度に連動していた）。
// 登りは車体が後ろへ傾いて視線が上がる（景色が下がる・空が見える）、下りは前へ傾いて視線が下がる（景色が上がる）。
// 勾配は climbView（0.8 秒でなまらせたもの）。下りは本物の傾き（焦点距離 約86px × 勾配）の約1.4倍: 9% で 10.8px。
// 登りは半分（2026-09-24 builder「最後の登り 空見えすぎ」。120 → 60）: 7% で 4.2px
const PITCH_PER_GRADE_UP = 60;    // 内部px / 勾配
const PITCH_PER_GRADE_DOWN = 120; // 内部px / 勾配
const PITCH_MAX = 12;         // 内部px（画面 60px）
const CAM_HEIGHT = 1.2;       // m  目線の高さ（1.35 → 1.05 → 1.2・2026-09-24。画面上の流れは 速度÷目線の高さ に比例する。km/h と物理は変えない）
const DRAW_DISTANCE = 140;    // m  描画する前方距離
const SEGMENT_COUNT = 70;
const ROLL_VIEW = 0.85;       // 車体のロールを視界の回転にどれだけ反映するか（0.55 → 0.85・2026-09-23）
const HEAD_SWAY = 10;         // 内部px/rad  傾いたとき頭が車体の上で横に動く量（2026-09-23 追加）
const BAR_SWING = 26;         // 内部px/rad  ハンドルバーが左右に振れる量（2026-09-23 追加）
const BAR_TWIST = 0.5;        // ハンドルバー自体の回転を θ の何倍にするか（2026-09-23 追加）
const TWIST_DRAW_MAX = 0.22;  // rad  バーの回転の描画上限。baseY の余白はこれで決まる（2026-09-23 追加）
// ハンドル操作の見せ方（2026-09-23 追加。builder「カーブで傾いている感じが薄い・景色が回らない」）。どちらも見た目だけ。
// ◀/▶ を押している量（STEER_LAG 秒でなまらせた -1..1 = steerView）に連動させる。
// 最初はコースの曲率に連動させたが「カーブに入った瞬間に何も押さなくても視界が回る」のが微妙（builder）で、操作に付け替えた。
// - 傾き: 視界の回転に steerView × STEER_ROLL を足す（車体の θ 全体を大きく見せると低速のふらつきまで大きくなるので、操作の分だけ）
// - 視線: 曲がる側を steerView × STEER_LOOK だけ見る。景色全体が反対へ流れる
// - ハンドル: 曲がる側のグリップが手前へ（外へ広がって大きく）、反対が奥へ（上がって内へ寄る）。STEER_BAR_*
const STEER_LAG = 0.3;        // s  押したときも離したときも（離したときだけ 0.15 に速めたのは取り違えだったので戻した・2026-09-23）
const STEER_ROLL = 0.12;      // rad（約7度）
const STEER_LOOK = 0.15;      // rad
const STEER_BAR_UP = 9;       // 内部px  奥へ行くグリップが上がる量（6 → 9・2026-09-23「もうちょい大きく」）
const STEER_BAR_IN = 8;       // 内部px  奥へ行くグリップが内へ寄る量（手前のグリップはその分 外へ。5 → 8）
const STEER_BAR_GROW = 3;     // 内部px  手前に来るグリップが大きくなる量（2 → 3）
// 車体の向きのずれ psi は「視線の回転」として、地面も遠景も同じ px だけ横にずらす（2026-09-23）。
// それまでは地面だけ「手前ほど大きく・奥は動かない」ずらし方（×1.3）で、これは道が曲がって見えるのと同じ見え方になる。
// カーブを抜けても車体が曲がり続けている間、道がまだカーブしているように見えていた（builder「カーブ終わってもカーブしてる気がする」）
const PSI_LOOK = 0.6;         // psi のうち視線の回転に入れる割合（1.0 が実物どおり）
// ペダルの揺れ（2026-09-23 追加）。踏むたびに rock をばねで揺らし、視点とハンドルに乗せる。
// rock は無次元で、1踏みのピークがおおよそ ±0.6。
const ROCK_KICK = 9;          // 1/s     1踏みで rock の速度に足す量
const ROCK_SPRING = 81;       // 1/s^2   戻る力（固有角振動数 9 rad/s ≒ 1.4 回/秒）
const ROCK_DAMP = 8;          // 1/s     減衰
const CAM_ROCK = 7;           // 内部px  rock=1 のときの視点の横移動（4 → 7・2026-09-23）
const ROCK_PUSH = 1.4;        // 踏み込み中に rock が寄っていく先（踏み込みの進みに比例。0.8 → 1.4・2026-09-23）
// 画面の揺れ（ペダルの rock）の強さを場面で変える（2026-09-23 追加）。
// 速いとき: 30km/h 超でぐらつきを減らす。SHAKE_FAST_FROM〜SHAKE_FAST_FULL で 1 → SHAKE_FAST_MIN
// 上り: 勾配に比例して増やす。勾配 0.07（長い登り）で 1 + SHAKE_CLIMB
const SHAKE_FAST_FROM = 7.5;  // m/s  約27km/h
const SHAKE_FAST_FULL = 9.5;  // m/s  約34km/h
const SHAKE_FAST_MIN = 0.4;
const SHAKE_CLIMB = 0.8;      // 勾配 0.07 のときの上乗せ（1.8倍）
const shakeGain = (v: number, climb: number) =>
  (1 - (1 - SHAKE_FAST_MIN) * clamp((v - SHAKE_FAST_FROM) / (SHAKE_FAST_FULL - SHAKE_FAST_FROM), 0, 1))
  * (1 + SHAKE_CLIMB * Math.max(0, climb) / 0.07);
const BAR_YAW = 5;            // 内部px  rock=1 のときグリップが前後する見かけの上下量（3 → 5・2026-09-23）

// ---- コース（SPEC 10章の構成。s の区間テーブル）---------------------------
type Segment = { length: number; curvature: number; grade: number; label: string };
// 2026-09-25 作り直し（builder 案＋相談。07_tmp/相談_コース作り直し_2026-09-25.md の v2）:
// 慣れる → ちょい下り → ちょい上り → **ブレーキの下り**（急な切り返し）→ 谷底の橋 → 登りの山場 → 頂上 → **爽快な下り**（途中でゴール、そのまま転がって麓で止まる）。
// 「ブレーキを使う下り」と「爽快な下り」を分けた（builder）。前のコースは登りの途中でゴールしていた
const COURSE: readonly Segment[] = [
  // 最初の 2 区間は元の 8 割に（100 → 80、80 → 64・2026-09-26 builder。いったん 9 割にしたが「まだ間延びする」）。曲がる角度は同じ
  { length: 80, curvature: 0, grade: 0, label: "Riverside flat" },
  { length: 64, curvature: -0.008 * 80 / 64, grade: -0.03, label: "Easy downhill" },
  { length: 60, curvature: 0, grade: 0.03, label: "Gentle rise" },
  { length: 70, curvature: 0.012, grade: 0.04, label: "Rising right" },
  // ブレーキの下り。-7% を漕がずに下ると約 37km/h まで上がるが、ヘアピンは曲がれる上限が約 29km/h＝握らないと曲がれない。
  // 曲率 0.034 / -0.036 → 0.046 / -0.048（2026-09-25 builder「ヘアピンはもうちょい角度きつく」。50m で約 130° 曲がる）
  { length: 50, curvature: 0.004, grade: -0.07, label: "Steep descent" },
  { length: 50, curvature: 0.046, grade: -0.07, label: "Hairpin right" },
  { length: 50, curvature: -0.048, grade: -0.06, label: "Hairpin left" },
  { length: 40, curvature: 0, grade: 0, label: "River bridge" },
  // 最後の登りは前半を緩く・後半を急に（2026-09-25 builder。前は +8% のカーブ → +6% の直進）。
  // 後半を +10% にすると、ゆっくり漕ぐ人（2 回/秒）が約 5km/h まで落ちてふらつく（計算）ので +9%（同 約 8km/h、リズムよく漕げば 15km/h で頭打ち）
  { length: 100, curvature: -0.012, grade: 0.04, label: "Gentle climb" },
  { length: 90, curvature: 0, grade: 0.09, label: "Steep finish" },
  { length: 40, curvature: 0, grade: 0, label: "Summit" },
  // 爽快な下り。緩いカーブだけで握らずに行ける。-7% だとゴールまでに約 33km/h しか出なかったので -10% / -8% に（計算でゴール付近が最速 約 39km/h）。
  // Sweeping left の終わりでゴール、あとは自動で麓まで転がる
  { length: 100, curvature: 0.005, grade: -0.10, label: "Long descent" },
  { length: 90, curvature: -0.008, grade: -0.08, label: "Sweeping left" },
  { length: 80, curvature: 0.003, grade: -0.05, label: "Home straight" },
  { length: 70, curvature: 0, grade: 0, label: "Valley" },
];
const COURSE_LENGTH = COURSE.reduce((total, segment) => total + segment.length, 0);
/** 名前の区間が始まる距離（m） */
function segmentStart(label: string): number {
  let at = 0;
  for (const segment of COURSE) { if (segment.label === label) return at; at += segment.length; }
  throw new Error(`No segment ${label}`);
}

function segmentAt(s: number): Segment {
  let remaining = Math.max(0, Math.min(s, COURSE_LENGTH - 0.001));
  for (const segment of COURSE) {
    if (remaining < segment.length) return segment;
    remaining -= segment.length;
  }
  return COURSE[COURSE.length - 1];
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
/** s 地点の区間の番号（COURSE の添字） */
function segmentIndexAt(s: number): number {
  let remaining = Math.max(0, Math.min(s, COURSE_LENGTH - 0.001));
  for (let index = 0; index < COURSE.length; index++) {
    if (remaining < COURSE[index].length) return index;
    remaining -= COURSE[index].length;
  }
  return COURSE.length - 1;
}
/** いまの速度で1踏みを出し切るのに要る押し時間（秒）。 */
const strokeTime = (v: number) =>
  STROKE_TIME * clamp((STROKE_FAST_V - v) / (STROKE_FAST_V - STROKE_SLOW_V), 0, 1);
// 乱数を使わない。転倒を再現して検証できるようにするため（physics.md 3章）。
const wobble = (t: number) => 0.6 * Math.sin(1.7 * t) + 0.4 * Math.sin(2.9 * t + 1.3);

// ---- 景色（2026-09-23 作り直し）--------------------------------------------
// 方針: **描くものは全部、地面（コース上の距離 s）か方位に固定する。**
// それまでの縞・白線・木はカメラからの距離で決まっていたので、走っても模様が流れず、
// 11km/h でも止まって見えていた。「速度演出」を足すのではなく、固定先を直すだけで速度が見える。
const BAND = DRAW_DISTANCE / SEGMENT_COUNT; // m  地面の縞1本の長さ（= 2m）
const BG_PX_PER_RAD = 150;    // 内部px/rad  遠景（山・雲・太陽）が向きの変化で横に流れる量
const BG_PERIOD = 2 * Math.PI * BG_PX_PER_RAD; // 遠景は一周で元に戻る
// 遠景は頭の横移動（HEAD_SWAY・CAM_ROCK）に乗せない。無限遠のものは頭が動いても動かない（2026-09-23）。
// psi（ふらつきの向き）は、地面側の投影では地平線で 0 になる形なので、遠景に満額入れると
// 道の消失点と山がずれて滑って見える。なまらせて弱めに入れる（2026-09-23 まで 1.0・なまし無し）。
// 遠景のロールは地面より弱くする。回転の中心も地平線の真ん中に置く（前は画面の 0.62 の高さが中心で、
// 地平線から 36px 上の太陽は傾きのたびに大きく弧を描いていた）。地面との間は丘の裾を地平線の下まで伸ばして埋める
const BG_ROLL = 0.5;          // 遠景の回転を視界の回転の何倍にするか（2026-09-23 追加。前は実質 1.0）
const BG_PSI_LAG = 0.3;       // s  psi をなまらせる時定数（0.6 → 0.3。地面にも使うようになったので遅れを短く）
// 太陽の方位（rad）は、頂上で向いている方角の少し右（前のコースでは -0.59 rad に対して -0.45）。コースの形から計算する（headingAt の定義のあと）
// 見晴らし（夕焼け・遠くの山と湖）は高度ではなく距離で開く（2026-09-25 コース作り直し）。
// 高度だと序盤の登り（約 2m）でも夕焼けが始まってしまうため。最後の登りの入口から開き始め、頂上で全開、そのあとは開いたまま
const VISTA_FROM = segmentStart("Gentle climb"); // m（距離）
const VISTA_FULL = segmentStart("Summit");       // m（距離）

/** 決定論的な 0..1。乱数を使わないのは物理と同じ理由（再現できるように）。 */
const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const smooth = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
// 区間のつなぎ目の曲率は CURVE_EASE の長さをかけて直線で移す（2026-09-23 追加）。
// それまでは1点で切り替わり、右急カーブ → 左の切り返しで、遠景の流れる向きと必要な傾きが瞬間的に反転していた。
// 移す区間は**きつい方のカーブの内側**に置く（入口はつなぎ目から曲がり始め、出口はつなぎ目で曲がり終わる）。
// 最初はつなぎ目を中心に置いていて、カーブが区間の終わりから 10m 先まで続き、
// 「カーブが終わったと思って起こすと右へ流れる」原因の1つになっていた（2026-09-23 builder）。左右の切り返しだけは中心に置く。
// 物理・地面の描画・遠景の向きは全部 curvatureAt / headingAt を通す（どれかだけ直すと互いにずれる）。
const CURVE_EASE = 12;        // m（20 → 12・2026-09-23）
const SEGMENT_STARTS = COURSE.map((_, index) => COURSE.slice(0, index).reduce((total, segment) => total + segment.length, 0));
/** s 地点の曲率（1/m）。つなぎ目の前後で隣の区間と直線で混ぜる。 */
function curvatureAt(s: number): number {
  const at = clamp(s, 0, COURSE_LENGTH);
  for (let index = 1; index < COURSE.length; index++) {
    const before = COURSE[index - 1].curvature, after = COURSE[index].curvature;
    if (before === after) continue;
    const boundary = SEGMENT_STARTS[index];
    const flips = before * after < 0;
    // 移す区間の始まり: 切り返しは中心、入口（after の方がきつい）はつなぎ目から、出口はつなぎ目の手前で終わる
    const start = flips ? boundary - CURVE_EASE / 2
      : Math.abs(after) > Math.abs(before) ? boundary : boundary - CURVE_EASE;
    if (at >= start && at < start + CURVE_EASE) return before + (after - before) * (at - start) / CURVE_EASE;
  }
  return segmentAt(at).curvature;
}
/** コースの向き（rad）。s までの curvatureAt の積分（1m 刻みの中点則）。遠景を横に流すのに使う。 */
function headingAt(s: number): number {
  const end = clamp(s, 0, COURSE_LENGTH);
  let heading = 0, at = 0;
  for (; at + 1 <= end; at += 1) heading += curvatureAt(at + 0.5);
  return heading + curvatureAt((at + end) / 2) * (end - at);
}
// 区間のつなぎ目の勾配は GRADE_EASE の長さをかけて直線で移す（2026-09-24 builder「登りと平坦の切り替えが急。なだらかに」）。
// それまでは1点で切り替わり、道に角ができて（SLOPE_VIEW で2倍に見える）、減速・前後傾も一瞬で変わっていた。
// 移す区間はつなぎ目を中心に置く（前後で高度が釣り合うので、区間の外の高度は前と同じ）。
// 物理・地面の描画・高度・前後傾は全部 gradeAt を通す（どれかだけ直すと、見えている坂と効いている坂がずれる）。
const GRADE_EASE = 30;        // m  短い区間（55m）でも両側の移しが重ならない長さ
/** s 地点の勾配。つなぎ目の前後で隣の区間と直線で混ぜる。 */
function gradeAt(s: number): number {
  const at = clamp(s, 0, COURSE_LENGTH);
  for (let index = 1; index < COURSE.length; index++) {
    const before = COURSE[index - 1].grade, after = COURSE[index].grade;
    if (before === after) continue;
    const start = SEGMENT_STARTS[index] - GRADE_EASE / 2;
    if (at >= start && at < start + GRADE_EASE) return before + (after - before) * (at - start) / GRADE_EASE;
  }
  return segmentAt(at).grade;
}
const SUN_AZIMUTH = headingAt(segmentStart("Summit")) + 0.14;
const wrap = (x: number, period: number) => ((x % period) + period) % period;

// 空はディザで段階を付けて1度だけ描いておく（毎フレーム 2.6万ピクセルを塗らないため）
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const SKY_W = VIEW.width + 80, SKY_H = HORIZON_Y + 48; // 回転で隅が欠けないよう広めに
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
let skyCache: { day: HTMLCanvasElement; dusk: HTMLCanvasElement } | null = null;
function ditheredSky(stops: string[]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SKY_W; canvas.height = SKY_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const colors = stops.map(rgb);
  const image = ctx.createImageData(SKY_W, SKY_H);
  for (let y = 0; y < SKY_H; y++) {
    const f = (y / (SKY_H - 1)) * (colors.length - 1);
    const lo = Math.min(Math.floor(f), colors.length - 2);
    // 段は 5 段ずつ。段の境目だけをディザで混ぜる（全面ディザだとざらつきすぎた）
    const steps = 5, g = (f - lo) * steps, band = Math.floor(g), frac = g - band;
    for (let x = 0; x < SKY_W; x++) {
      const k = band + (frac > (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 ? 1 : 0);
      const t = Math.min(k / steps, 1);
      const o = (y * SKY_W + x) * 4;
      for (let c = 0; c < 3; c++) image.data[o + c] = Math.round(colors[lo][c] + (colors[lo + 1][c] - colors[lo][c]) * t);
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
function skies() {
  skyCache ??= {
    day: ditheredSky(["#5f98cf", "#8fbfe0", "#cfe4ec"]),
    dusk: ditheredSky(["#5d6fb8", "#d99a8c", "#f2b393"]), // 地平線近くを赤寄りに（#f5d29a → #f2b393・2026-09-25 builder「ベージュを赤っぽく」）
  };
  return skyCache;
}

/** 山並みの高さ（内部px）。周期 BG_PERIOD で必ずつながる整数周波数の和。 */
function ridge(xw: number, seed: number, harmonics: readonly (readonly [number, number])[]) {
  let h = 0;
  for (const [k, amp] of harmonics) h += amp * Math.sin((k * 2 * Math.PI * xw) / BG_PERIOD + seed * k);
  return h;
}
const FAR_RANGE = [[3, 4], [7, 3], [13, 2], [29, 1]] as const;
const NEAR_HILLS = [[2, 3], [5, 2.5], [11, 1.2], [23, 0.6]] as const;

/** dz は道のり（m）、forward は前方への実際の距離（m）。急カーブでは forward < dz になる */
type GroundPoint = Projected & { dz: number; world: number; offsetX: number; offsetY: number; forward: number };
type Prop = { dz: number; paint: () => void };

// ---- Friend の個性（2026-09-27 builder「それぞれに長所と短所がある方がいい。バランスとパワー？高い Friend はちょっとだけいい数値」）
// 種族でタイプを決める（パワー型: 力 +TYPE_TILT・バランス −TYPE_TILT／バランス型: その逆／万能型: ±0）。振り分けは Claude の案
// 個体（friendId）で ±INDIVIDUAL_SPREAD のばらつき（力とバランスの配分がずれる）。
// 世代が若い（＝高い）ほど両方に少し上乗せ（GEN_BONUS。Gen-1 +0.04・Gen-2 +0.02・それ以降と読めないときは 0）。スタミナは全員 1
// 前（〜2026-09-26）は friendId だけから 3 つを 0.8〜1.2 に配分していた（種族と関係なく、差が見えなかった）
type FriendType = "power" | "balance" | "allround";
const FAMILY_TYPE: Readonly<Record<string, FriendType>> = {
  Skeleton: "power", Colossus: "power", Mask: "power",
  Hoverer: "balance", Sparkling: "balance", Hollow: "balance",
  Family: "allround", Cellular: "allround", Asymmetry: "allround",
};
const TYPE_LABEL: Readonly<Record<FriendType, string>> = { power: "Power type", balance: "Balance type", allround: "All-round type" };
const TYPE_TILT = 0.08;
const INDIVIDUAL_SPREAD = 0.03;
const GEN_BONUS: Readonly<Record<number, number>> = { 1: 0.04, 2: 0.02 };
type Traits = { type: FriendType; power: number; balance: number; stamina: number };
// 試走用に能力を固定する（null = Friend ごと）。2026-09-27 builder「パワー最小に固定して試す」で
// 力が一番弱い Friend（バランス型・個体差が力の側に最大・世代の上乗せなし＝力 0.89・バランス 1.11）にして試走 → 走れたので同日 null に戻した
const TEST_TRAITS: Traits | null = null;

/** friendId（bigint）から決定論的に 0..1（splitmix64） */
function friendHash(friendId: bigint): number {
  const mask = (1n << 64n) - 1n;
  let z = ((friendId ^ 0x9e3779b97f4a7c15n) + 0x9e3779b97f4a7c15n) & mask;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
  z = z ^ (z >> 31n);
  return Number(z & 0xffffffn) / 0x1000000;
}
function friendTraits(friendId: bigint, familyName: string, generation: number | null): Traits {
  const type = FAMILY_TYPE[familyName] ?? "allround";
  const tilt = type === "power" ? TYPE_TILT : type === "balance" ? -TYPE_TILT : 0;
  const spread = (friendHash(friendId) * 2 - 1) * INDIVIDUAL_SPREAD;
  const bonus = generation === null ? 0 : GEN_BONUS[generation] ?? 0;
  return { type, power: 1 + tilt + spread + bonus, balance: 1 - tilt - spread + bonus, stamina: 1 };
}
/** 選んだ Friend の世代（Generations コントラクトの generation(tokenId)）。公開の読み取りだけ（SDK が絵を読むのと同じ RPC）。読めなければ null */
async function readGeneration(friendId: bigint): Promise<number | null> {
  try {
    const client = createPublicClient({ transport: http(GENERATION_SPRITE_MANIFEST.rpcUrl, { retryCount: 1, timeout: 8_000 }) });
    const generation = await client.readContract({ address: GENERATION_SPRITE_MANIFEST.generations, abi: GENERATION_ELIGIBILITY_ABI,
      functionName: "generation", args: [friendId] });
    return Number(generation);
  } catch { return null; }
}

type Ride = {
  s: number; x: number; psi: number; theta: number; v: number;
  altitude: number; stamina: number; expect: "L" | "R";
  time: number; falling: number; falls: number; missed: number;
  rock: number; rockVel: number;
  /**
   * 踏み込み中のペダル（null = 踏んでいない）と、出し切った力の割合 0..1。
   * 踏み切っても（strokeDone = 1）反対を踏むまでは stroke を残す。
   * ボタンを一番濃いまま止め、反対側を光らせて「踏み替えどき」を見せるため。
   */
  stroke: "L" | "R" | null; strokeStart: number; strokeDone: number;
  /** 足をついて止まっている（スタート・転倒後）。最初のペダルで false */
  footDown: boolean;
  /** 発進中（LAUNCH_END_V に届くまで）と、蹴り出しの残り時間（s） */
  launching: boolean; pushLeft: number;
  /** 遠景用に なまらせた psi（ふらつきで空や山が振れないように） */
  psiView: number;
  /** 画面の揺れに使う、なまらせた勾配（区間の切り替わりで揺れが段になって変わらないように） */
  climbView: number;
  /** ◀/▶ の押し具合を なまらせた値（-1..1）。上の STEER_* */
  steerView: number;
  /** いま押しているハンドルの向き（-1/0/1）と、同じ向きを押し続けている時間（s） */
  steerDir: number; steerHold: number;
  /** 走った時間（最初に踏んでから頂上まで。s）・最高速度（m/s）・頂上に着いたか（2026-09-24 ゴール追加） */
  clock: number; topSpeed: number; finished: boolean;
  /** 頂上に着いた時刻（time の値）と、再開のとき Friend がカゴへ戻るまでの残り（s） */
  finishedAt: number; remount: number;
  /** スタートの演出（Friend が歩いてきてカゴに飛び乗る）の経過時間（s）。-1 = 演出なし・済み */
  introT: number;
  /** 世界の色の量（0 = 白黒・1 = カラー。なまらせた値。COLOR_BLOOM_*） */
  colorView: number;
  /** ベルを鳴らした時刻（time の値。ベルの音の線用） */
  bellAt: number;
  /** 足をついて止まっている時間（s）・ブレーキを握っているか・最後に踏んだ時刻（Friend の反応用） */
  stillTime: number; braking: boolean; pedalAt: number;
  /** Friend が振り向き → 跳ねるを始めた時刻（time の値・-1 = まだ） */
  cheerAt: number;
  /** ゴールのコイン: 0 = 前にある・1 = 取った・2 = 外した。取ってからの実時間（s・-1 = まだ）。最後に描いたコインの画面上の中心と大きさ */
  coinState: 0 | 1 | 2; collectReal: number; coinRect: { x: number; y: number; size: number } | null;
  /** 「!」が出ているか（前のフレーム）と、最後に「ピピッ」を鳴らした時刻（time の値） */
  dangerOn: boolean; dangerSoundAt: number;
  /** スピードで喜んだ時刻（time の値）・次に喜べるか・LOOK_FWD_V 以上で走り続けている時間（s）・前を向きはじめた時刻（time の値）・ゴールの跳ねの音を鳴らした数 */
  joyAt: number; joyArmed: boolean; cruiseT: number; fwdAt: number; goalHops: number;
  /** 川・小川に落ちて転んだか（再開までのあいだ）・ぶるぶるを始める時刻（time の値） */
  wetFall: boolean; shakeAt: number;
  /** 鼻歌のフレーズを歌っている最中か（音から。頭の横の小さな音符用） */
  humOn: boolean;
  /** 転倒までの近さ（|θ| ÷ 転ぶ傾き。1 で転ぶ）。Friend の「!」用 */
  danger: number;
  /** 区間に入った時刻（clock の値・区間の番号ごと。最初に入ったときだけ）と、いま出している差（s）と出す期限（time の値） */
  splits: number[]; splitDelta: number; splitUntil: number;
};

/** スタートからこの距離（m）までは操作のヒントを出す（2026-09-24。説明が設定メニューの中にしか無かった） */
const HINT_UNTIL = 40;
/** ゴールは爽快な下りの途中（Home straight の入口）。そのあとは自動で道なりに転がり、麓（Valley）で止まる（2026-09-25 コース作り直し）。
 *  その前は長い登りのてっぺん、さらに前はコースの終わりの 15m 手前だった */
const GOAL_AT = segmentStart("Home straight");
/** 作者（builder）の自己ベスト（s）。結果パネルに「Builder's best」として出す。
 *  2026-09-25: 1:25.3 → 1:24.7（下りの抵抗を弱めたあと・**ゴールを登りきった所へ移す前**に測った値）。ゴールが手前になったので測り直す（暫定）。
 *  本物の世界記録は出せない（SDK に保存の API が無く、他のプレイヤーの記録を集める場所が無い）。更新したらここを書き換える */
const BUILDER_BEST = 123.1; // 2:03.1（2026-09-27 builder・能力 1.1 固定。前日 2:11.6）
/** 秒を m:ss.s に */
const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

// ---- ランク（2026-09-25 builder「2:30 銅・2:00 銀・1:45 金、builder 越えはコイン」）-----------------
// 境目ちょうどは上のランク（2:30.0 は銅）。builder 越えは BUILDER_BEST より速いとき
type Rank = "builder" | "gold" | "silver" | "bronze";
// 2026-09-27 builder のベスト 2:03.1 に合わせて決め直し。最初に builder が決めた幅（builder 1:24.7 に対して 金 +20 秒・銀 +35 秒・銅 +65 秒）を当てはめて丸めた
// （前のコースは 金 1:45・銀 2:00・銅 2:30、コース作り直し後の暫定は 金 2:30・銀 2:50・銅 3:15）
const RANK_WITHIN: Readonly<Record<Exclude<Rank, "builder">, number>> = { gold: 145, silver: 160, bronze: 190 }; // s
const RANK_LABEL: Readonly<Record<Rank, string>> = { builder: "Builder coin", gold: "Gold", silver: "Silver", bronze: "Bronze" };
function rankOf(time: number): Rank | null {
  if (time < BUILDER_BEST) return "builder";
  if (time <= RANK_WITHIN.gold) return "gold";
  if (time <= RANK_WITHIN.silver) return "silver";
  if (time <= RANK_WITHIN.bronze) return "bronze";
  return null;
}
/** 次に狙うランクと、そのための時間（s）。builder 越えなら null */
function nextRank(rank: Rank | null): { rank: Rank; time: number; strictly: boolean } | null {
  if (rank === null) return { rank: "bronze", time: RANK_WITHIN.bronze, strictly: false };
  if (rank === "bronze") return { rank: "silver", time: RANK_WITHIN.silver, strictly: false };
  if (rank === "silver") return { rank: "gold", time: RANK_WITHIN.gold, strictly: false };
  if (rank === "gold") return { rank: "builder", time: BUILDER_BEST, strictly: true };
  return null;
}

// メダルとコインのドット絵（1文字 = 1ドット。o 縁・M 地・S 影・H 光・L/R リボン）
const MEDAL = [
  ".LLL....RRR.",
  "..LLL..RRR..",
  "...LLLRRR...",
  "....LLRR....",
  "...oooooo...",
  "..oMMMMMMo..",
  ".oMHHMMMMMo.",
  ".oMHMMMMMMo.",
  ".oMMMMMMMSo.",
  ".oMMMMMMSSo.",
  "..oMMMMSSo..",
  "...oooooo...",
];
// builder コイン（2026-09-25）。builder の X アイコン（07_tmp/ermine_compare.png のオコジョ・24×25 ドット）の頭を切り出して、
// 公式の $RAREFRIENDS トークンのアイコン（白い輪の中に Friend の顔）に寄せた白黒のコインに入れた。
// 丼は「何かわからない」（builder）ので外した。最初は金貨に黒シルエットで入れていた。o 縁・W 白・K 黒。
// 25×25（奇数）にして顔を左右の真ん中に、上下は中心より 0.5 ドット上に（2026-09-25 builder「顔を真ん中に、少し上に」。24×24 だと半ドットずれた）
const COIN = [
  "..........ooooo..........",
  ".......oooWWWWWooo.......",
  "......oWWWWWWWWWWWo......",
  "....ooWWWKKKKKKKWWWoo....",
  "...oWWWKKKKKKKKKKKWWWo...",
  "...oWWKKKKKKKKKKKKKWWo...",
  "..oWWKKKKKKKKKKKKKKKWWo..",
  ".oWWKKKKWWKKKKKWWKKKKWWo.",
  ".oWWKKKWWWWKKKWWWWKKKWWo.",
  ".oWKKKKWWKWWWWWKWWKKKKWo.",
  "oWWKKKWWWWWWWWWWWWWKKKWWo",
  "oWWKKKWWWWWWWWWWWWWKKKWWo",
  "oWWKKKWWWKWWWWWKWWWKKKWWo",
  "oWWKKKWWWWWWWWWWWWWKKKWWo",
  "oWWKKKKWWWWWKKWWWWWKKKWWo",
  ".oWKKKKWWWWWWWWWWWKKKKWo.",
  ".oWWKKKKWWWWWWWWWKKKKWWo.",
  ".oWWKKKKKKKKKKKKKKKKKWWo.",
  "..oWWKKKKKKKKKKKKKKKWWo..",
  "...oWWKKKKKKKKKKKKKWWo...",
  "...oWWWKKKKKKKKKKKWWWo...",
  "....ooWWWKKKKKKKWWWoo....",
  "......oWWWWWWWWWWWo......",
  ".......oooWWWWWooo.......",
  "..........ooooo..........",
];
const RANK_COLOURS: Readonly<Record<Rank, Readonly<Record<string, string>>>> = {
  builder: { M: "#f2cf7a", S: "#c9a04f", H: "#fff1c4" },
  gold: { M: "#f2cf7a", S: "#c9a04f", H: "#ffffff" },
  silver: { M: "#d2d8dc", S: "#9aa5ad", H: "#ffffff" },
  bronze: { M: "#cf8a57", S: "#9c5f35", H: "#f0c49c" },
};
function RankIcon({ rank, size }: { rank: Rank; size?: number }) {
  const grid = rank === "builder" ? COIN : MEDAL;
  const colours: Record<string, string> = { o: "#22303a", L: "#d26a5c", R: "#5e7ec1", F: "#e0b552", d: "#b8862b",
    K: "#000000", W: "#ffffff", w: "#ffffff", ...RANK_COLOURS[rank] };
  const px = size ?? (rank === "builder" ? 50 : 48); // 1 ドットが整数 px になる大きさ（コイン 25 → 2px、メダル 12 → 4px）
  return <svg className="ride-rank-icon" viewBox={`0 0 ${grid[0].length} ${grid.length}`} width={px} height={px}
    shapeRendering="crispEdges" aria-hidden="true">
    {grid.flatMap((row, y) => [...row].map((cell, x) =>
      colours[cell] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={colours[cell]} /> : null))}
  </svg>;
}

/** スタートのタイトルに出す Friend の絵（SDK の原画・こちら向き。白い縁取りつき。2026-09-25 試作） */
function FriendPortrait({ rows }: { rows: readonly string[] }) {
  const lit = (x: number, y: number) => rows[y]?.[x] === "#";
  const cells: React.ReactElement[] = [];
  for (let y = -1; y <= rows.length; y++) for (let x = -1; x <= (rows[0]?.length ?? 16); x++) {
    if (lit(x, y)) cells.push(<rect key={`${x}-${y}`} x={x + 1} y={y + 1} width={1} height={1} fill="#000000" />);
    else if (lit(x - 1, y) || lit(x + 1, y) || lit(x, y - 1) || lit(x, y + 1))
      cells.push(<rect key={`${x}-${y}`} x={x + 1} y={y + 1} width={1} height={1} fill="#ffffff" />);
  }
  return <svg className="ride-portrait" viewBox={`0 0 ${(rows[0]?.length ?? 16) + 2} ${rows.length + 2}`} width={72} height={72}
    shapeRendering="crispEdges" aria-hidden="true">{cells}</svg>;
}

/** X に貼ってもらう文。ゲームからは X を開けない（sandbox にポップアップ・移動の権限が無く、AGENTS.md も禁止）ので、コピーして貼ってもらう */
function shareText(time: number, rank: Rank | null, friendId: bigint) {
  const medal = rank ? ` (${RANK_LABEL[rank]})` : "";
  return `I rode Ride Along in ${formatTime(time)}${medal} with Rare Friend #${friendId}. `
    + `Can you beat the builder's ${formatTime(BUILDER_BEST)}? @RareFriendsNFT`;
}
/** クリップボードへ。navigator.clipboard は sandbox の権限で止められるので execCommand を使う（2026-09-25 実測で通った） */
function copyText(text: string) {
  const area = document.createElement("textarea");
  area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  return ok;
}

const freshRide = (): Ride => ({
  s: 0, x: 0, psi: 0, theta: 0, v: 0,
  altitude: 0, stamina: 1, expect: "L",
  time: 0, falling: 0, falls: 0, missed: 0,
  rock: 0, rockVel: 0,
  stroke: null, strokeStart: 0, strokeDone: 0,
  footDown: true, launching: true, pushLeft: 0, psiView: 0, climbView: 0, steerView: 0, steerDir: 0, steerHold: 0,
  clock: 0, topSpeed: 0, finished: false, finishedAt: 0, remount: 0,
  introT: -1, colorView: 0, bellAt: -10, stillTime: 0, braking: false, pedalAt: -10, cheerAt: -1, coinState: 0, collectReal: -1, coinRect: null, dangerOn: false, dangerSoundAt: -10, joyAt: -10, joyArmed: true, cruiseT: 0, fwdAt: -100, goalHops: 0, wetFall: false, shakeAt: -10, humOn: false, danger: 0, splits: [], splitDelta: 0, splitUntil: -1,
});

// ---- 描画 -----------------------------------------------------------------

type Projected = { sx: number; sy: number; scale: number };

// 頭の横移動は奥行きで減らす（視差）。HEAD_REF_DZ より手前は満額、奥は距離に反比例、地平線で 0。
// 2026-09-23 まで視界全体を同じ量ずらしていて、道の先（消失点）まで手前と一緒に揺れていた（builder「違和感」）
const HEAD_REF_DZ = 4;        // m
function project(worldX: number, elevation: number, dz: number, camX: number, psi: number, headPx = 0, lookPx = 0): Projected {
  const depth = Math.max(dz, 0.6);
  const scale = CAM_DEPTH / depth;
  const half = VIEW.width / 2;
  return {
    sx: half + scale * (worldX - camX) * half
      + headPx * Math.min(1, HEAD_REF_DZ / depth) - lookPx, // lookPx は視線の回転＝奥も手前も同じだけ
    sy: HORIZON_Y + scale * (CAM_HEIGHT - elevation * SLOPE_VIEW) * half,
    scale,
  };
}

/**
 * カゴと Friend。**描画順が要**: 背板 → Friend → 前板 の順に重ね、
 * Friend の脚をカゴの前板で隠すことで「カゴの上に浮いている」のを解消する。
 * 縁取りは矩形クリップではなくシルエットの外周1pxだけを塗る（白い枠が出ていた原因）。
 * 座標はすべて内部解像度（192×128）。1px = 画面 5px。
 * 2026-09-23: Friend を FRIEND_DOT 倍（2倍＝画面 160px）に。カゴは大きく・控えめな色にし、
 * ハンドルの下まで伸ばした（ハンドルはこのあとに描くので、カゴの手前を横切る）。
 * by はカゴの縁（前板の上端）の高さ。
 */
const FRIEND_DOT = 2;        // Friend の1ドット = 内部 2px（= 画面 10px。世界のドットの整数倍を保つ）
const BASKET_HALF = 26;      // 内部px  カゴの幅の半分
const BASKET_DEPTH = 18;     // 内部px  前板の高さ（縁からハンドルの下まで。28 → 18・2026-09-23）
const FRIEND_SUNK = 10;      // 内部px  Friend の下端がカゴの縁より沈む量
// Friend の動き（2026-09-24 builder「飛び出す → 喜ぶ」）。どれも reduced-motion では出さない（カゴに座ったまま）
// 2026-09-25 builder「飛び出しの回転も移動もちょっとゆっくりに」→ 遅くした分 画面の外まで飛ぶ時間が要るので FALL_TIME を 0.9 → 1.2 s
const FALL_TIME = 1.2;        // s  転倒してから再開までの時間（飛び出しはこの中に収める）
const FLY_VX = 50;            // 内部px/s  転んだ側へ飛ぶ横の速さ（70 → 50）
const FLY_VY = 95;            // 内部px/s  飛び上がる速さ（110 → 95。約 0.4 秒で 20px 上がる）
const FLY_G = 230;            // 内部px/s^2  落ちる加速度（360 → 230。1.2 秒で画面の下へ抜ける）
const FLY_SPIN = 6.5;         // rad/s  回る速さ（9 → 5 → 6.5・2026-09-25「もうちょっとだけ速く」。1/4 回転が約 0.24 秒ごと）
const REMOUNT_TIME = 0.35;    // s  再開のとき、上からカゴへ落ちて戻る時間
const REMOUNT_HEIGHT = 50;    // 内部px  どれだけ上から落ちてくるか
const CHEER_HOP = 8;          // 内部px  頂上で跳ねる高さ
// ゴールしたら Friend が景色の方を向き（背中＝up のコマ）、少し眺めてからこっちへ向き直って跳ねる（2026-09-25 builder「Friend の回転」）。
// 向きは 横 → 後ろ → 横 → 正面 と 1 コマずつ変える（ドット風）。結果パネルは向き直ったあとに出す
const TURN_STEP = 0.2;        // s  横向きの 1 コマ
// ゴールの流れ（2026-09-27 builder「アップ演出、スローと組み合わせてもいいかも」で入れ替えた）:
//   通過 → スローの間に Friend へ寄る（こっちを向いたまま ゆっくり跳ねる・名札）→ 引いて時間が戻る
//   → 景色の方を向く（鳥が飛び立つ）→ 向き直って跳ねる → 結果パネル
// 前（同日の A）は 振り向いて眺める → 向き直って跳ねる → そこで寄る → 結果（結果まで 4.8 秒）だった
// こっちを向いて 1 回跳ねる（ゲームの時間）。スローの間のゲームの時間（0.25 × 2.8 秒 ＋ 平均 0.625 × 0.6 秒 ≈ 1.08 秒）に合わせ、
// 時間が戻ると同時に景色の方へ向く（1.3 → 0.9 → 1.1・2026-09-27 スローを引きと一緒に終える／アップを延ばした）
const GOAL_JOY = 1.1;         // s
const LOOK_LEN = 1.8;         // s  景色を眺める（前は 2.2）
const LOOK_FROM = GOAL_JOY + TURN_STEP;  // 後ろ向き（景色の方）になる
const LOOK_UNTIL = LOOK_FROM + LOOK_LEN; // 眺め終わる
const HOP_FROM = LOOK_UNTIL + TURN_STEP; // 向き直って跳ねはじめる
const GOAL_HOP_SOUND_AT = 0.1; // s（ゲームの時間）スローの跳ねの「ピピッ」。ゴールのベルと重ならないよう少し遅らせる
// アップ（実時間・ゴールの通過から）: CLOSEUP_IN 秒かけて CLOSEUP_ZOOM 倍まで寄り、CLOSEUP_UNTIL 秒から CLOSEUP_OUT 秒かけて引く。名札は NAMEPLATE_FROM 秒から。
// 2 倍は整数倍なのでドットが崩れない。reduced-motion では寄らない（スローもしない）
// 2026-09-27 builder「寄りもスローに（引きも？）自然なほうで」: 寄り・引き 0.35 → 0.9 秒、名札 0.5 → 0.7 秒から
const CLOSEUP_ON = true;
const CLOSEUP_UNTIL = 2.8;    // s（実時間）（2.0 → 2.8・2026-09-27 builder「最後のアップの時間もうちょっと伸ばして」）
const CLOSEUP_IN = 0.9;       // s（実時間）
const CLOSEUP_OUT = 0.6;      // s（実時間）（0.9 → 0.6・2026-09-27 builder「引きは少し早くてもいい、引きと同時にスロー終了」）
const CLOSEUP_ZOOM = 2;
const NAMEPLATE_FROM = 0.7;   // s（実時間）
// スローの間の光（2026-09-27 builder「スローの時ちょっとぼやける？光る？演出ほしい」）: 画面のふちだけ ぼかして明るくし、ふちに白い光を重ねる。
// 真ん中（寄った Friend）はくっきりのまま。強さはスローの深さに合わせる（SLOW_GLOW_RISE 秒で立ち上がり、スローが明けるのと一緒に消える）。
// ぼかしは canvas の filter が使えるブラウザだけ（使えなければ光だけ）
const SLOW_GLOW_ON = true;
const SLOW_GLOW_RISE = 0.2;   // s（実時間）
const SLOW_GLOW_BLUR = 5;     // 画面px
const SLOW_GLOW_LIGHT = 0.4;  // ふちの白い光の濃さ（0..1）
const RESULT_DELAY = HOP_FROM + 0.2; // s（ゲームの時間・ゴールから）結果パネルを出すまで
// 2026-09-25 builder「ドット風に、あえて。10秒に9回くらいの のんびりした速さ」
const CHEER_PER_SECOND = 0.9; // 回/s（前は約 2.2）
const CHEER_STEP = 1 / 8;     // s  コマ送り。位置はこの間隔でしか変えない
const CHEER_PX = 2;           // 内部px  高さも この刻みで段々に

// ---- 2026-09-25 の試作（builder のアイデア一覧から）。どれも reduced-motion では出さない。戻すときは各 *_ON を false に
// スタート: Friend が右から歩いてきて、カゴに飛び乗る（最初のペダルで飛ばせる）
const INTRO_ON = true;
const INTRO_WALK = 1.2;       // s  歩いてくる時間
const INTRO_HOP = 0.9;        // s  飛び乗る時間（0.5 → 0.9・2026-09-26 builder「落ちてくるところ、もうちょいゆっくり」）
const INTRO_GROUND_Y = 78;    // 内部px  歩いてくる地面の高さ（Friend の足元。約4m先の道）
const INTRO_LAND_DX = 34;     // 内部px  カゴの中心から右へこれだけの所で踏み切る
const INTRO_HOP_PEAK = 16;    // 内部px  飛び乗るときの山の高さ（14 → 16）
const INTRO_STEP = 1 / 12;    // s  コマ送り（跳ねると同じくドット風）
// Friend の小さな反応（2026-09-26 builder「Friend の動きをもう少し増やしたい」）。優先順: 転びそう → 止まってキョロキョロ → 橋で小川を見る。
// 上下のずれ（ベル・ブレーキ・登りの踏み込み）は向きと重ねる
const FRIEND_REACT_ON = true;
const LOOK_AROUND_AFTER = 1.5; // s  足をついて止まってから、キョロキョロしはじめるまで
const LOOK_STEP = 0.8;        // s  キョロキョロの 1 コマ（左 → 正面 → 右 → 正面）
const BELL_HOP = 4;           // 内部px  ベルが鳴ったときに跳ねる高さ（0.5 秒・コマ送り）
const BRAKE_LURCH = 2;        // 内部px  ブレーキでつんのめる量（前＝画面の上へ）
// 30km/h 以上: Friend が歩きのコマでバタバタし、1px 刻みで風に揺れる
const EXCITED_ON = true;
const EXCITED_V = 30 / 3.6;   // m/s
// スピードで喜ぶ（2026-09-27 builder「スピードが出て喜ぶ動き、分かりづらい」）: JOY_V を超えた瞬間、こっちを向いて 2 回跳ね（JOY_HOP px・JOY_LEN 秒）、
// 頭の上にライムの音符、「ピピッ」。1 回超えるごとに 1 回だけ（JOY_REARM_V を下回ったら次に超えたときにまた出る）。
// 2026-09-27 builder「一定速度を超える 1 回につき 1 回でいい（下りで何回かピコってなる）」: 速いままでも 6 秒おきに出していたのをやめた
const JOY_ON = true;
const JOY_V = 32 / 3.6;       // m/s（30 → 32・2026-09-27 builder「32km/h くらいがいいかも」）
const JOY_REARM_V = 28 / 3.6; // m/s（26 → 28。超える所から 4km/h 下）
const JOY_LEN = 0.9;          // s
const JOY_HOP = 6;            // 内部px
// 走っている間ときどき前（進む方）を向く（2026-09-27 builder「走ってる時にちょっと前向く演出あってもいい。速度で決める？」）:
// LOOK_FWD_V 以上で LOOK_FWD_WAIT 秒走り続けたら、横 → 後ろ（前を見る）→ 横 → こっち、を LOOK_FWD_LEN 秒。
// 一度向いたら速度が落ちても最後まで向いている。終わったら、また LOOK_FWD_WAIT 秒走り続けるまで向かない。転んだら・止まったらやめる
// 2026-09-27 builder「20km/h を前後すると発動して戻ってを繰り返す。発動したら発動したままに。1 回の前向き時間をもう少し長く」:
// 前は速度が落ちると途中でこっちに戻り、2.5 秒走ったら 2.4 秒・5 秒あけて繰り返していた → 待ち 5 秒・向く 3.5 秒
const LOOK_FWD_ON = true;
const LOOK_FWD_V = 20 / 3.6;  // m/s
const LOOK_FWD_WAIT = 5;      // s
const LOOK_FWD_LEN = 4;       // s（3.5 → 4・2026-09-27 builder）
// 速度線: 25km/h から画面の端にだけ短い線。コマ送りで出し直す
const SPEED_LINES_ON = true;
// 2026-09-25 builder「めちゃめちゃ控えめに」: 25 → 30km/h から、最大 22 → 5 本、長さも半分
// 2026-09-26 builder「チャリが中心になるように。35km/h 付近から、もうちょっとだけ控えめに」: 中心を消失点（地平線の真ん中）→ 自転車（カゴ）に、
// 30 → 35km/h から、最大 5 → 4 本
const SPEED_LINES_FROM = 35 / 3.6, SPEED_LINES_FULL = 44 / 3.6; // m/s
const SPEED_LINES_MAX = 4;    // 本（満額のとき）
const SPEED_LINES_STEP = 1 / 15; // s
// ゴールの横断幕と紙吹雪は 2026-09-25 に外した（builder「いらない」）
// ゴールの目印（2026-09-26）。最初は浮かぶライムの文字「GOAL」（案 A）→ 同日 builder「RAREFRIENDS のコインを今の感じで浮かせて、
// 通過した瞬間スローにして GOAL ポップアップ」→ $RAREFRIENDS トークンと同じ作り（白い二重の輪の中に Friend の顔）のコイン。
// 顔はプレイヤーの Friend（原画を白く抜いたもの）。路面のライムの点線はそのまま
const GOAL_MARK_ON = true;
const GOAL_COIN_CELL = 0.055; // m  コインの 1 ドット（28 ドットで直径 約 1.5m）
const GOAL_COIN_LIFT = 0.35;  // m  コインの下端の高さ（1.8 → 0.35・2026-09-26 builder「コインとる感じの高さに」。中心が目線より少し下 約 1.1m）
// コインを取った演出（実時間 COLLECT_TIME 秒）: 道に浮かんでいたコインの位置・大きさからポンと大きくなり、回りながら左上へ飛んで小さくなる。キラキラが散る。
// 取るのはコインの COLLECT_DZ m 手前（手が届く距離）で、道の真ん中から COIN_REACH m 以内を通ったときだけ。外したら演出なし（コインは横を過ぎる）
// （2026-09-26 builder「コインを取った瞬間のずれが気になる／取れなかったら演出不要」。前はゴールの線で、画面の真ん中に小さく出し直していて位置と大きさが飛んだ）
const COLLECT_TIME = 0.9;     // s（実時間）
const COLLECT_DZ = 3.5;       // m
const COIN_REACH = 1.0;       // m
// 通過の瞬間のスロー（実時間で SLOW_HOLD 秒は SLOW_SCALE 倍、そのあと SLOW_EASE 秒で 1 倍へ）と「GOAL」のポップアップ（GOAL_POP 秒）。
// reduced-motion ではスローにしない（ポップアップは出す・動かさない）
// 2026-09-27 builder「引きと同時にスロー終了」: スローはアップの間ずっと続け、引くのと一緒に 1 倍へ戻す（前は 1.0 秒＋0.8 秒で、寄ったまま時間が戻っていた）
const SLOW_SCALE = 0.25;
const SLOW_HOLD = CLOSEUP_ON ? CLOSEUP_UNTIL : 1.0; // s（実時間）
const SLOW_EASE = CLOSEUP_ON ? CLOSEUP_OUT : 0.8;   // s（実時間）
const GOAL_POP = 2.0;         // s（実時間）
// 頂上の景色: 湖に夕日の光の道・ゴールで鳥が飛び立つ・頂上付近の右側の木を減らして見晴らしを開く
const SUMMIT_VIEW_ON = true;
const SUMMIT_OPEN = 70;       // m  頂上の前後この距離は右側の木を植えない（見晴らし）
// 谷底の橋（2026-09-25 builder「2（谷底の橋）もいいね」）。右から来た小川が道の下をくぐって左の川に流れ込む。
// 道はその前後 BRIDGE_DECK だけ板張りの橋になり、両側に木の手すり（BRIDGE_RAIL m の高さ、BRIDGE_POST m おきの柱）
const BRIDGE_AT = segmentStart("River bridge") + 14; // m  小川の手前の岸
const BRIDGE_WATER = 9;       // m  道の下での小川の幅（12 → 9。右では蛇行しながら細くなって奥へ消える・2026-09-25 builder「川がちょっと不自然」）
const BRIDGE_DECK = 3;        // m  岸から外へ張り出す板の長さ
const BRIDGE_RAIL = 1.0;      // m
const BRIDGE_POST = 2;        // m
/** 水に入ったか（2026-09-27 builder「橋と川のコースアウトは厳密に。橋に乗れなかったらそこでコケる」）:
 *  小川の上で橋から横にはみ出した／道の横を流れる川（左）に入った */
function inWater(it: { s: number; x: number }): boolean {
  if (it.s > BRIDGE_AT && it.s < BRIDGE_AT + BRIDGE_WATER && Math.abs(it.x) > HALF_WIDTH + 0.3) return true;
  return it.x < -(HALF_WIDTH + 1.5) + riverShift(it.s);
}
/** s が橋の範囲（板の橋の前後）か。路面のむら・砂利・草むらの点を描かない（橋の上がまだら模様になった・2026-09-27 builder） */
const onBridge = (s: number) => s > BRIDGE_AT - BRIDGE_DECK - 1 && s < BRIDGE_AT + BRIDGE_WATER + BRIDGE_DECK + 1;
// 川の置き方（2026-09-27 builder「登りなのに川がある・橋の場所と合わない」→ 風景の直し）。
// 川が道のそばを流れるのは低い所（スタート〜谷底の橋）と、最後の下りで降りてきた麓だけ。
// 橋を渡ったら RIVER_LEAVE m かけて左へ RIVER_AWAY m 離れ（登りの左は草の斜面と木）、最後の下りの途中から RIVER_BACK m かけて戻ってくる
const RIVER_AWAY = 70;        // m
const RIVER_LEAVE = 90;       // m
const RIVER_BACK = 110;       // m
/** s 地点での川の横のずれ（m・負 = 左へ離れる） */
function riverShift(s: number): number {
  const leaveFrom = BRIDGE_AT + BRIDGE_WATER + 25, backFrom = segmentStart("Sweeping left") + 20;
  return -RIVER_AWAY * smooth(leaveFrom, leaveFrom + RIVER_LEAVE, s) * (1 - smooth(backFrom, backFrom + RIVER_BACK, s));
}

// タイプの動き（2026-09-28 builder が案出しから選んだもの）
// バランス型: 自転車が傾くと、Friend が反対側へ体を寄せて手伝う（倒れる傾きの COUNTER_LEAN_FROM 倍で COUNTER_LEAN_PX px、COUNTER_LEAN_FULL 倍でその 2 倍。1px だと画面 5px で見えなかった）
const COUNTER_LEAN_ON = true;
const COUNTER_LEAN_FROM = 0.3, COUNTER_LEAN_FULL = 0.6;
const COUNTER_LEAN_PX = 2;    // 内部px（Friend の 1 ドット）
// パワー型: 登り（勾配 PUSH_GRADE 以上＝4% の登りから）で漕いでいる間、一緒に踏ん張る（1px 沈む・踏むたびに持ち上がる）。
// 急な登り（PUSH_SWEAT_GRADE 以上＝最後の +9%）では汗が PUSH_SWEAT_EVERY 秒おきに垂れる
const POWER_PUSH_ON = true;
const PUSH_GRADE = 0.035;
const PUSH_SWEAT_GRADE = 0.07;
const PUSH_SWEAT_EVERY = 1.4; // s
// 川・小川に落ちたら、カゴに戻ったあと SHAKE_LEN 秒 ぶるぶる体を振って水を飛ばす
const SHAKE_ON = true;
const SHAKE_LEN = 0.9;        // s
// 記号（頭の上）: 「?」は止まってキョロキョロしはじめて QUESTION_LEN 秒、「♥」は止まっているときにベルを鳴らしたら HEART_LEN 秒と、ゴールのスローで跳ねている間
const MARKS_ON = true;
const QUESTION_LEN = 1.4;     // s
const HEART_LEN = 0.9;        // s

// 鼻歌（2026-09-28 builder「BGM を Friend の鼻歌にする」。音は audio.ts）: 気分をここで決めて毎フレーム渡す。
// 歌うのは HUM_FROM_V 以上で走っているとき（歌っている最中は HUM_KEEP_V まで下がっても続ける）と、急な登り（ゆっくり低く・途切れ途切れ）。
// 30km/h（EXCITED_V）以上は速い歌。止まっている・「!」・転倒・スタミナ切れ・メニューでは黙る。ゴールのあと転がっている間は歌う
const HUM_FROM_V = 12 / 3.6;  // m/s
const HUM_KEEP_V = 8 / 3.6;   // m/s
const HUM_VOICE_SPREAD = 0.05; // 声の高さの個体差（±）
// 歌っている間、頭の左に小さな白い音符（HUM_NOTE_EVERY 秒おきに昇る）。音が出ていないとき（ミュート・音がまだ有効でない）は出ない
const HUM_NOTE_ON = true;
const HUM_NOTE_EVERY = 1.3;   // s
function humMood(ride: Ride, blocked: boolean): HumMood {
  if (blocked || ride.falling > 0 || ride.footDown || ride.stamina < STAMINA_LOW) return "rest";
  if (!ride.finished && ride.danger > DANGER_FROM) return "rest";
  if (!ride.finished && gradeAt(ride.s) >= PUSH_SWEAT_GRADE && ride.v > 1) return "climb";
  if (ride.v < (ride.humOn ? HUM_KEEP_V : HUM_FROM_V)) return "rest";
  return ride.v >= EXCITED_V ? "fast" : "walk";
}

// 転びそうなとき Friend の頭の上に「!」（転ぶ傾きの DANGER_FROM 倍を超えたら。点滅はコマ送り）
const DANGER_ON = true;
const DANGER_FROM = 0.7;
const DANGER_SOUND_GAP = 1.5; // s  「!」の「ピピッ」を続けて鳴らさない間隔（2026-09-27 builder「危ない時びっくりと一緒に音」）
// 区間ごとのタイム差: 区間の変わり目で、この回のベストの同じ区間と比べた差を SPLIT_SHOW 秒出す（1 回目は比べる相手が無いので出さない）
const SPLITS_ON = true;
const SPLIT_SHOW = 2;         // s

/** ゴールのコイン（1 ドット = 1px・28×28）。$RAREFRIENDS トークンの作り＝白い二重の輪・黒い面・白い Friend。Friend ごとに一度だけ作る */
// 2026-09-27 公式トークンのコイン（熊の顔・rarefriends.com /art/token.svg を 28×28 に起こしたもの）に一度替えたが、
// 同日 builder「やっぱりキャラ（Friend）の顔にしよう」で戻した
let goalCoinCanvas: HTMLCanvasElement | null = null, goalCoinRows: readonly string[] | null = null;
function goalCoin(rows: readonly string[]): HTMLCanvasElement {
  if (goalCoinCanvas && goalCoinRows === rows) return goalCoinCanvas;
  const N = 28, c = (N - 1) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = N; canvas.height = N;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d > 13.6) continue;
      ctx.fillStyle = d > 12.9 ? "#22303a" : d > 11.3 ? "#ffffff" : d > 10.4 ? "#000000" : d > 9.6 ? "#ffffff" : "#000000";
      ctx.fillRect(x, y, 1, 1);
    }
    const w = rows[0]?.length ?? 16, h = rows.length;
    const left = Math.round(c - w / 2 + 0.5), top = Math.round(c - h / 2 + 0.5);
    ctx.fillStyle = "#ffffff";
    rows.forEach((row, y) => [...row].forEach((cell, x) => { if (cell === "#") ctx.fillRect(left + x, top + y, 1, 1); }));
  }
  goalCoinCanvas = canvas; goalCoinRows = rows;
  return canvas;
}

// ---- Friend の表情と身に着けるもの（2026-09-28 builder が案出しから選んだもの）。どれも reduced-motion では出さない
// 目: 原画の「黒の中の白い穴」のうち、一番上にある小さな穴（4 ドット以下）を目とみなす。口や胴の穴（Asymmetry・Mask）はそれより下なので外れる。
// Hollow は顔全体が中抜きで小さな穴が無い → 目の演出なし（原画のまま）
const BLINK_ON = true;
const BLINK_EVERY = 3.2;      // s  平均の間隔（実際は 1 回ごとに 0〜BLINK_JITTER 秒ずらす）
const BLINK_JITTER = 2.0;     // s
const BLINK_LEN = 0.12;       // s  閉じている時間
const WIDE_EYES_ON = true;    // 驚いたら目が大きくなる（「!」が出ている間と、転んで飛び出している間）
// 転んだ回数が HELMET_FALLS 回になったら、再開のときにヘルメットをかぶっている（Ride again で脱ぐ）
const HELMET_ON = true;
const HELMET_FALLS = 3;
type FriendLook = { eyes?: "open" | "closed" | "wide"; helmet?: boolean };
type EyeCells = readonly (readonly [number, number])[];
const eyeCache = new WeakMap<readonly string[], EyeCells>();
/** 原画の目のドット（[x, y]）。見つからなければ空 */
function friendEyes(rows: readonly string[]): EyeCells {
  const hit = eyeCache.get(rows);
  if (hit) return hit;
  const h = rows.length, w = rows[0]?.length ?? 0;
  const solid = (x: number, y: number) => y >= 0 && y < h && x >= 0 && x < w && rows[y][x] === "#";
  // 外から塗りつぶして、届かなかった空白＝穴
  const outside = new Set<number>();
  const key = (x: number, y: number) => (y + 1) * (w + 2) + x + 1;
  const stack: [number, number][] = [[-1, -1]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < -1 || y < -1 || x > w || y > h || solid(x, y) || outside.has(key(x, y))) continue;
    outside.add(key(x, y));
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  const seen = new Set<number>(), groups: [number, number][][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (solid(x, y) || outside.has(key(x, y)) || seen.has(key(x, y))) continue;
    const group: [number, number][] = [], todo: [number, number][] = [[x, y]];
    seen.add(key(x, y));
    while (todo.length) {
      const [cx, cy] = todo.pop()!;
      group.push([cx, cy]);
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || solid(nx, ny) || outside.has(key(nx, ny)) || seen.has(key(nx, ny))) continue;
        seen.add(key(nx, ny)); todo.push([nx, ny]);
      }
    }
    groups.push(group);
  }
  const small = groups.filter(g => g.length <= 4);
  const topOf = (g: [number, number][]) => Math.min(...g.map(([, y]) => y));
  const top = small.length ? Math.min(...small.map(topOf)) : 0;
  const eyes = small.filter(g => topOf(g) <= top + 1).flat();
  eyeCache.set(rows, eyes);
  return eyes;
}

/** Friend を描く（SDK の原画を整数倍。縁取りは拡大後のシルエットの外周1px）。look で目の開き方・ヘルメット */
function paintFriend(ctx: CanvasRenderingContext2D, rows: readonly string[], left: number, top: number, look: FriendLook = {}) {
  const width = rows[0]?.length ?? 16;
  const d = FRIEND_DOT;
  const lit = (x: number, y: number) => {
    const sx = Math.floor(x / d), sy = Math.floor(y / d);
    return x >= 0 && y >= 0 && sy < rows.length && sx < rows[sy].length && rows[sy][sx] === "#";
  };
  ctx.fillStyle = "#fff";
  for (let y = -1; y <= rows.length * d; y++) {
    for (let x = -1; x <= width * d; x++) {
      if (lit(x, y)) continue;
      if (lit(x - 1, y) || lit(x + 1, y) || lit(x, y - 1) || lit(x, y + 1)) {
        ctx.fillRect(left + x, top + y, 1, 1);
      }
    }
  }
  ctx.fillStyle = "#000";
  rows.forEach((row, y) => [...row].forEach((pixel, x) => {
    if (pixel === "#") ctx.fillRect(left + x * d, top + y * d, d, d);
  }));
  const eyes = look.eyes && look.eyes !== "open" ? friendEyes(rows) : [];
  if (look.eyes === "closed") {
    // 閉じた目: 穴を黒で埋め、いちばん下の段だけ下 1px を白い線で残す
    const bottom = new Map<number, number>();
    eyes.forEach(([x, y]) => bottom.set(x, Math.max(bottom.get(x) ?? -1, y)));
    eyes.forEach(([x, y]) => {
      ctx.fillStyle = "#000";
      ctx.fillRect(left + x * d, top + y * d, d, d);
      if (bottom.get(x) === y) { ctx.fillStyle = "#fff"; ctx.fillRect(left + x * d, top + y * d + d - 1, d, 1); }
    });
  } else if (look.eyes === "wide") {
    // 見開いた目: 穴をまわりに 1px ずつ広げる
    ctx.fillStyle = "#fff";
    eyes.forEach(([x, y]) => ctx.fillRect(left + x * d - 1, top + y * d - 1, d + 2, d + 2));
  }
  if (look.helmet) paintHelmet(ctx, rows, left, top);
}

/** ヘルメット（ライムの殻・濃紺の縁・白い光）。頭のてっぺん（4 ドット以上つながった最初の段）にかぶせ、目より上で止める。耳は上に出てよい */
function paintHelmet(ctx: CanvasRenderingContext2D, rows: readonly string[], left: number, top: number) {
  const d = FRIEND_DOT;
  const head = rows.findIndex(row => /#{4,}/.test(row));
  if (head < 0) return;
  const eyes = friendEyes(rows);
  const eyeTop = eyes.length ? Math.min(...eyes.map(([, y]) => y)) : Infinity;
  const bottom = Math.max(head, Math.min(head + 1, eyeTop - 1));
  // 横の広がりは頭の段（head〜bottom）の中で一番長くつながった所
  let from = 0, to = -1;
  for (let y = head; y <= bottom; y++) {
    for (const m of rows[y].matchAll(/#+/g)) {
      if (m[0].length > to - from + 1) { from = m.index ?? 0; to = from + m[0].length - 1; }
    }
  }
  const x0 = left + (from - 1) * d, x1 = left + (to + 2) * d; // 左右に 1 ドットはみ出す
  const y0 = top + (head - 1) * d, y1 = top + (bottom + 1) * d;
  // 殻（上の段は左右 1 ドットずつ内側＝丸く）。縁取りは上と横だけ外に出し、下の縁（つば）は y1 の手前 1px＝目の段にかからない
  ctx.fillStyle = "#22303a";
  ctx.fillRect(x0 + d - 1, y0 - 1, x1 - x0 - 2 * d + 2, d + 1);
  ctx.fillRect(x0 - 1, y0 + d - 1, x1 - x0 + 2, y1 - y0 - d + 1);
  ctx.fillStyle = "#cdef3c";
  ctx.fillRect(x0 + d, y0, x1 - x0 - 2 * d, d);
  ctx.fillRect(x0, y0 + d, x1 - x0, y1 - y0 - d - 1);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x0 + d + 1, y0 + 1, Math.min(3, x1 - x0 - 2 * d - 2), 1);
}

/** カゴと、その中の Friend（rows が null なら空のカゴ＝飛び出している間）。friendDy は Friend だけ上下にずらす量 */
function paintBasketAndFriend(
  ctx: CanvasRenderingContext2D, rows: readonly string[] | null,
  centreX: number, baseY: number, friendDy: number, friendDx = 0, look: FriendLook = {},
) {
  const cx = Math.round(centreX);
  const by = Math.round(baseY);

  // 1) 背板（Friend の後ろ・奥の縁）
  ctx.fillStyle = "#7d6f58";
  ctx.fillRect(cx - BASKET_HALF + 2, by - 4, BASKET_HALF * 2 - 4, 4);

  // 2) Friend
  if (rows) {
    const width = rows[0]?.length ?? 16;
    paintFriend(ctx, rows, cx - Math.round(width * FRIEND_DOT / 2) + Math.round(friendDx), by + FRIEND_SUNK - rows.length * FRIEND_DOT + Math.round(friendDy), look);
  }

  // 3) 前板。色数を絞り、編み目は近い色の横線だけ（主張を控えめに・2026-09-23）
  ctx.fillStyle = "#9a8a6c";
  ctx.fillRect(cx - BASKET_HALF, by, BASKET_HALF * 2, BASKET_DEPTH);
  ctx.fillStyle = "#857658"; // 編み目（#918163 だとパレットに丸めたとき前板と同じ色になって消えるので、縁と同じ色に）
  for (let y = by + 4; y < by + BASKET_DEPTH - 1; y += 4) ctx.fillRect(cx - BASKET_HALF, y, BASKET_HALF * 2, 1);
  ctx.fillStyle = "#857658";
  ctx.fillRect(cx - BASKET_HALF - 1, by - 1, BASKET_HALF * 2 + 2, 2); // 縁
}

// 車体（カゴ・Friend・ハンドルバー）は、回さずに別の canvas へドットで描いてから、補間なしで回して貼る（2026-09-24）。
// それまでは傾けた座標にそのまま塗っていて、縁が中間色でぼけていた（ドット絵の中でハンドルとカゴだけ浮いて見えた）。
// 補間なしの drawImage なら回しても色は元のドットのどれかのまま。ぼけるのは透明な外枠だけ
let bodyLayer: HTMLCanvasElement | null = null;
function paintRotatedCrisp(
  ctx: CanvasRenderingContext2D, pivotX: number, pivotY: number, angle: number,
  draw: (layer: CanvasRenderingContext2D) => void,
) {
  if (!bodyLayer) {
    bodyLayer = document.createElement("canvas");
    bodyLayer.width = VIEW.width; bodyLayer.height = VIEW.height;
  }
  const layer = bodyLayer.getContext("2d");
  if (!layer) return;
  layer.clearRect(0, 0, VIEW.width, VIEW.height);
  draw(layer);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(pivotX, pivotY);
  ctx.rotate(angle);
  ctx.translate(-pivotX, -pivotY);
  ctx.drawImage(bodyLayer, 0, 0);
  ctx.restore();
}

/** スローの間の光: 画面のふちを ぼかして明るくし、白い光を重ねる（amount 0..1）。真ん中はそのまま */
function paintSlowGlow(ctx: CanvasRenderingContext2D, work: HTMLCanvasElement, amount: number) {
  const { width: w, height: h } = SCREEN;
  const cx = w / 2, cy = h * 0.45, inner = w * 0.24, outer = w * 0.62;
  const g = work.getContext("2d");
  if (g && "filter" in g) {
    g.clearRect(0, 0, w, h);
    g.filter = `blur(${SLOW_GLOW_BLUR}px) brightness(1.18)`;
    g.drawImage(ctx.canvas, 0, 0);
    g.filter = "none";
    // 真ん中を抜く（ふちだけ残す）
    const hole = g.createRadialGradient(cx, cy, inner, cx, cy, outer);
    hole.addColorStop(0, "rgba(0,0,0,1)"); hole.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = hole; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "source-over";
    ctx.globalAlpha = amount;
    ctx.drawImage(work, 0, 0);
    ctx.globalAlpha = 1;
  }
  const light = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer * 1.25);
  light.addColorStop(0, "rgba(255,252,232,0)");
  light.addColorStop(1, `rgba(255,252,232,${SLOW_GLOW_LIGHT * amount})`);
  ctx.fillStyle = light; ctx.fillRect(0, 0, w, h);
}

function paintScene(
  ctx: CanvasRenderingContext2D, ride: Ride, sprites: GenerationSprites,
  frame: number, stillFriend: boolean, clearance: number, type: FriendType = "allround",
) {
  const roll = -(ride.theta * ROLL_VIEW + ride.steerView * STEER_ROLL);
  const look = ride.steerView * STEER_LOOK + ride.psiView * PSI_LOOK;
  const lookPx = look * BG_PX_PER_RAD; // 遠景と同じ量だけ地面もずらす（地平線で山と道がずれないように）
  ctx.clearRect(0, 0, VIEW.width, VIEW.height);
  // 前後傾: 景色全体（遠景も地面も）を上下にずらす。カゴとハンドルは体と一緒に動くので対象外。reduced-motion では出さない
  ctx.save();
  // 整数に丸める（2026-09-25。小数のままだと景色の縁が全部 0.5px にじみ、パレットに丸めたとき鳥などが変な色になっていた）
  ctx.translate(0, stillFriend ? 0 : Math.round(clamp(ride.climbView * (ride.climbView > 0 ? PITCH_PER_GRADE_UP : PITCH_PER_GRADE_DOWN), -PITCH_MAX, PITCH_MAX)));

  // 視界そのものが傾く（車体に固定されたカメラ）。カゴはこの外で描くので画面に対して固定。
  // 遠景（空・太陽・雲・山）。頭の横移動は受けず、回転は BG_ROLL 倍だけ。
  // 中心は「地面の変換で地平線の真ん中が来る点」＝地面と地平線の位置は合う（傾きだけ遠景が浅い）
  const pivotDrop = (VIEW.height * 0.62 - HORIZON_Y) * 1.25;
  ctx.save();
  ctx.translate(VIEW.width / 2 + Math.sin(roll) * pivotDrop, VIEW.height * 0.62 - Math.cos(roll) * pivotDrop);
  ctx.rotate(roll * BG_ROLL);
  ctx.scale(1.25, 1.25); // 回転で隅が欠けないように拡大しておく
  ctx.translate(-VIEW.width / 2, -HORIZON_Y);

  const half = VIEW.width / 2;
  const viewHeading = headingAt(ride.s) + look;
  const bgShift = viewHeading * BG_PX_PER_RAD;
  const vista = smooth(VISTA_FROM, VISTA_FULL, ride.s);
  const time = stillFriend ? 0 : ride.time; // reduced-motion では雲・水面を止める

  // ---- 空（ディザ済みを貼るだけ。高度が上がると夕方の色へ寄る）
  const sky = skies();
  ctx.drawImage(sky.day, -40, -40);
  if (vista > 0) {
    ctx.globalAlpha = vista * 0.75;
    ctx.drawImage(sky.dusk, -40, -40);
    ctx.globalAlpha = 1;
  }

  // ---- 太陽（方位に固定。見晴らしが開くほど低く・大きく・暖かく）
  const sunX = Math.round(half + (SUN_AZIMUTH * BG_PX_PER_RAD - bgShift));
  const sunY = Math.round(HORIZON_Y - 26 + 12 * vista);
  const sunR = 3 + Math.round(vista * 2);
  if (sunX > -60 && sunX < VIEW.width + 60) {
    ctx.fillStyle = vista > 0.4 ? "#ffe3a3" : "#fff6d8";
    // 光の輪は見晴らしが開くほど薄く、頂上で消す（2026-09-25 builder「夕焼けで太陽の周りの色がおかしい。背景と差をつけなくていい」。
    // 夕焼けの空に重ねると、パレットに丸めたとき周りと違う色の輪になっていた）
    ctx.globalAlpha = 0.35 * (1 - vista);
    ctx.beginPath(); ctx.arc(sunX, sunY, sunR + 3, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = vista > 0.4 ? "#ffd27a" : "#fffbe9";
    ctx.beginPath(); ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2); ctx.fill();
  }

  // ---- 雲（方位に固定＋ゆっくり流れる）
  for (let c = 0; c < 9; c++) {
    const w = 10 + Math.round(hash(c + 0.3) * 20);
    const x = Math.round(wrap(hash(c) * BG_PERIOD - bgShift * 0.95 + time * 1.2, BG_PERIOD) - 60);
    if (x > VIEW.width + 50 || x + w < -50) continue;
    const y = Math.round(2 + hash(c + 0.7) * 22);
    ctx.fillStyle = vista > 0.5 ? "#f6e3d2" : "#f5f8f9";
    ctx.fillRect(x, y, w, 3);
    ctx.fillRect(x + Math.round(w * 0.2), y - 2, Math.round(w * 0.5), 2);
    ctx.fillRect(x + Math.round(w * 0.35), y - 3, Math.round(w * 0.25), 1);
    ctx.fillStyle = vista > 0.5 ? "#d9b9b0" : "#d3dee5";
    ctx.fillRect(x + 1, y + 3, w - 2, 1);
  }

  // ---- 遠景（奥の山並み → 湖 → 手前の丘）
  // 登るほど手前の丘が沈み、奥の山並みと湖が見えてくる＝頂上の見晴らし。
  // 1列ずつ fillRect で塗ると、視界の回転・拡大で列の継ぎ目が縦筋になったので多角形で塗る。
  const xs: number[] = [];
  for (let x = -44; x <= VIEW.width + 44; x += 2) xs.push(x);
  const farH = xs.map(x => (15 + ridge(x + bgShift, 1.3, FAR_RANGE)) * (0.8 + 0.35 * vista));
  const nearH = xs.map(x => Math.max(0, (9 + ridge(x + bgShift, 4.1, NEAR_HILLS)) * (1 - 0.85 * vista)));
  const band = (upper: number[], lower: number[], color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    xs.forEach((x, i) => (i ? ctx.lineTo(x, HORIZON_Y - upper[i]) : ctx.moveTo(x, HORIZON_Y - upper[i])));
    for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], HORIZON_Y - lower[i]);
    ctx.closePath();
    ctx.fill();
  };
  const ground = xs.map(() => -25); // 地平線の下まで伸ばす（地面と回転が違うぶんの隙間を埋める）
  band(farH, ground, "#8aa0b8");
  band(farH, farH.map(h => Math.min(h, 19)), "#e4ebf0"); // 雪（高い所だけ）
  if (vista > 0.05) {
    const lake = 5 * vista;
    band(xs.map(() => lake), ground, "#a9cad4");
    ctx.fillStyle = "#f4f1dc";
    for (let k = 0; k < 14; k++) {
      if (hash(k * 3.1 + Math.floor(time * 1.5)) < 0.5) continue;
      const x = Math.round(wrap(hash(k) * BG_PERIOD - bgShift, BG_PERIOD) - 40);
      if (x < -40 || x > VIEW.width + 40) continue;
      ctx.fillRect(x, Math.round(HORIZON_Y - 1 - hash(k * 7.3) * (lake - 1)), 2, 1);
    }
  }
  // 湖に映る夕日の光の道（見晴らしが開くほど。コマ送りできらめく）
  if (SUMMIT_VIEW_ON && vista > 0.3) {
    const lake = 5 * vista, flick = Math.floor(time * 4);
    for (let row = 0; row < lake - 0.5; row++) {
      const y = Math.round(HORIZON_Y - lake + 1 + row);
      const w = 2 + Math.round(row * 0.8);
      const x = sunX + Math.round((hash(row * 3.7 + flick) * 2 - 1) * 2) - (w >> 1);
      ctx.fillStyle = hash(row * 1.9 + flick) > 0.4 ? "#f2cf7a" : "#ffffff";
      ctx.fillRect(x, y, w, 1);
    }
  }
  band(nearH, ground, "#7a9868");
  band(nearH, nearH.map(h => Math.max(0, h - 1)), "#8eab77");
  ctx.restore();
  // 鳥: ゴールしたら、地平線の木立から群れが飛び立って空へ抜ける（2026-09-25 builder「鳥はゴールしたら飛ぶとか」。前は頂上付近でずっと横切っていた）。
  // 遠景の変換（1.25 倍・回転）の外＝画面の座標で描く。中で描くと 1px がにじんで色の塊に見えた
  if (SUMMIT_VIEW_ON && ride.finished && !stillFriend) {
    ctx.fillStyle = "#3c4046";
    const since = ride.time - ride.finishedAt - LOOK_FROM + 0.3; // Friend が景色の方を向くころに飛び立つ
    for (let b = 0; b < 7; b++) {
      const t = Math.floor((since - hash(b * 3.1) * 0.7) * 12) / 12; // 少しずつずれて飛び立つ・コマ送り
      if (t < 0) continue;
      const dir = hash(b * 5.3) > 0.4 ? 1 : -1;
      const x = Math.round(VIEW.width * (0.35 + 0.3 * hash(b + 0.5)) + dir * (8 + 8 * hash(b * 7.7)) * t);
      const y = Math.round(HORIZON_Y - 2 - 3 * hash(b * 2.3) - (12 + 8 * hash(b * 4.9)) * t + Math.sin(t * 5 + b));
      if (y < -8 || x < -8 || x > VIEW.width + 8) continue;
      const up = (Math.floor(t * 5 + b * 0.37) % 2) === 0;
      ctx.fillRect(x, y, 1, 1);
      ctx.fillRect(x - 1, up ? y - 1 : y, 1, 1); ctx.fillRect(x + 1, up ? y - 1 : y, 1, 1);
      if (up) { ctx.fillRect(x - 2, y - 1, 1, 1); ctx.fillRect(x + 2, y - 1, 1, 1); }
      else { ctx.fillRect(x - 2, y + 1, 1, 1); ctx.fillRect(x + 2, y + 1, 1, 1); }
    }
  }

  // ここから地面と道端のもの。傾けると頭が車体の上で横に動く。低速のふらつきが「横滑り」ではなく
  // 「自分が揺れている」に見えるようにするため（2026-09-23 builder の指摘）。
  // ペダルの揺れ: 踏んだ側へ頭が寄る（rock<0 = 左）。reduced-motion では出さない。
  const rock = stillFriend ? 0 : ride.rock * shakeGain(ride.v, ride.climbView);
  ctx.save();
  ctx.translate(VIEW.width / 2, VIEW.height * 0.62);
  ctx.rotate(roll);
  const headPx = -ride.theta * HEAD_SWAY - rock * CAM_ROCK; // 地面の投影に渡す（奥ほど小さく効く）
  ctx.scale(1.25, 1.25);
  ctx.translate(-VIEW.width / 2, -VIEW.height * 0.62);
  ctx.fillStyle = "#88a06d";
  ctx.fillRect(-40, HORIZON_Y, VIEW.width + 80, VIEW.height + 40);

  // ---- 地面の点。**地面の 2m 刻み（world）に固定**。先頭だけカメラ位置（dz=0）
  const first = Math.floor(ride.s / BAND);
  const points: GroundPoint[] = [];
  // 道の中心線は向きを積分して sin/cos で置く＝本物の円弧（2026-09-23）。
  // それまでは「奥行き＝道のり、横ずれ＝曲率の2回積分」の近似で、半径 29m の急カーブが
  // 前へゆるく曲がる道に見えていた（builder「カーブであんまり曲がってる気がしない」）。
  // 向きが VIEW_TURN_MAX を超えた先は描かない（真横〜後ろへ回り込む道は奥行きが減って描画順が崩れるため）。
  // 横方向の幅（道幅・川・草むら）は画面の横にだけ取る近似のまま。
  const VIEW_TURN_MAX = 1.35;   // rad（約77度）
  {
    let heading = 0, offsetX = 0, forward = 0, offsetY = 0, previous = 0;
    points.push({ ...project(0, 0, 0, ride.x, ride.psi, headPx, lookPx), dz: 0, world: first, offsetX: 0, offsetY: 0, forward: 0 });
    for (let i = 1; i <= SEGMENT_COUNT + 1; i++) {
      const world = first + i;
      const dz = world * BAND - ride.s;
      const run = dz - previous;
      const turn = curvatureAt(ride.s + previous + run / 2) * run;
      const mid = heading + turn / 2;
      heading += turn;
      if (Math.abs(heading) > VIEW_TURN_MAX) break;
      offsetX += Math.sin(mid) * run;
      forward += Math.cos(mid) * run;
      offsetY += gradeAt(ride.s + previous + run / 2) * run;
      previous = dz;
      points.push({ ...project(offsetX, offsetY, forward, ride.x, ride.psi, headPx, lookPx), dz, world, offsetX, offsetY, forward });
    }
  }
  /** 任意の奥行き dz・道の中心からの横位置 lateral(m) の地面を投影する。 */
  const groundAt = (dz: number, lateral: number): Projected | null => {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      if (dz < a.dz || dz > b.dz) continue;
      const t = (dz - a.dz) / (b.dz - a.dz);
      return project(a.offsetX + (b.offsetX - a.offsetX) * t + lateral, a.offsetY + (b.offsetY - a.offsetY) * t,
        a.forward + (b.forward - a.forward) * t, ride.x, ride.psi, headPx, lookPx);
    }
    return null;
  };
  // 横位置 lateral の点を、その帯の近い側・遠い側で投影した x
  const edge = (p: GroundPoint, lateral: number) => p.sx + lateral * p.scale * half;
  const RIVER_NEAR = -(HALF_WIDTH + 1.5), RIVER_FAR = -(HALF_WIDTH + 19.5);
  // 色むらの差は 2026-09-23 に広げた（それまでは隣同士でほぼ同じ色で、速度で流れる速さが読めなかった）。
  // 道は 2色交互（w % 2）をやめ、帯ごとに hash で3段。規則的な縞より、不規則な濃淡のほうが目で追える
  // GROUND_BANDS = false で帯ごとの色むら（＝横縞）を消し、1色にする（2026-09-24 builder「線を消して、ぽつぽつ模様だけで伝わるか」）。
  // 流れはぽつぽつ模様（路面のむら・砂利・草むら・花・川のきらめき）だけで見せる。戻すときは true
  const GROUND_BANDS = false;
  const band3 = (colors: string[], seed: number) => GROUND_BANDS ? colors[Math.floor(hash(seed) * 3)] : colors[0];
  const GRASS = ["#8aa46e", "#9bb27f", "#7f9964"];
  const ROAD = ["#c6b68b", "#d6c9a3", "#bfae84"];
  const WATER = ["#78a4af", "#81acb6", "#739fab"];

  // 見えている帯を「坂の稜線で切れるまで」ひとまとめ（run）にして、素材ごとに1枚の多角形で塗る（2026-09-24）。
  // 帯ごとに四角形を重ねると、縁のぼかしで下の色（草・土の縁）が 1px 混ざって横線になり、重ね幅を増やしても消えなかった。
  // GROUND_BANDS = true（帯ごとに色むら）のときは、帯1本ずつが run になる（従来どおり）
  const runs: GroundPoint[][] = [];
  {
    let run: GroundPoint[] | null = null;
    for (let i = points.length - 1; i > 0; i--) {
      const far = points[i], near = points[i - 1];
      if (far.sy >= near.sy - 0.01 && near.dz > 0) { run = null; continue; } // 坂の裏で見えない帯
      if (!run || GROUND_BANDS) { run = [far]; runs.push(run); }
      run.push(near);
    }
  }
  /** run（奥 → 手前の点の列）の、横位置 left〜right の地面を1枚で塗る。river = true なら川のずれ（riverShift）を足す */
  const strip = (run: GroundPoint[], left: number, right: number, river = false) => {
    const shift = (q: GroundPoint) => (river ? riverShift(q.world * BAND) : 0);
    ctx.beginPath();
    run.forEach((q, k) => (k ? ctx.lineTo(edge(q, left + shift(q)), q.sy) : ctx.moveTo(edge(q, left + shift(q)), q.sy - 0.75)));
    for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(edge(run[k], right + shift(run[k])), k ? run[k].sy : run[k].sy - 0.75);
    ctx.closePath();
    ctx.fill();
  };
  for (const run of runs) {
    const w = run[run.length - 1].world; // run の手前の帯の地面上の番号（色むらありのときの色）
    // 草（画面の横幅いっぱい。川と道はこの上に重ねる）
    ctx.fillStyle = band3(GRASS, w * 0.71);
    strip(run, -80, 80);
    // 川
    ctx.fillStyle = band3(WATER, w * 1.37);
    strip(run, RIVER_FAR, RIVER_NEAR, true);
    ctx.fillStyle = "#6b8f86"; // 岸
    strip(run, RIVER_NEAR - 0.35, RIVER_NEAR, true);
    // 道（土の縁 → 路面）
    ctx.fillStyle = "#a8966c";
    strip(run, -HALF_WIDTH - 0.3, HALF_WIDTH + 0.3);
    ctx.fillStyle = band3(ROAD, w * 2.43);
    strip(run, -HALF_WIDTH, HALF_WIDTH);
    // 轍（道の縦線）は 2026-09-23 に外した（builder「デザイン的に微妙」）。流れは路面のむらで見せる
  }

  // ---- 谷底の橋: 小川（道を横切る水）と板の橋。坂の向こうに隠れる所は手前の稜線で切る
  {
    const ridgeAbove = (dz: number) => { let y = Infinity; for (const q of points) { if (q.dz >= dz) break; y = Math.min(y, q.sy); } return y; };
    /** 奥行き dzFar〜dzNear、横位置 left〜right の地面を 4 点の多角形で塗る */
    const quad = (dzFar: number, dzNear: number, left: number, right: number) => {
      const a = groundAt(dzFar, left), b = groundAt(dzFar, right), c = groundAt(dzNear, right), d = groundAt(dzNear, left);
      if (!a || !b || !c || !d) return;
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.lineTo(c.sx, c.sy); ctx.lineTo(d.sx, d.sy); ctx.closePath(); ctx.fill();
    };
    const near0 = BRIDGE_AT - BRIDGE_DECK - ride.s, far1 = BRIDGE_AT + BRIDGE_WATER + BRIDGE_DECK - ride.s;
    const dzA = Math.max(0.6, BRIDGE_AT - ride.s), dzB = BRIDGE_AT + BRIDGE_WATER - ride.s;
    if (far1 > 0.6 && near0 < DRAW_DISTANCE - 2) {
      const ridge = ridgeAbove(Math.max(0.6, near0));
      ctx.save();
      if (ridge < Infinity) { ctx.beginPath(); ctx.rect(-100, -100, VIEW.width + 200, ridge + 100); ctx.clip(); }
      if (dzB > 0.6) {
        // 道の下と左（左の川につながる）はまっすぐ。右は奥へ曲がりながら細くなる（前は右の端までまっすぐで水路に見えた）
        const reach = (x: number) => Math.max(0, x - (HALF_WIDTH + 1));
        const centre = (x: number) => BRIDGE_AT + BRIDGE_WATER / 2 + reach(x) * 0.9 + Math.sin(reach(x) * 0.22) * 3 - ride.s;
        const width = (x: number) => BRIDGE_WATER * (1 - 0.55 * Math.min(1, reach(x) / 30));
        // 水は左の川の岸（RIVER_NEAR − 0.35m）の外まで塗る。前は RIVER_NEAR − 0.1 までで、岸の残り 0.25m が水の上に斜めの線で残り、
        // 色を丸めると草の色になって「橋の左の川に緑の点線」に見えた（2026-09-28）。小川の岸（bank > 0）は川の上に出ないよう今のまま
        const band = (bank: number) => {
          const xs = [bank > 0 ? RIVER_NEAR - 0.1 : RIVER_NEAR - 0.5, HALF_WIDTH + 1];
          for (let x = HALF_WIDTH + 4; x <= HALF_WIDTH + 40; x += 3) xs.push(x);
          for (let k = 0; k < xs.length - 1; k++) {
            const x0 = xs[k], x1 = xs[k + 1];
            const c0 = centre(x0), c1 = centre(x1), w0 = width(x0) / 2 + bank, w1 = width(x1) / 2 + bank;
            const pts = [groundAt(c0 + w0, x0), groundAt(c1 + w1, x1), groundAt(Math.max(0.6, c1 - w1), x1), groundAt(Math.max(0.6, c0 - w0), x0)];
            if (pts.some(q => !q) || c1 + w1 < 0.6) continue;
            ctx.beginPath();
            pts.forEach((q, n) => (n ? ctx.lineTo(q!.sx, q!.sy) : ctx.moveTo(q!.sx, q!.sy)));
            ctx.closePath(); ctx.fill();
          }
        };
        ctx.fillStyle = "#6b8f86"; band(0.5); // 岸
        ctx.fillStyle = "#78a4af"; band(0);   // 水
      }
      // 板の橋（道の幅いっぱい）と、板の継ぎ目（0.6m おき）
      const deckNear = Math.max(0.6, near0), deckFar = Math.min(DRAW_DISTANCE - 2, far1);
      ctx.fillStyle = "#857658";
      quad(deckFar, deckNear, -HALF_WIDTH - 0.3, HALF_WIDTH + 0.3);
      ctx.fillStyle = "#9a8a6c";
      quad(deckFar, deckNear, -HALF_WIDTH, HALF_WIDTH);
      ctx.fillStyle = "#857658";
      for (let at = Math.ceil((ride.s + deckNear) / 0.6) * 0.6; at < ride.s + deckFar && at - ride.s < 45; at += 0.6) {
        const l = groundAt(at - ride.s, -HALF_WIDTH), r = groundAt(at - ride.s, HALF_WIDTH);
        if (l && r) ctx.fillRect(Math.round(l.sx), Math.round(l.sy), Math.max(1, Math.round(r.sx - l.sx)), 1);
      }
      ctx.restore();
    }
  }

  // ---- ゴールの点線（路面・ライム。坂の向こうでは手前の稜線で切る）
  if (GOAL_MARK_ON && GOAL_AT - ride.s > 0.8 && GOAL_AT - ride.s < DRAW_DISTANCE - 2) {
    const dz = GOAL_AT - ride.s;
    let ridge = Infinity;
    for (const q of points) { if (q.dz >= dz) break; ridge = Math.min(ridge, q.sy); }
    ctx.save();
    if (ridge < Infinity) { ctx.beginPath(); ctx.rect(-100, -100, VIEW.width + 200, ridge + 100); ctx.clip(); }
    for (let lateral = -HALF_WIDTH + 0.25; lateral < HALF_WIDTH; lateral += 0.5) {
      const p = groundAt(dz, lateral);
      if (!p) continue;
      const size = Math.max(1, Math.round(0.25 * p.scale * half));
      ctx.fillStyle = "#cdef3c";
      ctx.fillRect(Math.round(p.sx) - (size >> 1), Math.round(p.sy) - (size >> 1), size, Math.max(1, size >> 1));
    }
    ctx.restore();
  }

  // ---- 地面の細かい模様（近い帯だけ。奥は潰れて1px未満になるので描かない）
  for (let i = points.length - 1; i > 0; i--) {
    const far = points[i], near = points[i - 1];
    if (near.dz > 45 || far.sy >= near.sy) continue;
    // 手前の稜線より下に来るもの（坂の向こう）は描かない。木と同じ理由
    let ridgeY = Infinity;
    for (let j = 0; j < i - 1; j++) ridgeY = Math.min(ridgeY, points[j].sy);
    if (far.sy >= ridgeY) continue;
    const w = near.world;
    const at = (u: number, lateral: number) => {
      const x = edge(far, lateral) + (edge(near, lateral) - edge(far, lateral)) * u;
      return [Math.round(x), Math.round(far.sy + (near.sy - far.sy) * u)] as const;
    };
    const bridge = onBridge(w * BAND) || onBridge((w + 1) * BAND); // 橋の上には路面のむら・砂利・草むらを描かない
    const river = riverShift(w * BAND);
    // 地面の横縞を消したので、流れはこの ぽつぽつ模様 だけで見せる（2026-09-24 に量を増やし、白っぽい色をやめて地味な色に）
    // 路面のむら（踏み固まった跡。帯ごとに最大2つ・各30%。大きさは地面の寸法で持つ＝近づくほど大きく速く流れる）
    // 2026-09-24 夜 builder「大きい四角は違和感」→ 大きさ 0.6〜1.1m → 0.3〜0.55m、確率 各65% → 各30%
    for (let k = 0; k < (bridge ? 0 : 2); k++) {
      if (hash(w * 6.7 + k * 3.3) < 0.7) continue;
      const [x, y] = at(hash(w * 8.9 + k), (hash(w * 4.1 + k * 2.7) * 2 - 1) * (HALF_WIDTH - 0.6));
      // 明るい色のむらは「浮いた板」に見えたので暗い方だけ（2026-09-23）
      const pw = Math.max(1, Math.round((0.3 + 0.25 * hash(w * 5.3 + k)) * near.scale * half)), ph = Math.max(1, Math.round(pw * 0.25));
      ctx.fillStyle = k ? "#bba981" : "#b3a176";
      ctx.fillRect(x - (pw >> 1), y, pw, ph);
    }
    // 砂利（奥は細かすぎてゴチャつくので近くだけ。前は 25m 以内に 3 つ・白っぽい色も混ぜていた）
    const grain = Math.max(1, Math.round(0.06 * near.scale * half));
    for (let k = 0; k < (near.dz < 35 && !bridge ? 6 : 0); k++) {
      const [x, y] = at(hash(w * 7.7 + k), (hash(w * 3.3 + k * 1.9) * 2 - 1) * HALF_WIDTH);
      ctx.fillStyle = ["#ad9c74", "#a39168", "#b9a882"][k % 3];
      ctx.fillRect(x, y, grain, grain);
    }
    // 草の色むら（道の両側。地味な緑の点）
    for (let k = 0; k < (near.dz < 35 && !bridge ? 4 : 0); k++) {
      const lateral = k % 2 ? HALF_WIDTH + 0.4 + hash(w * 9.7 + k) * 8 : -(HALF_WIDTH + 0.4 + hash(w * 9.7 + k) * 1);
      const [x, y] = at(hash(w * 12.1 + k), lateral);
      ctx.fillStyle = k % 3 ? "#7d975f" : "#93ab77";
      ctx.fillRect(x, y, Math.max(1, grain * 2), grain);
    }
    // 草むら（道の右・川との間・対岸）と、たまに花
    const size = Math.max(1, Math.round(0.22 * near.scale * half));
    const tufts: number[] = [
      HALF_WIDTH + 0.8 + hash(w * 2.1) * 3, HALF_WIDTH + 4 + hash(w * 2.7) * 9,
      -(HALF_WIDTH + 0.4 + hash(w * 4.9) * 0.8), RIVER_FAR - 1 - hash(w * 6.1) * 8 + river,
    ];
    if (!bridge) tufts.forEach((lateral, k) => {
      const [x, y] = at(hash(w * 9.1 + k), lateral);
      ctx.fillStyle = "#6f8a58";
      ctx.fillRect(x, y - size, 1, size);
      if (size > 1) { ctx.fillRect(x - 1, y - size + 1, 1, size - 1); ctx.fillRect(x + 1, y - size + 1, 1, size - 1); }
      if (hash(w * 11.3 + k) > 0.8) {
        ctx.fillStyle = hash(w + k) > 0.5 ? "#f3efe0" : "#f0cf5a";
        ctx.fillRect(x + 1, y - size - 1, 1, 1);
      }
    });
    // 水面のきらめき（場所は地面に固定。点いたり消えたりだけ）
    for (let k = 0; k < 2; k++) {
      if (hash(w * 13.7 + k + Math.floor(time * 2 + hash(w + k) * 7)) < 0.75) continue;
      const [x, y] = at(hash(w * 5.9 + k), RIVER_FAR + 2 + hash(w * 8.3 + k) * 14 + river);
      ctx.fillStyle = "#a9cdd3";
      ctx.fillRect(x, y, Math.max(1, Math.round(0.4 * near.scale * half)), 1);
    }
  }

  // ---- 道端のもの（木・葦・対岸の木立）。地面の位置に固定し、奥から手前へ描く
  const props: Prop[] = [];
  /** 奥行き dz・根元の画面 y が baseY の物を積む。坂の向こうの物は手前の稜線より上だけ描く */
  const addProp = (dz: number, baseY: number, paint: () => void) => {
    // 手前の地面が作る稜線（それより手前の点の最も高い画面 y）。
    // これが無いと、短い登りの頂上で向こうの木の根元が手前の地面に透けて見えた（2026-09-23 builder）
    let ridgeY = Infinity;
    for (const q of points) { if (q.dz >= dz) break; ridgeY = Math.min(ridgeY, q.sy); }
    props.push({ dz, paint: () => {
      if (ridgeY >= baseY) { paint(); return; }
      ctx.save();
      ctx.beginPath(); ctx.rect(-100, -100, VIEW.width + 200, ridgeY + 100); ctx.clip();
      paint();
      ctx.restore();
    } });
  };
  const place = (spacing: number, salt: number, keep: number, lateral: (k: number) => number,
    paint: (p: Projected, k: number) => void, openSummit = false) => {
    for (let k = Math.floor(ride.s / spacing); k * spacing < ride.s + DRAW_DISTANCE; k++) {
      if (hash(k * 1.31 + salt) > keep) continue;
      if (openSummit && SUMMIT_VIEW_ON && Math.abs(k * spacing - VISTA_FULL) < SUMMIT_OPEN) continue;
      const dz = k * spacing + hash(k * 2.17 + salt) * spacing * 0.6 - ride.s;
      if (dz < 1.5 || dz > DRAW_DISTANCE - 2) continue;
      if (ride.s + dz > BRIDGE_AT - 2 && ride.s + dz < BRIDGE_AT + BRIDGE_WATER + 2) continue; // 小川の上には植えない
      const p = groundAt(dz, lateral(k));
      if (!p) continue;
      addProp(dz, p.sy, () => paint(p, k));
    }
  };
  const tree = (p: Projected, k: number, height: number, dark: string, light: string) => {
    const m = p.scale * half; // 1m の px
    const h = height * m, cw = Math.max(1, Math.round(h * 0.55));
    const x = Math.round(p.sx), y = Math.round(p.sy);
    if (h < 2.5) { ctx.fillStyle = dark; ctx.fillRect(x - 1, y - Math.round(h), Math.max(1, cw), Math.max(1, Math.round(h))); return; }
    ctx.fillStyle = "#6b5a3c";
    ctx.fillRect(x - Math.max(1, Math.round(0.08 * h)), y - Math.round(h * 0.4), Math.max(1, Math.round(0.16 * h)), Math.round(h * 0.4));
    const top = y - Math.round(h);
    ctx.fillStyle = dark;
    ctx.fillRect(x - Math.round(cw / 2), top + Math.round(h * 0.12), cw, Math.round(h * 0.55));
    ctx.fillRect(x - Math.round(cw * 0.35), top, Math.round(cw * 0.7), Math.round(h * 0.75));
    ctx.fillStyle = light;
    ctx.fillRect(x - Math.round(cw * 0.3), top + Math.round(h * 0.08), Math.max(1, Math.round(cw * 0.35)), Math.max(1, Math.round(h * 0.25)));
    if (hash(k) > 0.5 && h > 8) {
      ctx.fillStyle = "#3f5d45";
      ctx.fillRect(x + Math.round(cw * 0.1), top + Math.round(h * 0.45), Math.round(cw * 0.35), Math.max(1, Math.round(h * 0.15)));
    }
  };
  place(11, 0.1, 0.78, k => HALF_WIDTH + 2.2 + hash(k * 3.7) * 7,
    (p, k) => tree(p, k, 4 + hash(k * 5.1) * 2.5, "#4e6f50", "#6a8d5e"), true);
  place(9, 0.6, 0.7, k => RIVER_FAR - 3 - hash(k * 4.3) * 10 + riverShift(k * 9),
    (p, k) => tree(p, k, 5 + hash(k * 6.7) * 3, "#56745a", "#6f8f68"));
  // 川が離れている所（登り）の左側の木。川のそばには植えない・頂上の見晴らしの前後は植えない
  place(12, 0.35, 0.7, k => -(HALF_WIDTH + 2.5 + hash(k * 2.3) * 8), (p, k) => {
    if (riverShift(k * 12) > -25) return;
    tree(p, k, 4 + hash(k * 3.9) * 2.5, "#4e6f50", "#6a8d5e");
  }, true);
  place(5, 0.9, 0.35, () => -(HALF_WIDTH + 1.1), (p, k) => {
    if (riverShift(k * 5) < -8) return; // 葦は川辺だけ
    const m = p.scale * half, h = Math.max(1, Math.round(1.1 * m));
    const x = Math.round(p.sx), y = Math.round(p.sy);
    ctx.fillStyle = "#7d8f55";
    for (let r = -1; r <= 1; r++) ctx.fillRect(x + r * Math.max(1, Math.round(m * 0.25)), y - h + Math.abs(r), 1, h - Math.abs(r));
    if (h > 3 && hash(k * 2.9) > 0.5) { ctx.fillStyle = "#8a6a3e"; ctx.fillRect(x, y - h - 1, 1, 2); }
  });
  // 2026-09-25: ゴールにチェッカーの横断幕を立てたが、builder「いらない」で外した（紙吹雪も）
  // ゴールのコイン（道の真ん中の上に浮かぶ。コマ送りで上下に 1 ドットふわふわ）。
  // 遠近感: 1 ドット = 1px の小さな画像を、距離どおりの大きさ（小数）で補間なしに貼る（最低 1px に丸めると遠くで大きすぎた）
  const goalDz = GOAL_AT - ride.s;
  if (GOAL_MARK_ON && ride.coinState !== 1 && goalDz > 1.5 && goalDz < DRAW_DISTANCE - 2) {
    const p = groundAt(goalDz, 0);
    const face = spriteFrame(sprites, "down", false, 0, "right").frame.rows;
    if (p) addProp(goalDz, p.sy, () => {
      const coin = goalCoin(face);
      // 近くで 1 ドットが 1px を超えたら整数倍に丸める（小数倍だと輪がガタガタになった）。遠くは距離どおり（最低 1px に丸めない）
      const m = p.scale * half, dotPx = GOAL_COIN_CELL * m, dot = dotPx >= 1 ? Math.round(dotPx) : dotPx;
      const size = coin.width * dot;
      const bob = (Math.floor(ride.time * 3) % 2) * 2 * dot; // 1/3 秒ごとに 2 ドット上下
      const left = Math.round(p.sx - size / 2), top = Math.round(p.sy - GOAL_COIN_LIFT * m - size - bob);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(coin, left, top, Math.max(1, Math.round(size)), Math.max(1, Math.round(size)));
      // 取った演出はここから始める。景色の変換（回転・1.25 倍・前後傾）をかけて画面の座標で覚える
      const tr = ctx.getTransform(), centre = tr.transformPoint(new DOMPoint(left + size / 2, top + size / 2));
      ride.coinRect = { x: centre.x, y: centre.y, size: size * Math.hypot(tr.a, tr.b) };
    });
  }
  // 橋の手すり（柱＋上の横木。横木は 1 本奥の柱の頭とつなぐ）
  for (const side of [-1, 1]) {
    const lateral = side * (HALF_WIDTH + 0.15);
    for (let at = BRIDGE_AT - BRIDGE_DECK; at <= BRIDGE_AT + BRIDGE_WATER + BRIDGE_DECK + 0.01; at += BRIDGE_POST) {
      const dz = at - ride.s;
      if (dz < 1 || dz > DRAW_DISTANCE - 2) continue;
      const p = groundAt(dz, lateral);
      if (!p) continue;
      const farther = at + BRIDGE_POST <= BRIDGE_AT + BRIDGE_WATER + BRIDGE_DECK + 0.01 ? groundAt(dz + BRIDGE_POST, lateral) : null;
      addProp(dz, p.sy, () => {
        const m = p.scale * half, h = Math.max(1, Math.round(BRIDGE_RAIL * m)), w = Math.max(1, Math.round(0.12 * m));
        const x = Math.round(p.sx), y = Math.round(p.sy);
        ctx.fillStyle = "#6b5a3c";
        ctx.fillRect(x - (w >> 1), y - h, w, h);
        if (farther) {
          const fh = BRIDGE_RAIL * farther.scale * half, fx = farther.sx, fy = farther.sy - fh;
          const steps = Math.max(1, Math.round(Math.abs(fx - x)));
          ctx.fillStyle = "#857658";
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            ctx.fillRect(Math.round(x + (fx - x) * t), Math.round(y - h + (fy - (y - h)) * t), 1, Math.max(1, Math.round(w * (1 - t) + 1 * t)));
          }
        }
      });
    }
  }
  // 2026-09-24: 道の縁の杭と、急カーブ外側のガードレール・矢印板をいったん入れたが、
  // 「不自然で爽快感がなくなる」（builder）で外した。急カーブの注意は、あとでポップアップ等で出すかもしれない
  props.sort((a, b) => b.dz - a.dz).forEach(prop => prop.paint());
  ctx.restore();
  ctx.restore(); // 前後傾

  // 速度線（画面の端だけ。自転車（カゴのあたり）を中心に、外から集まる集中線。コマ送りで出し直す）
  if (SPEED_LINES_ON && !stillFriend && ride.v > SPEED_LINES_FROM && ride.falling <= 0) {
    const k = clamp((ride.v - SPEED_LINES_FROM) / (SPEED_LINES_FULL - SPEED_LINES_FROM), 0, 1);
    const slot = Math.floor(ride.time / SPEED_LINES_STEP);
    const cx = VIEW.width / 2, cy = VIEW.height - clearance - 28; // カゴのあたり
    ctx.fillStyle = "#f4f1e4";
    for (let i = 0; i < Math.max(1, Math.round(SPEED_LINES_MAX * k)); i++) {
      const a = Math.PI + hash(slot * 7.1 + i * 1.7) * Math.PI; // 上半分（下はハンドルとボタン）
      const dx = Math.cos(a), dy = Math.sin(a);
      // 画面の端まで伸ばした線の、外側の 1/5 くらいだけ描く
      const toEdge = Math.min(dx ? Math.abs((dx > 0 ? VIEW.width - cx : cx) / dx) : Infinity, dy ? Math.abs(cy / dy) : Infinity);
      const len = toEdge * (0.12 + 0.1 * k * hash(i * 5.1 + slot));
      for (let r = toEdge - len; r < toEdge; r += 0.7) {
        const x = Math.round(cx + dx * r), y = Math.round(cy + dy * r);
        if (x < 0 || x >= VIEW.width || y < 0 || y >= VIEW.height) break;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  // baseY は「車体の基準線」。バーの最下端が clearance 線より上に来るように持ち上げる。
  //   グリップの下端 = baseY + 8
  //   傾いたときの沈み込み = 中心から 48px の端が twist だけ回るので 48*sin(θ*BAR_TWIST)
  //   twist は TWIST_DRAW_MAX で頭打ちにするので 48*sin(0.22) ≈ 10.5px
  // 合計 18.5px。余裕を足して 20px 上げる。
  // （2026-09-23: ハンドルを傾けるようにした結果、水平前提の 9px では端が toolbar に入った。
  //   同日、高速で THETA_EASE を足し、さらに traits.balance が最大 1.4 倍まで振れるので、
  //   上限から逆算せず描画側で頭打ちにした）
  const baseY = VIEW.height - clearance - 20;
  const mid = VIEW.width / 2;

  // ハンドルバーとカゴは1つの車体。**同じ変換で動かす。**
  // 2026-09-23 まではハンドルが画面固定でカゴだけ揺れており、
  // 「車体が入力に何も反応しない」＝自転車に見えない最大の原因になっていた。
  const sway = stillFriend ? 0 : Math.round(Math.sin(ride.time * 6.5) * clamp(ride.v / 8, 0, 1));
  const twist = clamp(ride.theta * BAR_TWIST, -TWIST_DRAW_MAX, TWIST_DRAW_MAX);
  const bodyX = mid + ride.theta * BAR_SWING;

  // カゴはハンドルバーに付いているので、同じ bodyX / twist に乗せる。
  // ハンドルより先に描く＝ハンドルがカゴの手前を横切る（カゴはハンドルの下まで伸びている）
  const lean = stillFriend ? 0 : twist;
  const basketX = Math.round(stillFriend ? mid : bodyX), basketY = Math.round(baseY - 5 + sway); // カゴの縁（-12 → -5 でカゴと Friend ごと 7px 下げた・2026-09-23）
  // Friend の状態: 転倒中は飛び出している／再開直後は上から戻る／頂上では跳ねる／それ以外は座っている
  const flight = !stillFriend && ride.falling > 0 ? FALL_TIME - ride.falling : -1;
  const cheer = !stillFriend && ride.finished && ride.cheerAt >= 0 ? ride.time - ride.cheerAt : -1;
  const intro = INTRO_ON && !stillFriend && ride.introT >= 0 ? Math.floor(ride.introT / INTRO_STEP) * INTRO_STEP : -1;
  const excited = EXCITED_ON && !stillFriend && !ride.finished && ride.falling <= 0 && ride.v >= EXCITED_V;
  const joyT = JOY_ON && !stillFriend && !ride.finished ? Math.floor((ride.time - ride.joyAt) * 12) / 12 : -1; // コマ送り 1/12 秒
  const joyful = joyT >= 0 && joyT < JOY_LEN;
  // 小さな反応（ゴール・飛び出し・スタート・再開の最中は出さない）
  const alive = FRIEND_REACT_ON && !stillFriend && !ride.finished && flight < 0 && cheer < 0 && intro < 0 && ride.remount <= 0;
  const warn = DANGER_ON && !stillFriend && flight < 0 && !ride.finished && ride.danger > DANGER_FROM;
  const pushing = POWER_PUSH_ON && alive && type === "power" && !ride.footDown && gradeAt(ride.s) >= PUSH_GRADE;
  const shakeT = ride.time - ride.shakeAt;
  const shake = SHAKE_ON && alive && shakeT >= 0 && shakeT < SHAKE_LEN ? shakeT : -1;
  let react: "down" | "left" | "right" | "up" = "down";
  let reactDy = 0, reactDx = 0;
  if (alive) {
    const tired = ride.stamina < STAMINA_LOW && !ride.footDown;
    if (warn) react = ride.theta > 0 ? "right" : "left"; // 倒れる側を横目で見る（θ > 0 が右）
    else if (tired) {
      // スタミナ切れ: 正面で左右に揺れながら跳ねて応援（コマ送り 1/12 秒）
      const t = Math.floor(ride.time * 12) / 12;
      reactDy -= Math.round(Math.abs(Math.sin(t * CHEER_UP_RATE * Math.PI)) * CHEER_UP_HOP);
      reactDx = Math.floor(t * CHEER_UP_RATE * 2) % 2 ? 1 : -1;
    } else if (joyful) {
      // スピードで喜ぶ: こっちを向いて 2 回跳ねる
      reactDy -= Math.round(Math.abs(Math.sin(joyT / JOY_LEN * 2 * Math.PI)) * JOY_HOP);
    } else if (LOOK_FWD_ON && ride.time - ride.fwdAt < LOOK_FWD_LEN) {
      // ときどき前を向く（横 → 後ろ → 横。コマ送り）
      const q = ride.time - ride.fwdAt;
      react = q < TURN_STEP || q >= LOOK_FWD_LEN - TURN_STEP ? "right" : "up";
    } else if (ride.footDown && ride.stillTime > LOOK_AROUND_AFTER) {
      react = (["left", "down", "right", "down"] as const)[Math.floor((ride.stillTime - LOOK_AROUND_AFTER) / LOOK_STEP) % 4];
    } else if (ride.s > BRIDGE_AT - 6 && ride.s < BRIDGE_AT + BRIDGE_WATER + 2) react = "right"; // 橋: 右の小川を見る
    const rang = Math.floor((ride.time - ride.bellAt) * 12) / 12;
    if (rang >= 0 && rang < 0.5) reactDy -= Math.round(Math.sin(rang / 0.5 * Math.PI) * BELL_HOP);
    if (ride.braking && ride.v > 3) reactDy -= BRAKE_LURCH;
    if (gradeAt(ride.s) > 0.03 && ride.time - ride.pedalAt < 0.25) reactDy -= 1; // 登り: 踏むたびに小さく弾む
    // バランス型: 傾いた側と反対へ体を寄せる
    const tilt = Math.abs(ride.theta) / THETA_MAX;
    if (COUNTER_LEAN_ON && type === "balance" && tilt >= COUNTER_LEAN_FROM) reactDx -= Math.sign(ride.theta) * (tilt >= COUNTER_LEAN_FULL ? 2 : 1) * COUNTER_LEAN_PX;
    // パワー型: 登りで一緒に踏ん張る（沈む。踏んだ瞬間は上の「弾む」で持ち上がる）
    if (pushing) reactDy += 1;
    // 川に落ちたあと: ぶるぶる（左右に 1px ずつ）
    if (shake >= 0) reactDx += Math.floor(shake * 16) % 2 ? 1 : -1;
  }
  const goalJoy = cheer >= 0 && cheer < GOAL_JOY;
  const facing = cheer < 0 ? react : goalJoy ? "down" : cheer < LOOK_FROM ? "right" : cheer < LOOK_UNTIL ? "up"
    : cheer < HOP_FROM ? "left" : "down";
  const hopping = cheer >= HOP_FROM || goalJoy;
  const rows = spriteFrame(sprites, facing, hopping || excited || (alive && joyful), stillFriend ? 0 : frame, facing === "left" ? "left" : "right").frame.rows;
  const cheerStep = Math.floor((goalJoy ? cheer : cheer - HOP_FROM) / CHEER_STEP) * CHEER_STEP;
  let friendDy = cheer >= 0
    ? hopping ? -Math.round(Math.abs(Math.sin(cheerStep * (goalJoy ? 1 / GOAL_JOY : CHEER_PER_SECOND) * Math.PI)) * CHEER_HOP / CHEER_PX) * CHEER_PX : 0
    : !stillFriend && ride.remount > 0 ? -((ride.remount / REMOUNT_TIME) ** 2) * REMOUNT_HEIGHT
    : excited ? -(Math.floor(ride.time * 10) % 2) : 0;
  friendDy += reactDy;
  let friendDx = reactDx;
  // スタートの演出: 歩いてくる間はカゴは空（Friend はカゴより奥に描く）。飛び乗る間はカゴの中の Friend をずらす
  const walking = intro >= 0 && intro < INTRO_WALK;
  if (intro >= INTRO_WALK) {
    const p = clamp((intro - INTRO_WALK) / INTRO_HOP, 0, 1);
    const startDy = INTRO_GROUND_Y - (basketY + FRIEND_SUNK);
    friendDx = INTRO_LAND_DX * (1 - p);
    friendDy = startDy * (1 - p) - 4 * INTRO_HOP_PEAK * p * (1 - p);
  }
  if (walking) {
    const p = intro / INTRO_WALK;
    const walk = spriteFrame(sprites, "left", true, Math.floor(intro / 0.1) % 8, "left").frame.rows;
    const w = (walk[0]?.length ?? 16) * FRIEND_DOT, h = walk.length * FRIEND_DOT;
    const fx = Math.round(VIEW.width + w / 2 + (basketX + INTRO_LAND_DX - VIEW.width - w / 2) * p);
    paintFriend(ctx, walk, fx - (w >> 1), INTRO_GROUND_Y - h);
  }
  // 目（まばたき・見開く）とヘルメット。ヘルメットは HELMET_FALLS 回目に転んで、カゴに戻ったときから
  const blinkK = Math.floor(ride.time / BLINK_EVERY), blinkAt = blinkK * BLINK_EVERY + hash(blinkK * 7.3) * BLINK_JITTER;
  const blinking = BLINK_ON && ride.time >= blinkAt && ride.time < blinkAt + BLINK_LEN;
  const friendLook: FriendLook = {
    eyes: stillFriend ? "open" : WIDE_EYES_ON && (warn || flight >= 0) ? "wide" : blinking ? "closed" : "open",
    helmet: HELMET_ON && (ride.falls > HELMET_FALLS || (ride.falls === HELMET_FALLS && ride.falling <= 0)),
  };
  paintRotatedCrisp(ctx, basketX, basketY, lean, layer =>
    paintBasketAndFriend(layer, flight >= 0 || walking ? null : rows, basketX, basketY, friendDy, friendDx, friendLook));

  paintRotatedCrisp(ctx, bodyX, baseY, twist, ctx => {
    // ハンドルの前後: 踏んだ側のグリップを手前に引き、反対側が前へ出る。
    // 前に出た端は遠くなる＝画面では上がる。**上げる方向だけ**にして、
    // 手前側を下げない（下げると baseY の余白＝toolbar との距離を食うため）。
    const push = clamp(rock, -1, 1);
    // ハンドル操作: 右へ切ると右グリップが手前（外へ・大きく）、左グリップが奥（上へ・内へ）。左はその逆
    const turn = stillFriend ? 0 : clamp(ride.steerView, -1, 1);
    const leftUp = Math.max(0, push) * BAR_YAW + Math.max(0, turn) * STEER_BAR_UP;
    const rightUp = Math.max(0, -push) * BAR_YAW + Math.max(0, -turn) * STEER_BAR_UP;
    const leftX = -turn * STEER_BAR_IN, rightX = -turn * STEER_BAR_IN; // 右へ切る＝両端とも左へ（左は内へ・右は外へ）
    const leftGrow = Math.round(Math.max(0, -turn) * STEER_BAR_GROW), rightGrow = Math.round(Math.max(0, turn) * STEER_BAR_GROW);
    // バー本体: 2次ベジェの上に 1×3 のドットを並べる（stroke だと縁がぼける）
    const x0 = bodyX - 42 + leftX, y0 = baseY + 5 - leftUp, x1 = bodyX + 42 + rightX, y1 = baseY + 5 - rightUp;
    ctx.fillStyle = "#3c4046";
    for (let i = 0; i <= 160; i++) {
      const t = i / 160, u = 1 - t;
      ctx.fillRect(Math.round(u * u * x0 + 2 * u * t * bodyX + t * t * x1), Math.round(u * u * y0 + 2 * u * t * (baseY - 4) + t * t * y1 - 1.5), 1, 3);
    }
    // グリップ（握っている手前側の端。細い線1本だと奥行きが読めなかったため）
    ctx.fillStyle = "#23262a";
    ctx.fillRect(Math.round(bodyX - 48 + leftX - leftGrow), Math.round(baseY + 3 - leftUp - leftGrow), 9 + leftGrow, 5 + leftGrow);
    ctx.fillRect(Math.round(bodyX + 39 + rightX), Math.round(baseY + 3 - rightUp - rightGrow), 9 + rightGrow, 5 + rightGrow);
    // 2026-09-25: ブレーキレバー（握ると寄る）とワイヤーも描いていたが、builder「ブレーキ部分なんか変なので消そう」で外した。ベルは残す
    // ステムとヘッドチューブ（2026-09-25 builder「かごの手前に自転車の柱があった方がいい」）。
    // 手前から ハンドル → ステム → ヘッドチューブ → カゴ の順なので、柱はカゴの手前に見える。バー中央の留め具から下へ
    const PART: Record<string, string> = { o: "#22303a", d: "#3c4046", L: "#8aa0b8", H: "#ffffff", M: "#d2e6ee", S: "#8aa0b8", K: "#000000" };
    const stamp = (grid: readonly string[], left: number, top: number) => grid.forEach((row, y) => [...row].forEach((cell, x) => {
      if (!PART[cell]) return;
      ctx.fillStyle = PART[cell];
      ctx.fillRect(left + x, top + y, 1, 1);
    }));
    // 留め具とステムはハンドルと一緒に動き、ヘッドチューブは車体に固定（ハンドルの軸のまわりで上だけが動く）。
    // 2026-09-26 builder「支柱とハンドルの動きがちぐはぐ」: 切ったり踏んだりでバーの真ん中が横・上へずれるのに、支柱を車体の中心に固定していた
    const barMidX = (x0 + 2 * bodyX + x1) / 4, barMidY = (y0 + 2 * (baseY - 4) + y1) / 4; // バーの曲線の真ん中（t = 0.5）
    const clampLeft = Math.round(barMidX) - 4, clampTop = Math.round(barMidY - 3.5);
    stamp([
      "oooooooo", // 留め具（バーを挟む）
      "oLddddLo",
      "oddddddo",
      "oooooooo",
    ], clampLeft, clampTop);
    // ステム: 留め具の下から、ヘッドチューブの上の玉押しまで。横位置は 1 段ずつ留め具 → 車体の中心へ寄せる
    const headTop = Math.round(baseY) + 4, stemFrom = clampTop + 4;
    for (let y = stemFrom; y < headTop; y++) {
      const t = headTop - 1 > stemFrom ? (y - stemFrom) / (headTop - 1 - stemFrom) : 1;
      stamp([".oLddo.."], Math.round(barMidX + (bodyX - barMidX) * t) - 4, y);
    }
    // ヘッドチューブ（玉押し＋画面の下端まで。下の方は少し太く＝下のフレームにつながる。2026-09-26「支柱が短い、下に長く」）
    const TUBE = ["ooooooo."];
    const tubeRows = VIEW.height + 12 - (headTop + 1);
    for (let k = 0; k < tubeRows; k++) TUBE.push(k > tubeRows - 8 ? "oLdddddo" : "oLddddo.");
    stamp(TUBE, Math.round(bodyX) - 4, headTop);
    // ベル（バーの右寄りの上）。ドーム・光・影・縁・バーに留める金具・親指で弾くレバー（2026-09-25 builder「ベルの絵、もうちょっと凝って」）
    const bellT = 0.78, bu = 1 - bellT;
    const bellX = Math.round(bu * bu * x0 + 2 * bu * bellT * bodyX + bellT * bellT * x1);
    const bellY = Math.round(bu * bu * y0 + 2 * bu * bellT * (baseY - 4) + bellT * bellT * y1) - 10;
    // 2026-09-26: 上が尖っていたのをやめ、丸いドームのてっぺんに留めネジの黒い点（欧米でよくある形・builder）
    // 黒い点はドームの頂点に乗せる（2026-09-26 builder「頂点でいいんじゃない」）
    const BELL = [
      ".....KK.....",
      "...oooooo...",
      "..oHMMMMSo..",
      ".oHHMMMMMSo.",
      "oHMMMMMMMSSo",
      "oMMMMMMMSSSo",
      "oLLLLLLLLLLo",
      ".oooooooooo.",
      "dd...od.....",
      "ddd..od.....",
    ];
    stamp(BELL, bellX - 6, bellY + 1);
    // 鳴ったら、ベルの両側に小さな音の線（0.6 秒・コマ送りで 2 段）
    const rang = ride.time - ride.bellAt;
    if (!stillFriend && rang >= 0 && rang < 0.6) {
      const r = rang < 0.3 ? 1 : 2;
      ctx.fillStyle = "#ffffff";
      for (const side of [-1, 1]) {
        const x = bellX + side * (7 + r * 2) - (side < 0 ? 1 : 0);
        ctx.fillRect(x, bellY + 2, 1, 2); ctx.fillRect(x + side, bellY + 4, 1, 2);
      }
    }
  });

  // 転びそうなとき Friend の頭の上に「!」（白い縁取りの黒。点滅はコマ送り）
  if (warn && Math.floor(ride.time * 6) % 2 === 0) {
    const bx = basketX + 18, by = basketY + FRIEND_SUNK - rows.length * FRIEND_DOT - 12 + Math.round(friendDy);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(bx - 1, by - 1, 4, 8); ctx.fillRect(bx - 1, by + 8, 4, 4);
    ctx.fillStyle = "#000000";
    ctx.fillRect(bx, by, 2, 6); ctx.fillRect(bx, by + 9, 2, 2);
  }

  // スピードで喜んだとき、頭の上にライムの音符（黒の縁取り）。右上へ昇って、最後は点滅して消える
  if (alive && joyful && !warn && !(joyT > JOY_LEN - 0.25 && Math.floor(joyT * 12) % 2)) {
    const rise = Math.round(joyT / JOY_LEN * 8);
    const nx = basketX + 12 + (rise >> 1), ny = basketY + FRIEND_SUNK - rows.length * FRIEND_DOT - 10 + Math.round(friendDy) - rise;
    const NOTE = ["..##.", "..#.#", "..#..", "..#..", "###..", "###.."];
    for (const [colour, pad] of [["#22303a", 1], ["#cdef3c", 0]] as const) {
      ctx.fillStyle = colour;
      NOTE.forEach((row, y) => [...row].forEach((cell, x) => {
        if (cell === "#") ctx.fillRect(nx + x - pad, ny + y - pad, 1 + pad * 2, 1 + pad * 2);
      }));
    }
  }

  // 頭の上の記号「?」「♥」（「!」「♪」と同じく、縁取りしたドット）。「!」が出ている間は出さない
  const headY = basketY + FRIEND_SUNK - rows.length * FRIEND_DOT + Math.round(friendDy);
  const stamp = (grid: readonly string[], x: number, y: number, fill: string, edge: string) => {
    for (const [colour, pad] of [[edge, 1], [fill, 0]] as const) {
      ctx.fillStyle = colour;
      grid.forEach((row, gy) => [...row].forEach((cell, gx) => {
        if (cell === "#") ctx.fillRect(x + gx - pad, y + gy - pad, 1 + pad * 2, 1 + pad * 2);
      }));
    }
  };
  if (MARKS_ON && !stillFriend && !warn && flight < 0) {
    const question = alive && ride.footDown && ride.stillTime >= LOOK_AROUND_AFTER && ride.stillTime < LOOK_AROUND_AFTER + QUESTION_LEN;
    const rang = ride.time - ride.bellAt;
    const heart = (alive && ride.footDown && rang >= 0 && rang < HEART_LEN) || goalJoy;
    if (question) stamp([".###.", "#...#", "...#.", "..#..", ".....", "..#.."], basketX + 13, headY - 8, "#ffffff", "#22303a");
    else if (heart) {
      const rise = goalJoy ? 0 : Math.round(rang / HEART_LEN * 4);
      stamp(["##.##", "#####", "#####", ".###.", "..#.."], basketX + 13, headY - 7 - rise, "#e8667f", "#22303a");
    }
  }
  // 鼻歌の音符（頭の左。白・濃紺の縁。HUM_NOTE_EVERY 秒おきに 6px 昇って消える）
  if (HUM_NOTE_ON && ride.humOn && !stillFriend && !warn && flight < 0 && !(alive && joyful)) {
    const q = (ride.time % HUM_NOTE_EVERY) / HUM_NOTE_EVERY;
    if (q < 0.75) stamp(["..#", "..#", "###", "##."], basketX - 20 - Math.round(q * 3), headY - 2 - Math.round(q * 8), "#ffffff", "#22303a");
  }
  // パワー型の汗（頭の右から垂れる。水色＋白い光）
  if (pushing && gradeAt(ride.s) >= PUSH_SWEAT_GRADE) {
    const phase = (ride.time % PUSH_SWEAT_EVERY) / PUSH_SWEAT_EVERY;
    if (phase < 0.6) {
      const y = headY + 6 + Math.round(phase * 10);
      ctx.fillStyle = "#9cc8e4"; ctx.fillRect(basketX + 15, y, 2, 3); ctx.fillRect(basketX + 16, y - 1, 1, 1);
      ctx.fillStyle = "#ffffff"; ctx.fillRect(basketX + 15, y + 1, 1, 1);
    }
  }
  // ぶるぶるで飛ぶ水滴（左右へ 3 粒ずつ、放物線で落ちる）
  if (shake >= 0) {
    ctx.fillStyle = "#9cc8e4";
    for (let k = 0; k < 6; k++) {
      const side = k % 2 ? 1 : -1, t = shake + (k >> 1) * 0.12;
      const x = basketX + side * Math.round(12 + t * (38 + k * 5)), y = headY + 10 + Math.round(-t * 26 + t * t * 70);
      ctx.fillRect(x, y, 2, 2);
    }
  }

  // 飛び出した Friend（転んだ側へ放物線で飛び、回りながら画面の下へ抜ける）。ハンドルより手前に描く
  if (flight >= 0) {
    const side = ride.theta >= 0 ? 1 : -1;
    const w = (rows[0]?.length ?? 16) * FRIEND_DOT, h = rows.length * FRIEND_DOT;
    const fx = basketX + side * FLY_VX * flight;
    const fy = basketY + FRIEND_SUNK - h / 2 - FLY_VY * flight + FLY_G * flight * flight / 2;
    // 回転は 90° ずつのコマ送り（2026-09-25。斜めに回すとドットが崩れて見えた。約 0.3 秒ごとに 1/4 回転）
    const spin = side * Math.round(FLY_SPIN * flight / (Math.PI / 2)) * (Math.PI / 2);
    paintRotatedCrisp(ctx, fx, fy, spin, layer =>
      paintFriend(layer, rows, Math.round(fx - w / 2), Math.round(fy - h / 2), friendLook));
  }

  // コインを取った演出（実時間・コマ送り 1/12 秒）。reduced-motion では出さない
  if (GOAL_MARK_ON && !stillFriend && ride.coinState === 1 && ride.collectReal >= 0 && ride.collectReal < COLLECT_TIME && ride.coinRect) {
    const t = Math.floor(ride.collectReal * 12) / 12;
    const coin = goalCoin(spriteFrame(sprites, "down", false, 0, "right").frame.rows);
    const from = ride.coinRect;
    // 道に浮かんでいた位置・大きさから: ポンと 1.3 倍 → 左上へ飛びながら 0.4 倍へ（真上だと「GOAL」の文字と重なった）
    const pop = t < 0.15 ? 1 + t / 0.15 * 0.3 : 1.3 - (t - 0.15) / (COLLECT_TIME - 0.15) * 0.9;
    const rise = t < 0.15 ? 0 : (t - 0.15) / (COLLECT_TIME - 0.15);
    const cx = from.x + (12 - from.x) * rise, cy = from.y + (-8 - from.y) * rise;
    const size = Math.max(2, Math.round(from.size * pop));
    const squash = Math.abs(Math.cos(t * 14)); // 回っている（横幅が縮む）
    const w = Math.max(2, Math.round(size * (0.25 + 0.75 * squash)));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(coin, Math.round(cx - w / 2), Math.round(cy - size / 2), w, size);
    // キラキラ（8 方向に広がる十字。後半は消えていく）
    const r = 12 + t * 60;
    for (let k = 0; k < 8; k++) {
      if (t > 0.6 && (k + Math.floor(t * 12)) % 2) continue;
      const a = k * Math.PI / 4 + 0.3;
      const x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r * 0.8);
      ctx.fillStyle = k % 2 ? "#cdef3c" : "#ffffff";
      ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y - 1, 1, 3);
    }
  }
}

// ---- 色数を絞る（2026-09-24 builder「色数絞りたい」）------------------------------
// 描き終わった 192×128 を毎フレーム このパレットの一番近い色に丸める。絵ごとに色を直すと取りこぼすので、最後に1回で揃える。
// 縁のぼかし・重ね塗り（夕焼け・太陽の光の輪）の中間色もここで消える（丸める前は 7 地点で約 5000 色）。
// 色を減らしたいときはこの表から消すだけでいい（消した色は残りの一番近い色になる）。PALETTE_ON = false で丸めない
const PALETTE_ON = true;
const PALETTE = [
  "#6fa3d3", "#9cc8e4", "#d2e6ee",                        // 空（濃い・中・地平線近く）
  "#5e7ec1", "#c6a3a1", "#e9bfa9",                        // 夕焼けの空（上・中・地平線近く。夕焼けの3色を昼の空に 0.75 で重ねた色。地平線近くは 2026-09-25 に赤寄りへ #ecd6ae → #e9bfa9）
  "#f2cf7a",                                              // 太陽・花の黄
  "#ffffff", "#f4f1e4",                                   // 白（Friend の縁・雲）・クリーム（UI と同じ）
  "#8aa0b8", "#7ba6b1",                                   // 遠くの山・川と湖
  "#9bb27f", "#8aa46e", "#738f5c",                        // 草（明・中・暗）
  "#587a55", "#3f5d45", "#6b5a3c",                        // 木（明・暗）・幹
  "#d6c9a3", "#c6b68b", "#b3a176", "#a39168",             // 道（明・路面・むら・砂利と縁）
  "#9a8a6c", "#857658",                                   // カゴ（前板・縁と編み目）
  "#3c4046", "#22303a", "#000000",                        // ハンドル・グリップ・Friend
  "#cdef3c",                                              // ゴールの目印（UI の差し色と同じライム・2026-09-26）
  "#e8667f",                                              // Friend の「♥」（2026-09-28）
] as const;
const paletteRgb = PALETTE.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
const palettePacked = paletteRgb.map(([r, g, b]) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0);
const nearestCache = new Map<number, number>();
/** ImageData の 1 画素（リトルエンディアンの ABGR）に一番近いパレットの番号。見た目の差に近づけるため緑を重く量る */
function nearestIndex(abgr: number): number {
  const key = abgr & 0xffffff;
  const hit = nearestCache.get(key);
  if (hit !== undefined) return hit;
  const r = key & 0xff, g = (key >> 8) & 0xff, b = (key >> 16) & 0xff;
  let best = 0, bestDistance = Infinity;
  paletteRgb.forEach(([pr, pg, pb], index) => {
    const distance = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  });
  nearestCache.set(key, best);
  return best;
}

// ---- 白黒から色づく（2026-09-25 試作・builder「最初白黒で、だんだん色付くとか？」）------------------
// 公式の世界（黒と白の 1bit）から始まって、走るほど色が戻る。色の量は
//   ・進んだ距離で少しずつ増えて残る分（ゴールで 1）
//   ・速く走っている間だけ増える分（BLOOM_SPEED_FROM〜FULL m/s で 0〜1。「チャリの爽快感が白黒だと無くなる」への答え）
// の大きいほう。増えるときは BLOOM_RISE 秒、減るときは BLOOM_FALL 秒でなまらせる。
// 色は種類ごとに順番に戻る（塗り絵が埋まっていくように）: 空 → 自転車 → 川 → 草 → 花と太陽 → 山 → 木 → 道 → 夕焼け（頂上の見せ場）。
// （自転車を後にしたら世界だけカラーでカゴが白黒の時間が不自然、山を後にしたら地平線に市松の帯が硬く残ったので前へ）
// 各色は COLOR_ORDER の値を色の量が超えたらカラーになる（前後 BLOOM_BAND のあいだだけ 4×4 のディザで入れ替わる）。
// 最初は全部の色を同時にディザで混ぜていたが、途中が網戸のように濁って、長い登りのあいだずっとそれが続いた
// 白黒はパレットの色ごとに 4×4 の模様を決め打ちにする（Friend と同じ #000 / #fff）。
// 最初は明るさを連続したディザにしたが、画面全体が細かい市松のノイズになって道もカゴも読めなかった
// 2026-09-25 builder「白黒は微妙、没かな（切り替わりに感動が無い・白黒画面が何だかよく分からない・白が多すぎる）」→ オフ。
// コースの作り直しの相談で「最後の下りだけ白黒」案が出ているので、コードは残してある
const COLOR_BLOOM_ON = false;
const BLOOM_SPEED_FROM = 2, BLOOM_SPEED_FULL = 4.5; // m/s（約 7〜16km/h。最初 11〜23km/h にしたら、ふつうに走っている間ずっと色が半端で濁った）
const BLOOM_PROGRESS_POW = 1.5; // 距離の分は 進んだ割合^1.5（前半は白黒寄り）
const BLOOM_RISE = 0.6, BLOOM_FALL = 2.5; // s
const MONO_WHITE = 0xffffffff >>> 0, MONO_BLACK = 0xff000000 >>> 0;
// 4×4 の模様（1 = 黒）。_ 白・. まばらな点・: 市松・= 横線（水）・# ほぼ黒・@ 黒
const MONO_MASKS: Readonly<Record<string, string>> = {
  _: "0000000000000000", ".": "1000000000100000", ":": "1010010110100101",
  "=": "1111000000000000", "#": "1110101111101011", "@": "1111111111111111",
};
// PALETTE と同じ並び
const MONO_OF = [
  ".", "_", "_",          // 空（濃い所だけ点）
  ":", ".", "_",          // 夕焼けの空
  "_",                    // 太陽・花
  "_", "_",               // 白・クリーム
  ":", "=",               // 遠くの山・川と湖
  ".", ".", ":",          // 草
  "#", "@", "@",          // 木・幹
  "_", "_", ".", ":",     // 道（路面は白。むらは点、砂利と縁は市松）
  ":", "#",               // カゴ
  "@", "@", "@",          // ハンドル・グリップ・Friend
  "_",                    // ゴールの目印
];
const monoMask = MONO_OF.map(code => MONO_MASKS[code]);
// PALETTE と同じ並び。色の量がこの値を超えるとカラーになる（0 = 最初から＝白・黒など）
const COLOR_ORDER = [
  0.05, 0.05, 0.05,       // 空
  0.9, 0.9, 0.9,          // 夕焼けの空
  0.45,                   // 太陽・花
  0, 0,                   // 白・クリーム
  0.5, 0.2,               // 遠くの山・川と湖
  0.35, 0.35, 0.35,       // 草
  0.55, 0.55, 0.55,       // 木・幹
  0.65, 0.65, 0.65, 0.65, // 道
  0.1, 0.1,               // カゴ
  0.1, 0.1, 0,            // ハンドル・グリップ・黒
  0,                      // ゴールの目印
];
const BLOOM_BAND = 0.08;

function quantize(ctx: CanvasRenderingContext2D, colour = 1) {
  const image = ctx.getImageData(0, 0, VIEW.width, VIEW.height);
  const pixels = new Uint32Array(image.data.buffer);
  const all = colour >= 1;
  for (let i = 0; i < pixels.length; i++) {
    const index = nearestIndex(pixels[i]);
    if (all) { pixels[i] = palettePacked[index]; continue; }
    const x = i % VIEW.width, y = (i / VIEW.width) | 0;
    const dissolve = COLOR_ORDER[index] + ((BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * BLOOM_BAND;
    if (colour > dissolve) { pixels[i] = palettePacked[index]; continue; }
    pixels[i] = monoMask[index][(y & 3) * 4 + (x & 3)] === "1" ? MONO_BLACK : MONO_WHITE;
  }
  ctx.putImageData(image, 0, 0);
}

// ---- コンポーネント --------------------------------------------------------

export default function RideAlong({ friendId, client, paused }: GameComponentProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pads = useRef<{ L: HTMLButtonElement | null; R: HTMLButtonElement | null }>({ L: null, R: null });
  const ride = useRef<Ride>(freshRide());
  const held = useRef({ left: false, right: false, brake: false });
  const live = useRef({ paused, reducedMotion: false, menuOpen: false });

  const [status, setStatus] = useState("Loading the course and your Friend…");
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [readout, setReadout] = useState({ v: 0, falls: 0, stamina: 1, label: "", hint: true, title: true, split: null as number | null, goal: false, closeup: false, finished: false });
  const [portrait, setPortrait] = useState<{ rows: readonly string[]; family: string; type: FriendType } | null>(null);
  const [result, setResult] = useState<{ time: number; falls: number; top: number; best: number; newBest: boolean } | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  /** このセッションのベストタイム（s）。保存はできないのでリロードで消える（2026-09-24 まず簡素に） */
  const best = useRef<number | null>(null);
  /** ベストの回の区間タイム（区間タイム差の比べる相手） */
  const bestSplits = useRef<number[] | null>(null);
  /** ゴールした直後の結果。RESULT_DELAY 秒たったら result に移して出す */
  /** ゴールした実時刻（ms・スローとポップアップ用）・コインを取った実時刻（ms・取った演出用） */
  const goalAtMs = useRef<number | null>(null);
  const collectAtMs = useRef<number | null>(null);
  const pendingResult = useRef<{ time: number; falls: number; top: number; best: number; newBest: boolean } | null>(null);
  // 能力は Friend を読み込んでから決まる（種族は絵と一緒に・世代はあとから裏で）。ループからは ref で読む
  const traitsRef = useRef<Traits>({ type: "allround", power: 1, balance: 1, stamina: 1 });
  // 音（2026-09-25 試作）。最初のキー・タップの中で unlock する。ミュートは HUD のボタンと設定
  const sound = useRef<RideSound | null>(null);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    sound.current = createRideSound();
    return () => { sound.current?.dispose(); sound.current = null; };
  }, []);
  useEffect(() => { sound.current?.setMuted(muted); }, [muted]);

  live.current = { paused, reducedMotion, menuOpen: menu };
  const release = () => {
    held.current.left = false; held.current.right = false; held.current.brake = false;
    ride.current.stroke = null;
  };

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(preference.matches);
    change();
    preference.addEventListener("change", change);
    return () => preference.removeEventListener("change", change);
  }, []);
  useEffect(() => { if (paused || menu) release(); }, [paused, menu]);

  useEffect(() => {
    const node = canvas.current, ctx = node?.getContext("2d");
    // 低解像度バッファ（192×128）。ここに描き、補間なしで整数5倍に拡大して画面へ出す。
    const buffer = document.createElement("canvas");
    const glowCanvas = document.createElement("canvas"); // スローの間の光（ふちのぼかし）の作業用
    glowCanvas.width = SCREEN.width; glowCanvas.height = SCREEN.height;
    buffer.width = VIEW.width;
    buffer.height = VIEW.height;
    const low = buffer.getContext("2d", { willReadFrequently: true }); // 毎フレーム パレットに丸めるため読み返す
    if (!node || !ctx || !low) { setFailed(true); setStatus("This browser cannot draw the game."); return; }
    let cancelled = false, frame = 0, previous = 0, hudAt = 0;
    ride.current = freshRide();
    release(); setMenu(false); setFailed(false); setStatus("Loading the course and your Friend…");
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);

    // client.read() は経済を使わなくても必須（呼ばないとロード状態が終わらない）。
    void Promise.all([createFriendReader().read(friendId), client.read()]).then(([sprites, snapshot]) => {
      if (cancelled) return;
      if (snapshot.friendId !== friendId) throw new Error("This session's Friend does not match your selection.");
      setStatus("");
      const fixed = FIXED_TRAITS;
      traitsRef.current = TEST_TRAITS ?? (fixed !== null ? { type: "allround", power: fixed, balance: fixed, stamina: fixed }
        : friendTraits(friendId, sprites.familyName, null));
      setPortrait({ rows: spriteFrame(sprites, "down", false, 0, "right").frame.rows, family: sprites.familyName, type: traitsRef.current.type });
      sound.current?.setVoice(1 + (friendHash(friendId + 7n) * 2 - 1) * HUM_VOICE_SPREAD); // 鼻歌の声の高さは Friend ごと
      // 世代の上乗せは読めたらあとから（起動を待たせない）
      if (fixed === null && TEST_TRAITS === null) void readGeneration(friendId).then(generation => {
        if (!cancelled && generation !== null) traitsRef.current = friendTraits(friendId, sprites.familyName, generation);
      });
      if (INTRO_ON && !live.current.reducedMotion) ride.current.introT = 0; // スタートの演出はページを開いたときだけ（Ride again では出さない）
      const render = (now: number) => {
        const rawDt = previous ? Math.min((now - previous) / 1000, 0.05) : 0;
        // ゴールの瞬間のスロー（実時間で数える）
        const sinceGoal = goalAtMs.current === null ? Infinity : (now - goalAtMs.current) / 1000;
        const timeScale = live.current.reducedMotion || sinceGoal >= SLOW_HOLD + SLOW_EASE ? 1
          : sinceGoal < SLOW_HOLD ? SLOW_SCALE : SLOW_SCALE + (1 - SLOW_SCALE) * (sinceGoal - SLOW_HOLD) / SLOW_EASE;
        const dt = rawDt * timeScale;
        previous = now;
        const it = ride.current;
        const blocked = live.current.paused || live.current.menuOpen || document.hidden;

        if (!blocked && dt > 0) {
          it.time += dt;
          it.remount = Math.max(0, it.remount - dt);
          if (it.introT >= 0) { it.introT += dt; if (it.introT >= INTRO_WALK + INTRO_HOP) it.introT = -1; }
          it.stillTime = it.footDown && it.introT < 0 && !it.finished ? it.stillTime + dt : 0;
          it.braking = held.current.brake;
          const colourTarget = it.finished ? 1 : Math.max(clamp(it.s / GOAL_AT, 0, 1) ** BLOOM_PROGRESS_POW,
            it.falling > 0 ? 0 : clamp((it.v - BLOOM_SPEED_FROM) / (BLOOM_SPEED_FULL - BLOOM_SPEED_FROM), 0, 1));
          it.colorView += (colourTarget - it.colorView) * (1 - Math.exp(-dt / (colourTarget > it.colorView ? BLOOM_RISE : BLOOM_FALL)));
          // タイムは最初の1踏みから頂上まで（転倒・足つきの時間も含む）
          if (!it.finished && (it.s > 0 || !it.footDown)) it.clock += dt;
          // ペダルの揺れ（見た目だけ。物理には効かせない）
          // 低速の踏み込み中は、ばねの釣り合い位置を踏んでいる側へずらす
          // ＝踏み込むほど頭とハンドルがそっちへ寄り、離すと戻る。
          // 踏み切ったら（strokeDone = 1）釣り合い位置は戻す。単発押しでは stroke が次の踏みまで残るので、
          // これが無いと頭とハンドルが寄ったままになる
          const rockTarget = it.stroke && it.strokeDone < 1 ? (it.stroke === "L" ? -1 : 1) * ROCK_PUSH * it.strokeDone : 0;
          it.rockVel += (-ROCK_SPRING * (it.rock - rockTarget) - ROCK_DAMP * it.rockVel) * dt;
          it.rock += it.rockVel * dt;
          it.psiView += (it.psi - it.psiView) * (1 - Math.exp(-dt / BG_PSI_LAG));
          it.climbView += (gradeAt(it.s) - it.climbView) * (1 - Math.exp(-dt / 0.8));
          const steerRaw = it.falling > 0 || it.footDown || it.finished ? 0
            : (held.current.right ? 1 : 0) - (held.current.left ? 1 : 0);
          if (steerRaw !== 0 && steerRaw === it.steerDir) it.steerHold += dt;
          else { it.steerDir = steerRaw; it.steerHold = 0; }
          const steerInput = it.steerDir * (STEER_TAP + (1 - STEER_TAP) * clamp(it.steerHold / STEER_RAMP, 0, 1));
          it.steerView += (steerInput - it.steerView) * (1 - Math.exp(-dt / STEER_LAG));
          if (it.falling > 0) {
            // 転倒中。倒れきったら少し手前から再開する。
            it.falling -= dt;
            it.v = Math.max(0, it.v - 6 * dt);
            if (it.falling <= 0) {
              it.s = Math.max(0, it.s - 12);
              it.x = 0; it.psi = 0; it.theta = 0; it.v = 0; it.expect = "L"; it.stroke = null;
              it.footDown = true; it.launching = true; it.pushLeft = 0; it.remount = REMOUNT_TIME;
              if (it.wetFall) { it.shakeAt = it.time + REMOUNT_TIME; it.wetFall = false; } // カゴに戻ったら ぶるぶる
              it.danger = 0; // 転ぶ直前の値が残ると、再開後に「!」が出続けた（2026-09-26 builder「転んだあとの！はいらない」）
            }
          } else if (it.footDown) {
            // 足をついて止まっている。坂でも下がらない・倒れない
            it.v = 0; it.theta *= Math.exp(-6 * dt); it.danger = 0;
          } else {
            const grade = gradeAt(it.s);
            const offCourse = Math.abs(it.x) > HALF_WIDTH;

            // 速度
            const tuck = held.current.brake ? 1 : 1 - (1 - DESCENT_DRAG) * clamp(-grade / DESCENT_FULL, 0, 1);
            const drag = ((DRAG_LIN * (offCourse ? GRASS_DRAG : 1)) * it.v + DRAG_SQ * it.v * it.v) * tuck
              + OVER_DRAG * Math.max(0, it.v - OVER_V) ** 2;
            const turnLoss = TURN_DRAG * Math.abs(it.theta) * it.v;
            // ブレーキは純粋な減速項。傾きとは結合させていない（実車のように
            // 「倒しながら握ると転ぶ」まで入れると、下りの理不尽さの判定が濁るため）。
            // ただし低速まで落とすと stability が下がってふらつくので、
            // 「止まるまで握れば安全」にはならない。これは既存の式から自然に出る。
            const brake = held.current.brake ? BRAKE_DECEL : 0;
            // 蹴り出し（足を離した直後だけ）
            const kick = it.pushLeft > 0 && !held.current.brake ? LAUNCH_ACCEL : 0;
            it.pushLeft = Math.max(0, it.pushLeft - dt);
            it.v = Math.max(0, it.v + (kick - G_SLOPE * grade - drag - turnLoss - brake) * dt);

            // 踏み込み中のペダルから、押している時間に応じて力を出す。
            // ブレーキを握ったら踏み込みは打ち切り（pedal() と同じ理由）。
            if (it.stroke && held.current.brake) it.stroke = null;
            if (it.stroke) advanceStroke(it, now / 1000);

            // ロール（physics.md 3章。この1本で「速いと安定・遅いと倒れる」が出る）
            // 発進中は安定度を持ち上げる（上の LAUNCH_* の説明）
            if (it.launching && it.v >= LAUNCH_END_V) it.launching = false;
            const natural = it.v / (it.v + V_HALF);
            const assist = it.launching
              ? clamp((LAUNCH_END_V - it.v) / (LAUNCH_END_V - LAUNCH_HOLD_V), 0, 1) : 0;
            const stability = Math.max(natural, natural + (LAUNCH_STAB - natural) * assist);
            const steer = it.steerDir * (STEER_TAP + (1 - STEER_TAP) * clamp(it.steerHold / STEER_RAMP, 0, 1));
            // 発進中は弱めない（発進の安定度 LAUNCH_STAB で合わせてあるため。弱めると踏むだけで 2m で倒れた）
            let release = 1;
            if (steer === 0 && !it.launching) {
              const neutral = (K_TOPPLE * (1 - stability) + RELEASE_NET) / (K_RESTORE * stability);
              const fast = clamp((it.v - RELEASE_FAST_FROM) / (RELEASE_FAST_FULL - RELEASE_FAST_FROM), 0, 1);
              release = RELEASE_RESTORE + (Math.min(RELEASE_RESTORE, neutral) - RELEASE_RESTORE) * fast;
            }
            const restore = -K_RESTORE * stability * it.theta * release;
            // 登りだけ少し安定させる（勾配に比例、CLIMB_STEADY_FULL 以上で満額）。2026-09-26 builder「最後の登りがちょいきつい、ほんの少し安定（登りだけ）」
            const climbSteady = clamp(grade / CLIMB_STEADY_FULL, 0, 1);
            const topple = K_TOPPLE * (1 - CLIMB_TOPPLE_CUT * climbSteady) * (1 - stability) * it.theta;
            const calm = descentCalm(grade, held.current.brake);
            // 踏み込みの振れ（押している間だけ。左を踏むと左＝θ負）
            const pushRoll = it.stroke && it.strokeDone < 1 ? (it.stroke === "L" ? -1 : 1) * PEDAL_ROLL * (1 - natural)
              * (1 + CLIMB_ROLL * Math.max(0, grade) / 0.07) * calm : 0;
            const lowWobble = 1 + LOW_WOBBLE * clamp((LOW_WOBBLE_FROM - it.v) / (LOW_WOBBLE_FROM - LOW_WOBBLE_FULL), 0, 1);
            const noise = wobble(it.time) * NOISE_AMP * lowWobble * (1 - CLIMB_NOISE_CUT * climbSteady) * (1 - stability) * (2 - traitsRef.current.balance) * calm;
            it.theta += (STEER_RATE * steer + restore + topple + noise + pushRoll) * dt;

            // 旋回と横ずれ
            // V_FLOOR 以上は g·tanθ/v の形。以下は v/V_FLOOR² で 0 へ（止まっていれば傾いても向きは変わらない）
            const omega = TURN_GAIN * it.theta * it.v / Math.max(it.v, V_FLOOR) ** 2;
            it.psi += (omega - curvatureAt(it.s) * it.v) * dt;
            it.psi = clamp(it.psi, -0.8, 0.8);
            it.x += it.v * Math.sin(it.psi) * dt;
            const advance = it.v * Math.cos(it.psi) * dt;
            it.s += advance;
            it.altitude += grade * advance;

            it.stamina = Math.min(1, it.stamina + STAM_RECOVER * traitsRef.current.stamina * dt);

            const ease = THETA_EASE * clamp((it.v - EASE_FROM) / (EASE_FULL - EASE_FROM), 0, 1);
            it.danger = it.v > 0.5 ? Math.abs(it.theta) / ((THETA_MAX + ease) * traitsRef.current.balance) : 0;
            it.topSpeed = Math.max(it.topSpeed, it.v);
            if (!it.finished && (Math.abs(it.theta) > (THETA_MAX + ease) * traitsRef.current.balance || Math.abs(it.x) > HALF_WIDTH + 4 || inWater(it))) {
              it.falling = FALL_TIME;
              it.falls += 1;
              it.wetFall = inWater(it);
              sound.current?.fall(); // 「コテン」
            }
            // ゴール（登りきった所）。ペダルは受け付けず、惰性で止まって足をつく。止まる途中で転ばないよう傾きも戻す。
            // 結果パネルは RESULT_DELAY 秒あとに出す（その間に Friend が景色の方を向き、鳥が飛び立つ）
            if (it.s >= GOAL_AT && !it.finished) {
              it.finished = true; it.finishedAt = it.time; it.stroke = null;
              const previous = best.current;
              if (previous === null || it.clock < previous) { best.current = it.clock; bestSplits.current = [...it.splits]; }
              pendingResult.current = { time: it.clock, falls: it.falls, top: it.topSpeed, best: best.current ?? it.clock,
                newBest: previous !== null && it.clock < previous };
              sound.current?.bell(); it.bellAt = it.time;
              goalAtMs.current = now;
            }
            // ゴールのあとは自動で道なりに転がる（ハンドルは効かない・転ばない）。車体は曲がりに合わせて少し傾ける。
            // 重力と抵抗はそのまま＝下り続けて、麓の平地で自然に止まる（2026-09-25。前はゴールで急ブレーキ）
            if (it.finished) {
              it.psi *= Math.exp(-3 * dt);
              it.x *= Math.exp(-1.5 * dt);
              const lean = clamp(curvatureAt(it.s) * it.v * it.v / TURN_GAIN, -0.25, 0.25);
              it.theta += (lean - it.theta) * (1 - Math.exp(-4 * dt));
              if (it.s >= COURSE_LENGTH - 1) it.v = Math.max(0, it.v - 4 * dt);
              if (it.v < 0.3) { it.v = 0; it.footDown = true; }
            }
            if (it.s >= COURSE_LENGTH) it.s = COURSE_LENGTH;
          }
          // スピードで喜ぶ・ときどき前を向く（走っている間だけ）
          if (!it.finished && it.falling <= 0 && !it.footDown) {
            if (JOY_ON && it.v >= JOY_V && it.joyArmed) {
              it.joyAt = it.time; it.joyArmed = false;
              if (!live.current.reducedMotion) sound.current?.hop();
            }
            if (it.v < JOY_REARM_V) it.joyArmed = true;
            // 前を向いている間は数えない。向き終わってから LOOK_FWD_WAIT 秒走り続けたら、また向く
            if (it.time - it.fwdAt < LOOK_FWD_LEN) it.cruiseT = 0;
            else {
              it.cruiseT = it.v >= LOOK_FWD_V ? it.cruiseT + dt : 0;
              if (LOOK_FWD_ON && it.cruiseT >= LOOK_FWD_WAIT) { it.fwdAt = it.time; it.cruiseT = 0; }
            }
          } else { it.cruiseT = 0; it.fwdAt = -100; }
        }

        // 区間ごとのタイム差（最初に入ったときだけ記録。転んで手前へ戻っても記録し直さない）
        if (SPLITS_ON && !it.finished && it.clock > 0) {
          const index = segmentIndexAt(it.s);
          if (index > 0 && it.splits[index] === undefined) {
            it.splits[index] = it.clock;
            const reference = bestSplits.current?.[index];
            if (reference !== undefined) { it.splitDelta = it.clock - reference; it.splitUntil = it.time + SPLIT_SHOW; }
          }
        }
        // 「!」が出た瞬間に「ピピッ」（出たり消えたりしても DANGER_SOUND_GAP 秒は鳴らさない）
        const dangerNow = DANGER_ON && it.danger > DANGER_FROM && !it.finished && it.falling <= 0;
        if (dangerNow && !it.dangerOn && it.time - it.dangerSoundAt > DANGER_SOUND_GAP) { sound.current?.danger(); it.dangerSoundAt = it.time; }
        it.dangerOn = dangerNow;
        // ゴールのコイン: 手が届く距離まで来たら、道の真ん中近くなら取る・外れていたら外す
        if (it.coinState === 0 && GOAL_AT - it.s <= COLLECT_DZ && it.falling <= 0) {
          it.coinState = Math.abs(it.x) <= COIN_REACH ? 1 : 2;
          if (it.coinState === 1) collectAtMs.current = now;
        }
        it.collectReal = collectAtMs.current === null ? -1 : (now - collectAtMs.current) / 1000;
        // Friend の振り向き → 跳ねる はゴールの瞬間から、ゲームの時間で進める＝スローの間はゆっくり動く
        // （2026-09-26 いったん「スロー中は動かさない」にしたが、builder「スローに動けるならその方がいい」で戻した）
        if (it.finished && it.cheerAt < 0) it.cheerAt = it.finishedAt;
        // ゴールの跳ね（スローの間・向き直ったとき）に「ピピッ」
        if (it.cheerAt >= 0 && !live.current.reducedMotion) {
          const c = it.time - it.cheerAt;
          if (it.goalHops === 0 && c >= GOAL_HOP_SOUND_AT) { sound.current?.hop(); it.goalHops = 1; }
          else if (it.goalHops === 1 && c >= HOP_FROM) { sound.current?.hop(); it.goalHops = 2; }
        }
        if (pendingResult.current && (live.current.reducedMotion ? it.time - it.finishedAt >= 0.3
          : it.cheerAt >= 0 && it.time - it.cheerAt >= RESULT_DELAY)) {
          setResult(pendingResult.current); pendingResult.current = null;
        }
        sound.current?.update(it.v, held.current.brake, !blocked && it.falling <= 0 && !it.footDown, humMood(it, blocked));
        it.humOn = sound.current?.humming() ?? false;
        // Friend のコマはゲームの時間で進める（スローの間はゆっくり・止めている間は止まる）
        paintScene(low, it, sprites, Math.floor(it.time / 0.11) % 8, live.current.reducedMotion,
          toolbarClearance(node.clientHeight), traitsRef.current.type);
        if (PALETTE_ON) quantize(low, COLOR_BLOOM_ON ? it.colorView : 1);
        // 補間を切って整数倍に拡大。これで台形もベジェも全部ドットの階段になる。
        ctx.imageSmoothingEnabled = false;
        // ゴール後の Friend のアップ: 低解像度の画面のうち Friend のまわりだけを切り出して拡大する
        const closeT = goalAtMs.current === null ? -1 : (now - goalAtMs.current) / 1000; // 実時間（スローの間）
        let zoom = 1;
        if (CLOSEUP_ON && !live.current.reducedMotion && closeT >= 0 && closeT < CLOSEUP_UNTIL + CLOSEUP_OUT) {
          const e = clamp(Math.min(closeT / CLOSEUP_IN, (CLOSEUP_UNTIL + CLOSEUP_OUT - closeT) / CLOSEUP_OUT), 0, 1);
          zoom = 1 + (CLOSEUP_ZOOM - 1) * e * e * (3 - 2 * e);
        }
        if (zoom > 1.001) {
          const w = VIEW.width / zoom, h = VIEW.height / zoom;
          const baseY = VIEW.height - toolbarClearance(node.clientHeight) - 20;
          const cx = VIEW.width / 2 + it.theta * BAR_SWING, cy = baseY - 14; // カゴの Friend のあたり
          const sx = clamp(cx - w / 2, 0, VIEW.width - w), sy = clamp(cy - h * 0.5, 0, VIEW.height - h);
          ctx.drawImage(buffer, sx, sy, w, h, 0, 0, SCREEN.width, SCREEN.height);
        } else ctx.drawImage(buffer, 0, 0, SCREEN.width, SCREEN.height);
        // スローの間の光: ふちだけ ぼかして明るく＋白い光
        const glow = SLOW_GLOW_ON && !live.current.reducedMotion && closeT >= 0
          ? clamp(closeT / SLOW_GLOW_RISE, 0, 1) * clamp(1 - (closeT - SLOW_HOLD) / SLOW_EASE, 0, 1) : 0;
        if (glow > 0.01) paintSlowGlow(ctx, glowCanvas, glow);

        if (now - hudAt > 120) {
          hudAt = now;
          setReadout({
            v: it.v, falls: it.falls, stamina: it.stamina, // 高度（Alt）の表示は 2026-09-27 に外した（builder「いらない気がしてきた」）
            label: segmentAt(it.s).label, hint: it.s < HINT_UNTIL && !it.finished,
            split: it.time < it.splitUntil ? it.splitDelta : null,
            goal: goalAtMs.current !== null && (now - goalAtMs.current) / 1000 < GOAL_POP,
            finished: it.finished,
            closeup: CLOSEUP_ON && !live.current.reducedMotion && goalAtMs.current !== null
              && (now - goalAtMs.current) / 1000 >= NAMEPLATE_FROM && (now - goalAtMs.current) / 1000 < CLOSEUP_UNTIL,
            title: it.clock === 0 && it.falls === 0 && !it.finished,
          });
        }
        // 自動テスト（friendsdk test）から状態を読めるようにしておく
        node.dataset.speed = it.v.toFixed(2);
        node.dataset.theta = it.theta.toFixed(3);
        node.dataset.x = it.x.toFixed(2);
        node.dataset.psi = it.psi.toFixed(3);
        node.dataset.rock = it.rock.toFixed(3);
        node.dataset.distance = it.s.toFixed(1);
        node.dataset.falls = String(it.falls);
        node.dataset.traits = `${traitsRef.current.type}:${traitsRef.current.power.toFixed(3)}:${traitsRef.current.balance.toFixed(3)}`;
        // ペダルボタン: 踏み込むほど濃く・小さく。踏み切ったら反対側を光らせる（React の再描画は通さない）
        for (const side of ["L", "R"] as const) {
          const pad = pads.current[side];
          if (!pad) continue;
          const pushing = it.stroke === side;
          pad.style.setProperty("--push", pushing ? it.strokeDone.toFixed(3) : "0");
          pad.classList.toggle("is-full", pushing && it.strokeDone >= 1);
          pad.classList.toggle("is-next", it.stroke !== null && it.stroke !== side && it.strokeDone >= 1);
        }
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);
    }).catch(() => {
      if (!cancelled) { setFailed(true); setStatus("Could not load the course or your Friend's sprite. Check your connection and retry."); }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      release();
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [friendId, client, revision]);

  const blocked = paused || menu || Boolean(status) || Boolean(result);

  /** 1踏みの力のうち part（0..1）だけを速度に足す。スタミナも同じ割合で減る。 */
  function applyPedal(it: Ride, part: number) {
    const grade = gradeAt(it.s);
    const boost = 1 + CLIMB_BOOST * Math.max(0, grade) / 0.07;
    const vmax = PEDAL_VMAX_FLAT - (PEDAL_VMAX_FLAT - PEDAL_VMAX_CLIMB) * clamp(grade / PEDAL_CLIMB_FULL, 0, 1);
    const knee = vmax - PEDAL_KNEE;
    const reach = it.v <= knee ? 1 : Math.exp(-(it.v - knee) / PEDAL_TAIL); // 上限に近いほど効かない（0 にはしない）
    const inverse = Math.min(1, PEDAL_INV_FROM / Math.max(it.v, 0.01)); // 速いほど 1 踏みの伸びが小さい
    it.v += PEDAL_POWER * traitsRef.current.power * boost * reach * inverse * (STAM_FLOOR + (1 - STAM_FLOOR) * it.stamina) * part;
    it.stamina = Math.max(0, it.stamina - STAM_COST / traitsRef.current.stamina * part);
  }

  /**
   * 左右交互のペダル。合っていれば踏み込み開始、違えば空振り（速度は変えない）。
   * 低速では1踏みが時間をかけて力を出す。**押すのは一瞬でいい**（2026-09-23 から単発押し。
   * それまでは長押しで、離すと途中で終わっていた。スマホで難しいという builder の判断）。
   * 踏み切る前に反対を押すと残りは捨てる。連打は STROKE_DEAD で毎回切れて進まない。
   * 速ければ押した瞬間に全部出る。
   */
  /** 押し始めからの実時間で、1踏みのうちどこまで力を出したかを進める。 */
  function advanceStroke(it: Ride, nowSeconds: number) {
    const need = strokeTime(it.v);
    const dead = need * STROKE_DEAD;
    const reached = need > 0 ? clamp((nowSeconds - it.strokeStart - dead) / (need - dead), 0, 1) : 1;
    // 力は進みの2乗で出す（後半ほど強い）。単発押しにしたら、連打でも毎回半分近くまで力が出て、
    // リズムよく押すのと同じだけ進んでしまった（2026-09-23 probe）。踏み切れば合計は同じ 1
    if (reached > it.strokeDone) { applyPedal(it, reached * reached - it.strokeDone * it.strokeDone); it.strokeDone = reached; }
  }

  const pedal = (side: "L" | "R") => {
    const it = ride.current;
    sound.current?.unlock();
    if (blocked || it.falling > 0 || it.finished) return;
    // ブレーキ中は漕げない（実車と同じ）。これを入れないと
    // 素早い交互踏み（約 2.4 m/s^2）がブレーキ（2.5 m/s^2）をほぼ打ち消し、
    // 「握っても変わらない」状態になる（2026-09-23 builder の指摘で判明）。
    if (held.current.brake) return;
    // 最初の1踏みはどちらの足からでもいい（足をついた状態から漕ぎ出す）
    it.introT = -1; // スタートの演出の途中なら飛ばす
    if (it.footDown) {
      if (it.clock === 0 && it.falls === 0) { sound.current?.bell(); it.bellAt = it.time; } // 出発のチリン
      it.footDown = false; it.pushLeft = LAUNCH_PUSH; it.expect = side;
    }
    if (side !== it.expect) { it.missed += 1; return; }
    it.expect = side === "L" ? "R" : "L";
    it.pedalAt = it.time;
    // 反対側を踏んだら、前の踏み込みの残りは捨てる（両足で同時には踏めない）
    if (strokeTime(it.v) > 0) {
      // 低速: 押した時刻から時間をかけて力が入る（指を離しても続く）。揺れも踏み込みに合わせる（弾かない）
      it.stroke = side; it.strokeStart = performance.now() / 1000; it.strokeDone = 0;
    } else {
      // 高速: 押した瞬間に全部出る。揺れはポンと弾く（従来どおり）
      it.stroke = null; applyPedal(it, 1);
      it.theta += (side === "L" ? -1 : 1) * PEDAL_ROLL_KICK * (2 * V_HALF / (it.v + V_HALF))
        * shakeGain(it.v, 0) // 30km/h 超では振れも減らす（画面の回転になって見えるため）
        * descentCalm(gradeAt(it.s), held.current.brake);
      it.rockVel += side === "L" ? -ROCK_KICK : ROCK_KICK;
    }
  };
  // 離したときは何もしない（単発押し）。踏み込みは描画ループで最後まで進む
  const pedalProps = (side: "L" | "R") => ({
    onPointerDown: (event: React.PointerEvent) => {
      event.preventDefault();
      pedal(side);
    },
  });

  const holdProps = (which: "left" | "right" | "brake") => ({
    onPointerDown: (event: React.PointerEvent) => {
      if (blocked) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      held.current[which] = true;
    },
    onPointerUp: () => { held.current[which] = false; },
    onPointerCancel: () => { held.current[which] = false; },
    onPointerLeave: () => { held.current[which] = false; },
  });

  // キーボードは canvas にフォーカスが無いと届かない。ペダル/ハンドルのボタンは
  // preventDefault でフォーカスを取らないので、ゲーム領域のどこを押しても canvas に戻す。
  // （ボタンで遊び始めた人がキーボードへ移行できなくなるのを防ぐ）
  /** コースの最初からやり直す（長い登りで転び続けたとき用。2026-09-23 追加） */
  const restart = () => { ride.current = freshRide(); pendingResult.current = null; goalAtMs.current = null; collectAtMs.current = null; release(); setMenu(false); setResult(null); setCopied("idle"); };

  const focusCanvas = () => { sound.current?.unlock(); if (!blocked) canvas.current?.focus(); };

  return <section className="ride-game" aria-label="Ride Along" onPointerDown={focusCanvas}>
    <div className="ride-world" inert={paused || menu || undefined}>
      <canvas
        ref={canvas} width={SCREEN.width} height={SCREEN.height}
        tabIndex={blocked ? -1 : 0}
        aria-label="Ride the bicycle. Tap A and D alternately to pedal; while slow, wait for each stroke to finish before the next. Left and Right arrows steer. Down arrow or Space brakes. The on-screen pads do the same."
        onBlur={release}
        onKeyDown={event => {
          sound.current?.unlock();
          if (blocked) return;
          const key = event.key.toLowerCase();
          if (key === "a" || key === "d") { event.preventDefault(); if (!event.repeat) pedal(key === "a" ? "L" : "R"); }
          if (key === "arrowleft") { event.preventDefault(); held.current.left = true; }
          if (key === "arrowright") { event.preventDefault(); held.current.right = true; }
          if (key === "arrowdown" || key === " ") { event.preventDefault(); held.current.brake = true; }
        }}
        onKeyUp={event => {
          const key = event.key.toLowerCase();
          if (key === "a" || key === "d") event.preventDefault();
          if (key === "arrowleft") { event.preventDefault(); held.current.left = false; }
          if (key === "arrowright") { event.preventDefault(); held.current.right = false; }
          if (key === "arrowdown" || key === " ") { event.preventDefault(); held.current.brake = false; }
        }}
      />
      <div className="ride-hud" aria-live="off">
        <span><strong>{(readout.v * 3.6).toFixed(0)}</strong> km/h</span>
        <span>Falls {readout.falls}</span>
        <span className="ride-section">{readout.label}</span>
        {readout.split !== null && <span className="ride-split" data-ahead={readout.split < 0 || undefined}
          aria-label={`${Math.abs(readout.split).toFixed(1)} seconds ${readout.split < 0 ? "ahead of" : "behind"} your best`}>
          {readout.split < 0 ? "-" : "+"}{Math.abs(readout.split).toFixed(1)}</span>}
        <button type="button" className="ride-gear ride-mute" aria-pressed={muted}
          aria-label={muted ? "Sound off. Turn sound on" : "Sound on. Mute"} title={muted ? "Sound off" : "Sound on"}
          onClick={() => setMuted(value => !value)}>
          <svg viewBox="0 0 12 12" width="24" height="24" shapeRendering="crispEdges" aria-hidden="true">
            {/* ドットのスピーカー。ミュート中は波の代わりに × */}
            <path fill="currentColor" d="M1 4h2v4H1zM3 4h1v4H3zM4 3h1v6H4zM5 2h1v8H5z" />
            {muted
              ? <path fill="currentColor" d="M7 4h1v1H7zM8 5h1v1H8zM9 6h1v1H9zM10 7h1v1h-1zM10 4h1v1h-1zM9 5h1v1H9zM8 6h1v1H8zM7 7h1v1H7z" />
              : <path fill="currentColor" d="M7 5h1v2H7zM9 3h1v1H9zM10 4h1v4h-1zM9 8h1v1H9z" />}
          </svg>
        </button>
        <button type="button" className="ride-gear" aria-label="Settings" title="Settings"
          disabled={Boolean(status)} onClick={() => setMenu(true)}>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            {/* 8歯の対称な歯車（手描きの path は歯が偏って下側が細く見えたため生成し直した） */}
            <path fill="currentColor" fillRule="evenodd" d="M9.02 4.79 L10.33 4.38 L10.35 1.93 L13.65 1.93 L13.67 4.38 L14.98 4.79 L16.21 5.43 L17.95 3.72 L20.28 6.05 L18.57 7.79 L19.21 9.02 L19.62 10.33 L22.07 10.35 L22.07 13.65 L19.62 13.67 L19.21 14.98 L18.57 16.21 L20.28 17.95 L17.95 20.28 L16.21 18.57 L14.98 19.21 L13.67 19.62 L13.65 22.07 L10.35 22.07 L10.33 19.62 L9.02 19.21 L7.79 18.57 L6.05 20.28 L3.72 17.95 L5.43 16.21 L4.79 14.98 L4.38 13.67 L1.93 13.65 L1.93 10.35 L4.38 10.33 L4.79 9.02 L5.43 7.79 L3.72 6.05 L6.05 3.72 L7.79 5.43Z M12 8.4a3.6 3.6 0 1 0 0 7.2a3.6 3.6 0 1 0 0-7.2Z" />
          </svg>
        </button>
      </div>
      <div className={`ride-stamina${readout.stamina < STAMINA_LOW ? " is-empty" : ""}${reducedMotion ? " is-still" : ""}`}>
        <i style={{ width: `${readout.stamina * 100}%` }} /></div>

      {readout.title && !status && <div className="ride-title">
        {portrait && <FriendPortrait rows={portrait.rows} />}
        <div>
          <h1>Ride Along</h1>
          <p>with Friend #{friendId.toString()}{portrait ? ` · ${portrait.family}` : ""}</p>
          {portrait && <p className="ride-type">{TYPE_LABEL[portrait.type]}</p>}
        </div>
      </div>}
      {readout.hint && !status && <p className={readout.title ? "ride-hint is-under-title" : "ride-hint"}>
        Tap <b>A</b> and <b>D</b> one after the other to pedal · <b>◀ ▶</b> (<kbd>←</kbd> <kbd>→</kbd>) to steer
      </p>}

      {readout.goal && !result && <p className={reducedMotion ? "ride-goal-pop is-still" : "ride-goal-pop"} role="status">Goal</p>}
      {readout.closeup && !result && portrait && <div className="ride-nameplate" role="status">
        <strong>{portrait.family}</strong>
        <span>{TYPE_LABEL[portrait.type]} · Friend #{friendId.toString()}</span>
      </div>}

      {result && (() => {
        const rank = rankOf(result.time), next = nextRank(rank);
        const text = shareText(result.time, rank, friendId);
        return <div className="ride-result" role="status">
          <div className="ride-result-head">
            <h2>Finish</h2>
            {result.newBest && <span className="ride-best">New best</span>}
          </div>
          <div className="ride-result-time">
            {rank && <RankIcon rank={rank} />}
            <strong>{formatTime(result.time)}</strong>
            <span>{rank ? RANK_LABEL[rank] : "No medal"}</span>
          </div>
          <p className="ride-next">{next
            ? `Next: ${RANK_LABEL[next.rank]} ${next.strictly ? "under" : "within"} ${formatTime(next.time)}`
            : "You beat the builder!"}</p>
          <dl>
            <div><dt>Falls</dt><dd>{result.falls}</dd></div>
            <div><dt>Top speed</dt><dd>{(result.top * 3.6).toFixed(0)} km/h</dd></div>
            <div><dt>Session best</dt><dd>{formatTime(result.best)}</dd></div>
          </dl>
          <p className="ride-builder">With Friend #{friendId.toString()} · Builder&apos;s best {formatTime(BUILDER_BEST)}</p>
          <div className="ride-result-actions">
            <button type="button" className="ride-primary" autoFocus disabled={paused} onClick={restart}>Ride again</button>
            <button type="button" disabled={paused} onClick={() => setCopied(copyText(text) ? "copied" : "failed")}>Copy for X</button>
          </div>
          {copied === "copied" && <p className="ride-copied">Copied. Paste it into a post on X.</p>}
          {copied === "failed" && <textarea className="ride-share" readOnly value={text} aria-label="Result text to share"
            onFocus={event => event.currentTarget.select()} />}
        </div>;
      })()}

      {!status && !result && !readout.finished && <>
        <div className="ride-pedals">
          <button type="button" className="ride-pad ride-pedal" aria-label="Left pedal"
            ref={el => { pads.current.L = el; }} {...pedalProps("L")}>A</button>
          <button type="button" className="ride-pad ride-pedal" aria-label="Right pedal"
            ref={el => { pads.current.R = el; }} {...pedalProps("R")}>D</button>
        </div>
        <div className="ride-brake">
          <button type="button" className="ride-pad ride-lever" aria-label="Brake"
            {...holdProps("brake")}>BRAKE</button>
        </div>
        <div className="ride-steer">
          <button type="button" className="ride-pad" aria-label="Steer left" {...holdProps("left")}>◀</button>
          <button type="button" className="ride-pad" aria-label="Steer right" {...holdProps("right")}>▶</button>
        </div>
      </>}
    </div>

    {status && <div className="ride-status" role={failed ? "alert" : "status"}>
      <p>{status}</p>
      {failed && <button type="button" disabled={paused} onClick={() => setRevision(value => value + 1)}>Retry</button>}
    </div>}

    {menu && <GameMenu title="Settings" onClose={() => setMenu(false)}>
      <label>
        <input type="checkbox" checked={reducedMotion} disabled={paused}
          onChange={event => setReducedMotion(event.target.checked)} /> Reduce motion
      </label>
      <label>
        <input type="checkbox" checked={!muted} disabled={paused}
          onChange={event => setMuted(!event.target.checked)} /> Sound
      </label>
      <p>Ride along the river, brake through the hairpins, climb to the summit and fly down the long descent to the finish.
        Your time, falls and top speed are shown as you roll into the valley.</p>
      <p>You start with a foot down; the first stroke pushes off.
        Pedal: <kbd>A</kbd> and <kbd>D</kbd> alternately, or the A / D pads bottom left.
        Below 20 km/h each stroke takes a moment: tap once and the pad shrinks as it pushes;
        tap the other pad when it glows. Tapping too early wastes the stroke.
        Steer: <kbd>←</kbd> <kbd>→</kbd>, or the arrow pads bottom right.
        Brake: <kbd>↓</kbd> or <kbd>Space</kbd>, or BRAKE below the arrows.</p>
      <p>The faster you go, the steadier the bicycle is, but the harder it is to turn.
        Too slow and it wobbles and falls. Turning costs speed. Brake too hard and you
        will be slow enough to wobble again.</p>
      <p>Sound: the brake squeal, the bicycle bell and a beep when you are about to fall. The speaker button (top right) or the Sound box mutes it.
        Reduce motion stops the basket bob, the pedalling sway, the speed lines and the Friend&apos;s
        animations (the bicycle&apos;s wobble is part of the controls, so it stays).</p>
      <p>Progress is not saved. Reloading starts over.</p>
      <p>No RF is spent or earned.</p>
      <button type="button" disabled={paused} onClick={restart}>Restart from the start</button>
      <button type="button" disabled={paused} onClick={() => setMenu(false)}>Back</button>
    </GameMenu>}
  </section>;
}
