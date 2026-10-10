export interface ClockState {
  anchor: number;
  wallAnchor: number;
  paused: boolean;
}
export function now(clock: ClockState, wallTime: number): number {
  return (
    clock.anchor + (clock.paused ? 0 : Math.max(0, wallTime - clock.wallAnchor))
  );
}
export function setClock(
  clock: ClockState,
  wallTime: number,
  paused: boolean,
  advanceMs = 0,
): void {
  clock.anchor = now(clock, wallTime) + advanceMs;
  clock.wallAnchor = wallTime;
  clock.paused = paused;
}
