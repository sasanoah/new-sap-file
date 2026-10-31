export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };


/** Real time plus an adjustable offset: lets tests jump ahead while staying consistent with DB timestamps. */
export class OffsetClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}
