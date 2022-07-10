/**
 * @license
 * Copyright (C) 2022  WofWca <wofwca@protonmail.com>
 *
 * This file is part of Jump Cutter Browser Extension.
 *
 * Jump Cutter Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Jump Cutter Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Jump Cutter Browser Extension.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * A list of values we recently assigned to the corresponding HTMLMediaElement's playbackRate.
 * The array may contain duplicate values (e.g. [2.5, 1, 2.5, 2.5]).
 */
const recentPlaybackRateChangesCausedByUs = new WeakMap<HTMLMediaElement, number[]>();
/** @see {@link recentPlaybackRateChangesCausedByUs} */
const recentDefaultPlaybackRateChangesCausedByUs = new WeakMap<HTMLMediaElement, number[]>();

function rememberChangeAndForgetAfterEventListenersWereExecuted(
  recentChangesMap:
    typeof recentPlaybackRateChangesCausedByUs
    | typeof recentDefaultPlaybackRateChangesCausedByUs,
  el: HTMLMediaElement,
  newVal: number
) {
  const maybeExistingArray = recentChangesMap.get(el);
  let array: number[];
  if (!maybeExistingArray) {
    array = [newVal];
    recentChangesMap.set(el, array)
  } else {
    array = maybeExistingArray;
    maybeExistingArray.push(newVal);
  }
  // A signle setTimeout may be enough, but let's play it safe.
  setTimeout(() => setTimeout(() => {
    array.splice(
      array.findIndex(storedVal => storedVal === newVal),
      1,
    )
  }));
  // You may ask why don't we use `event.timeStamp` and `performance.now()` to record the changes
  // caused by us. That's because of reduced time precision:
  // https://developer.mozilla.org/en-US/docs/Web/API/Event/timeStamp#reduced_time_precision
  // We can't rely on it to accurately determine when the assignment was performed.
}

// TODO how about write an ESLint rule that prohibits the use assignment to `playbackRate`
// so the devs don't forget to call these?

// TODO these are unnecessary when `!settings.updateSoundedSpeedWheneverItChangesOnWebsite`.

/**
 * This must be used instead of `el.playbackRate =`
 */
export function setPlaybackRateAndDoRelatedStuff(el: HTMLMediaElement, newVal: number) {
  el.playbackRate = newVal;
  rememberChangeAndForgetAfterEventListenersWereExecuted(
    recentPlaybackRateChangesCausedByUs,
    el,
    newVal,
  );
}
/**
 * @see {@link setPlaybackRateAndDoRelatedStuff}
 */
export function setDefaultPlaybackRateAndDoRelatedStuff(el: HTMLMediaElement, newVal: number) {
  el.defaultPlaybackRate = newVal;
  rememberChangeAndForgetAfterEventListenersWereExecuted(
    recentDefaultPlaybackRateChangesCausedByUs,
    el,
    newVal,
  );
}

/**
 * @returns If `false` then it's 100% not caused by us (unless I'm stupid). If `true`,
 * it may be either.
 */
export function mayRatechangeEventBeCausedByUs(event: Event): boolean {
  // Well, actually if there were several assignments to `playbackRate` in the same event cycle,
  // several 'ratechange' events will be fired, one of which may be caused by us, while another isn't.
  // But if the new `playbackRate` value is not among the values we assigned to it, it must mean that
  // at least one of them not caused by us, so let's return `true` in this case.
  // TODO Rename the function then? `mustIgnoreRatechangeEvent`?

  // TODO Idk if after `playbackRate` assignment the resulting `playbackRate`
  // is always equal to the value it was assigned, without any rounding / truncation / something else.
  // It appears to be of type `double`, and there's nothing about value transformation in the spec
  // so it should be:
  // https://html.spec.whatwg.org/multipage/media.html#media-elements

  const el = event.target as HTMLMediaElement;
  if (recentPlaybackRateChangesCausedByUs.get(el)?.includes(el.playbackRate)) {
    return true;
  }
  if (recentDefaultPlaybackRateChangesCausedByUs.get(el)?.includes(el.defaultPlaybackRate)) {
    return true;
  }
  return false;
}
