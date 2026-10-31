/**
 * AI MediaKit 画质增强（大模型）at 2K and ≤30fps.
 * Fee = output minutes × coefficient 4 × 2.5 yuan/min = 10 yuan/min.
 */
export const ENHANCE_YUAN_PER_MIN = 10;

export interface EnhanceCost {
  readonly yuanPerMin: number;
  readonly minutes?: number;
  readonly yuan?: number;
  readonly text: string;
}

const LABEL = "enhance-video-generative 2k 30fps";

/** Estimate from the source duration. Billing uses the output duration, which this enhance keeps. */
export function enhanceCost(durationSec: number | undefined): EnhanceCost {
  const yuanPerMin = ENHANCE_YUAN_PER_MIN;
  if (durationSec === undefined || !Number.isFinite(durationSec) || !(durationSec > 0)) {
    return { yuanPerMin, text: `estimate: ${yuanPerMin} yuan/min (${LABEL})` };
  }
  const minutes = durationSec / 60;
  const yuan = minutes * yuanPerMin;
  return {
    yuanPerMin,
    minutes,
    yuan,
    text: `estimate: ${yuan.toFixed(2)} yuan (${minutes.toFixed(3)} min × ${yuanPerMin} yuan/min, ${LABEL})`,
  };
}
