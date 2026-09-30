/**
 * The words the page uses, one line each. Shown in ⓘ popovers where a term
 * first appears and together in the glossary, so the page itself can stay
 * short.
 */

export interface Term {
  term: string;
  text: string;
}

export const GLOSSARY: Record<string, Term> = {
  se: {
    term: "Shooter's ear",
    text: 'A mic beside the shooter’s head — the number closest to what you hear.',
  },
  ml: {
    term: 'Mil left, mil right',
    text: 'Mics beside the muzzle, left and right, at the MIL-STD-1474 positions: what someone next to you hears.',
  },
  p225: {
    term: '225°',
    text: 'A mic behind and above the shoulder, used in 2023 in place of mil right.',
  },
  dba: {
    term: 'dB and dBA',
    text: 'dB is raw peak pressure; dBA weights it the way ears hear, discounting low frequencies.',
  },
  leq: {
    term: 'Leq 10 ms',
    text: 'The loudest 10-millisecond average, A-weighted: how loud the shot sounds rather than its instant peak.',
  },
  impulse: {
    term: 'Impulse',
    text: 'The pressure summed over the blast, up to the point it turns negative: how hard the push is.',
  },
  pop: {
    term: 'First-round pop',
    text: 'How much louder the first shot is than the rest — usually the oxygen in a cold can burning off.',
  },
  reduction: {
    term: 'Vs bare muzzle',
    text: 'How much quieter than the same gun with no suppressor, tested the same year.',
  },
  low: {
    term: 'Below 250 Hz',
    text: 'Energy in the thump range, which dBA mostly ignores — two cans can share a dBA figure and not sound alike.',
  },
  frontier: {
    term: 'Frontier',
    text: 'Cans nothing else here beats on both axes at once. Every step along it trades one for the other.',
  },
  tie: {
    term: 'Statistical tie',
    text: 'Two cans closer together than their shot-to-shot spread can separate: 2 standard errors, combined.',
  },
  host: {
    term: 'Host',
    text: 'The gun and ammunition a can was tested on. Numbers only compare on the same host.',
  },
  years: {
    term: 'Mixed years',
    text: 'The test setup differs between Summits: cans tested in more than one year have measured up to 5 dB apart.',
  },
};
