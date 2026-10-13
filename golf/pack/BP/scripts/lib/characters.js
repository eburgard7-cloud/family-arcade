// Golfer roster, Mario Golf style: everyone has a power, a control, a spin
// stat and a natural shot shape. All original characters.
//
// power   multiplies full-swing distance
// control multiplies the size of the "perfect" window and slows the meter
// spin    multiplies backspin/topspin effects
// shape   natural curve, degrees of spin-axis tilt: + draw (curves left), - fade
// height  extra launch angle in degrees

export const GOLFERS = [
  {
    id: "bea", name: "Birdie Bea", blurb: "All-rounder. Straight as a fence post.",
    power: 1.0, control: 1.0, spin: 1.0, shape: 0, height: 0,
  },
  {
    id: "moose", name: "Big Moose", blurb: "Bombs it. Fades it. Don't stand on the right.",
    power: 1.14, control: 0.8, spin: 0.85, shape: -5, height: -1,
  },
  {
    id: "ace", name: "Ace Marlow", blurb: "Hits the spot every time. Not the longest.",
    power: 0.93, control: 1.3, spin: 1.05, shape: 0, height: 0,
  },
  {
    id: "pete", name: "Pirate Pete", blurb: "Spin wizard. Draws it around the trees.",
    power: 0.98, control: 0.95, spin: 1.4, shape: 4, height: 1,
  },
  {
    id: "sprout", name: "Lil' Sprout", blurb: "Easy to swing, big sweet spot. Great first golfer.",
    power: 0.86, control: 1.6, spin: 0.9, shape: 0, height: 2,
  },
  {
    id: "fins", name: "Captain Fins", blurb: "High, soft, sticks it on the green.",
    power: 1.05, control: 0.9, spin: 1.2, shape: -2, height: 3,
  },
];

export const golferById = (id) => GOLFERS.find((g) => g.id === id) ?? GOLFERS[0];

/** Stat bars for menus, 0..5 stars. */
export function statStars(g) {
  const s = (v, lo, hi) => Math.max(1, Math.min(5, Math.round(1 + ((v - lo) / (hi - lo)) * 4)));
  return {
    power: s(g.power, 0.85, 1.15),
    control: s(g.control, 0.8, 1.6),
    spin: s(g.spin, 0.85, 1.4),
  };
}
