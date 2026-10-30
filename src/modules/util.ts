export const mtof = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/** Glide a param to a value at `time` without clicks. */
export function smooth(param: AudioParam, value: number, time: number, tc = 0.015) {
  param.setTargetAtTime(value, time, tc);
}

/** Freeze an automated param at whatever value it has at `time`, dropping later automation. */
export function holdAt(param: AudioParam, time: number) {
  const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(time);
  else param.cancelScheduledValues(time);
}

/** Stop whatever an envelope is doing at `time` and head to `target`. */
export function releaseTo(param: AudioParam, target: number, time: number, release: number) {
  holdAt(param, time);
  param.setTargetAtTime(target, time, Math.max(0.001, release / 4));
}

/** Start an ADSR at `time` from wherever the param is now: ramp to `peak`, then fall to `peak * sustain`. */
export function attackTo(param: AudioParam, peak: number, sustain: number, time: number, attack: number, decay: number) {
  holdAt(param, time);
  param.linearRampToValueAtTime(peak, time + attack);
  param.setTargetAtTime(peak * sustain, time + attack, Math.max(0.001, decay / 3));
}

export const at = (ctx: BaseAudioContext, time: number) => Math.max(time, ctx.currentTime);
