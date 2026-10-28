export const mtof = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/** Glide a param to a value at `time` without clicks. */
export function smooth(param: AudioParam, value: number, time: number, tc = 0.015) {
  param.setTargetAtTime(value, time, tc);
}

/** Stop whatever an envelope is doing at `time` and head to `target`. */
export function releaseTo(param: AudioParam, target: number, time: number, release: number) {
  const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(time);
  else param.cancelScheduledValues(time);
  param.setTargetAtTime(target, time, Math.max(0.001, release / 4));
}

export const at = (ctx: BaseAudioContext, time: number) => Math.max(time, ctx.currentTime);
