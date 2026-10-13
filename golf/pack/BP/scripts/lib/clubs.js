// The bag. Distances are real-world meters at full power for a 1.00-power golfer
// on a flat fairway with no wind. Ball speed per club is solved at load time so
// the simulated carry hits `carry` exactly (see physics.calibrate).

export const CLUBS = [
  { id: "driver", name: "Driver", short: "1W", carry: 210, launch: 13.0, spinRpm: 2800 },
  { id: "w3", name: "3 Wood", short: "3W", carry: 188, launch: 12.0, spinRpm: 3700 },
  { id: "w5", name: "5 Wood", short: "5W", carry: 172, launch: 13.5, spinRpm: 4300 },
  { id: "i4", name: "4 Iron", short: "4I", carry: 160, launch: 13.5, spinRpm: 4800 },
  { id: "i5", name: "5 Iron", short: "5I", carry: 150, launch: 14.5, spinRpm: 5200 },
  { id: "i6", name: "6 Iron", short: "6I", carry: 140, launch: 16.0, spinRpm: 6000 },
  { id: "i7", name: "7 Iron", short: "7I", carry: 129, launch: 18.5, spinRpm: 6800 },
  { id: "i8", name: "8 Iron", short: "8I", carry: 118, launch: 20.5, spinRpm: 7600 },
  { id: "i9", name: "9 Iron", short: "9I", carry: 106, launch: 23.0, spinRpm: 8400 },
  { id: "pw", name: "Pitching Wedge", short: "PW", carry: 95, launch: 26.0, spinRpm: 9200 },
  { id: "sw", name: "Sand Wedge", short: "SW", carry: 75, launch: 32.0, spinRpm: 10000 },
  { id: "putter", name: "Putter", short: "PT", carry: 0, launch: 0, spinRpm: 0, putter: true },
];

export const CLUB_INDEX = Object.fromEntries(CLUBS.map((c, i) => [c.id, i]));
export const clubById = (id) => CLUBS[CLUB_INDEX[id] ?? 0];

/** Putter "ranges" in meters, like Mario Golf's putter power settings. */
export const PUTT_RANGES = [4, 8, 15, 25, 40];
export const pickPuttRange = (distM) => PUTT_RANGES.find((r) => r >= distM * 1.25) ?? PUTT_RANGES[PUTT_RANGES.length - 1];
