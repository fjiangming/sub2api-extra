'use strict';

function createUsageProfiles(distribution, random) {
  let profiles;
  if (distribution === 'close') {
    const center = .6 + random() * .2;
    const width = .08 + random() * .12;
    const share = .5 + random() * .2;
    profiles = Array.from({ length: 10 }, () => ({
      weight: center + (random() - .5) * width, share: share + (random() - .5) * .08
    }));
  } else if (distribution === 'concentrated') {
    const leaders = 1 + Math.floor(random() * 2);
    profiles = Array.from({ length: 10 }, (_, index) => index < leaders
      ? { weight: .8 + random() * .18, share: .62 + random() * .25 }
      : { weight: .01 + Math.pow(random(), 1.7) * .3, share: .15 + random() * .5 });
  } else {
    const low = .01 + random() * .05;
    const high = .8 + random() * .18;
    const shape = .8 + random() * .8;
    profiles = Array.from({ length: 10 }, (_, index) => ({
      weight: index === 0 ? low : index === 1 ? high : low + (high - low) * Math.pow(random(), shape),
      share: .25 + random() * .65
    }));
  }
  for (let index = profiles.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [profiles[index], profiles[other]] = [profiles[other], profiles[index]];
  }
  return profiles;
}

module.exports = { createUsageProfiles };
