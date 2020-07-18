'use strict';

import { PitchShift, connect as ToneConnect, setContext as toneSetContext } from 'tone';
import defaultSettings from '../defaultSettings.json';

/**
 * @typedef Settings
 * @type {typeof defaultSettings}
 */

// Assuming normal speech speed. Looked here https://en.wikipedia.org/wiki/Sampling_(signal_processing)#Sampling_rate
const MIN_HUMAN_SPEECH_ADEQUATE_SAMPLE_RATE = 8000;
const MAX_MARGIN_BEFORE_VIDEO_TIME = 0.5;
// Not just MIN_SOUNDED_SPEED, because in theory sounded speed could be greater than silence speed.
const MIN_SPEED = 0.25;
const MAX_MARGIN_BEFORE_REAL_TIME = MAX_MARGIN_BEFORE_VIDEO_TIME / MIN_SPEED;

const logging = process.env.NODE_ENV !== 'production';

function getRealtimeMargin(marginBefore, speed) {
  return marginBefore / speed;
}

function getNewLookaheadDelay(videoTimeMargin, soundedSpeed, silenceSpeed) {
  return videoTimeMargin / Math.min(soundedSpeed, silenceSpeed)
}
function getTotalDelay(lookaheadNodeDelay, stretcherNodeDelay) {
  return lookaheadNodeDelay + stretcherNodeDelay;
}
function getNewSnippetDuration(originalRealtimeDuration, originalSpeed, newSpeed) {
  const videoSpeedSnippetDuration = originalRealtimeDuration * originalSpeed;
  return videoSpeedSnippetDuration / newSpeed;
}
// The delay that the stretcher node is going to have when it's done slowing down a snippet
function getStretcherDelayChange(snippetOriginalRealtimeDuration, originalSpeed, newSpeed) {
  const snippetNewDuration = getNewSnippetDuration(snippetOriginalRealtimeDuration, originalSpeed, newSpeed);
  const delayChange = snippetNewDuration - snippetOriginalRealtimeDuration;
  return delayChange;
}
// TODO Is it always constant though? What about these short silence snippets, where we don't have to fully reset the margin?
function getStretcherSoundedDelay(videoTimeMarginBefore, soundedSpeed, silenceSpeed) {
  const realTimeMarginBefore = videoTimeMarginBefore / silenceSpeed;
  const delayChange = getStretcherDelayChange(realTimeMarginBefore, silenceSpeed, soundedSpeed);
  return 0 + delayChange;
}
function getStretchSpeedChangeMultiplier({ startValue, endValue, startTime, endTime }) {
  return ((endTime - startTime) + (startValue - endValue)) / (endTime - startTime);
}

/**
 * The holy grail of this algorithm.
 * Answers the question "When is the sample that has been on the input at `momentTime` going to appear on the output?"
 * Contract:
 * * Only works for input values such that the correct answer is after the `lastScheduledStretcherDelayReset`'s start time.
 * * Assumes the video is never played backwards (i.e. stretcher delay never so quickly).
 */
function getMomentOutputTime(momentTime, lookaheadDelay, lastScheduledStretcherDelayReset) {
  const stretch = lastScheduledStretcherDelayReset;
  const stretchEndTotalDelay = getTotalDelay(lookaheadDelay, stretch.endValue);
  // Simpliest case. The target moment is after the `stretch`'s end time
  // TODO DRY `const asdadsd = momentTime + stretchEndTotalDelay;`?
  if (momentTime + stretchEndTotalDelay >= stretch.endTime) {
    return momentTime + stretchEndTotalDelay;
  } else {
    // `lastScheduledStretcherDelayReset` is going to be in progress when the target moment is on the output.

    // At which point between its start and end would the target moment be played if we were to not actually change the
    // delay ?
    const originalTargetMomentOffsetRelativeToStretchStart =
      momentTime + getTotalDelay(lookaheadDelay, stretch.startValue) - stretch.startTime;
    // By how much the snippet is going to be stretched?
    const playbackSpeedupDuringStretch = getStretchSpeedChangeMultiplier(stretch);
    // How much time will pass since the stretch start until the target moment is played on the output?
    const finalTargetMomentOffsetRelativeToStretchStart =
      originalTargetMomentOffsetRelativeToStretchStart / playbackSpeedupDuringStretch;
    return stretch.startTime + finalTargetMomentOffsetRelativeToStretchStart;
  }
}

class PitchPreservingStretcherNode {
  // 2 pitch shifts and 3 gains because `.pitch` of `PitchShift` is not an AudioParam, therefore doesn't support
  // scheduling.

  /**
   * @param {AudioContext} context
   */
  constructor(context, maxDelay, initialDelay=0) {
    this.context = context;

    this.speedUpGain = context.createGain();
    this.slowDownGain = context.createGain();
    this.normalSpeedGain = context.createGain();

    this.speedUpPitchShift = new PitchShift();
    this.slowDownPitchShift = new PitchShift();

    // Why this value?
    // 1. Withing the range recommended by Tone.js documentation:
    // https://tonejs.github.io/docs/13.8.25/PitchShift#windowsize
    // 2. I played around with it a bit and this sounded best for me.
    // TODO make it into a setting?
    const windowSize = 0.06;
    this.speedUpPitchShift.windowSize = windowSize;
    this.slowDownPitchShift.windowSize = windowSize;

    this.delayNode = context.createDelay(maxDelay);
    this.delayNode.delayTime.value = initialDelay;

    ToneConnect(this.delayNode, this.speedUpPitchShift);
    ToneConnect(this.delayNode, this.slowDownPitchShift);

    this.delayNode.connect(this.normalSpeedGain);

    this.speedUpPitchShift.connect(this.slowDownGain);
    this.slowDownPitchShift.connect(this.speedUpGain);

    this.setOutputPitchAt('normal', context.currentTime);
  }

  get allGainNodes() {
    return [
      this.speedUpGain,
      this.slowDownGain,
      this.normalSpeedGain,
    ];
  }

  /**
   * @param {AudioNode} sourceNode
   */
  connectInputFrom(sourceNode) {
    sourceNode.connect(this.delayNode);
  }
  /**
   * @param {AudioNode} destinationNode
   */
  connectOutputTo(destinationNode) {
    for (const node of this.allGainNodes) {
      node.connect(destinationNode);
    }
  }

  /**
   * @param {'slowdown' | 'speedup' | 'normal'} pitchSetting
   */
  setOutputPitchAt(pitchSetting, time) {
    if (process.env.NODE_ENV !== 'production') {
      if (!['slowdown', 'speedup', 'normal'].includes(pitchSetting)) {
        // TODO replace with TypeScript?
        throw new Error(`Invalid pitchSetting "${pitchSetting}"`);
      }
    }

    this.speedUpGain    .gain.setValueAtTime(pitchSetting === 'speedup'  ? 1 : 0, time);
    this.slowDownGain   .gain.setValueAtTime(pitchSetting === 'slowdown' ? 1 : 0, time);
    this.normalSpeedGain.gain.setValueAtTime(pitchSetting === 'normal'   ? 1 : 0, time);
  }

  stretch(startValue, endValue, startTime, endTime) {
    if (startValue === endValue) {
      return;
    }

    this.delayNode.delayTime
      .setValueAtTime(startValue, startTime)
      .linearRampToValueAtTime(endValue, endTime);
    const speedupOrSlowdown = endValue > startValue ? 'slowdown' : 'speedup';
    this.setOutputPitchAt(
      speedupOrSlowdown,
      startTime
    );
    this.setOutputPitchAt('normal', endTime);
    
    const speedChangeMultiplier = getStretchSpeedChangeMultiplier({ startValue, endValue, startTime, endTime });
    // Acutally we only need to do this when the user changes settings.
    setTimeout(() => {
      function speedChangeMultiplierToSemitones(m) {
        return -12 * Math.log2(1 / m);
      }
      const node = speedupOrSlowdown === 'speedup'
        ? this.speedUpPitchShift
        : this.slowDownPitchShift;
      node.pitch = speedChangeMultiplierToSemitones(speedChangeMultiplier);
    }, startTime - this.context.currentTime);
  }

  /**
   * @param {number} interruptAtTime the time at which to stop changing the delay.
   * @param {number} interruptAtTimeValue the value of the delay at `interruptAtTime`
   */
  interruptLastScheduledStretch(interruptAtTimeValue, interruptAtTime) {
    // We don't need to specify the start time since it has been scheduled before in the `stretch` method
    this.delayNode.delayTime
      .cancelAndHoldAtTime(interruptAtTime)
      .linearRampToValueAtTime(interruptAtTimeValue, interruptAtTime);

    for (const node of this.allGainNodes) {
      node.gain.cancelAndHoldAtTime(interruptAtTime);
    }
    this.setOutputPitchAt('normal', interruptAtTime);
  }

  /**
   * @param {number} value
   */
  setDelay(value) {
    this.delayNode.value = value;
  }
}

export default class Controller {
  /**
   * @param {HTMLVideoElement} videoElement
   * @param {Settings} settings
   */
  constructor(videoElement, settings) {
    this.element = videoElement;
    this.settings = settings;
  }

  async init() {
    this.element.playbackRate = this.settings.soundedSpeed;

    const ctx = new AudioContext();
    toneSetContext(ctx);
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('SilenceDetectorProcessor.js'));
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('VolumeFilter.js'));

    const maxSpeedToPreserveSpeech = ctx.sampleRate / MIN_HUMAN_SPEECH_ADEQUATE_SAMPLE_RATE;
    const maxMaginStretcherDelay = MAX_MARGIN_BEFORE_REAL_TIME * (maxSpeedToPreserveSpeech / MIN_SPEED);

    const volumeFilter = new AudioWorkletNode(ctx, 'VolumeFilter', {
      processorOptions: {
        maxSmoothingWindowLength: 0.03,
      },
      parameterData: {
        smoothingWindowLength: 0.03, // TODO make a setting out of it.
      },
    });
    const silenceDetectorNode = new AudioWorkletNode(ctx, 'SilenceDetectorProcessor', {
      parameterData: {
        durationThreshold: Controller._getSilenceDetectorNodeDurationThreshold(
          this.settings.marginBefore,
          this.settings.soundedSpeed
        ),
      },
      processorOptions: { initialDuration: 0 },
      numberOfOutputs: 0,
    });
    this._silenceDetectorNode = silenceDetectorNode;
    const analyzerIn = ctx.createAnalyser();
    const analyzerOut = ctx.createAnalyser();
    const outVolumeFilter = new AudioWorkletNode(ctx, 'VolumeFilter');
    const lookahead = ctx.createDelay(MAX_MARGIN_BEFORE_REAL_TIME);
    this._lookahead = lookahead;
    const stretcher = new PitchPreservingStretcherNode(ctx, maxMaginStretcherDelay);
    this._stretcher = stretcher;
    const src = ctx.createMediaElementSource(this.element);
    src.connect(lookahead);
    src.connect(volumeFilter);
    volumeFilter.connect(silenceDetectorNode);
    volumeFilter.connect(analyzerIn);
    stretcher.connectInputFrom(lookahead);
    stretcher.connectOutputTo(ctx.destination);
    stretcher.connectOutputTo(outVolumeFilter);
    outVolumeFilter.connect(analyzerOut);
    this._setStateAccordingToSettings(this.settings);

    let lastScheduledStretcherDelayReset = null;

    const logArr = [];
    const logBuffer = new Float32Array(analyzerOut.fftSize);
    const log = (msg = null) => {
      analyzerOut.getFloatTimeDomainData(logBuffer);
      const outVol = logBuffer[logBuffer.length - 1];
      analyzerIn.getFloatTimeDomainData(logBuffer);
      const inVol = logBuffer[logBuffer.length - 1];
      logArr.push({
        msg,
        t: ctx.currentTime,
        // delay: stretcherInitialDelay, // TODO fix this. It's not `initialDelay` it should be `stretcher.delay`
        speed: this.element.playbackRate,
        inVol,
        outVol,
      });
    }

    silenceDetectorNode.port.onmessage = (msg) => {
      const { time: eventTime, type: silenceStartOrEnd } = msg.data;
      if (silenceStartOrEnd === 'silenceEnd') {
        this.element.playbackRate = this.settings.soundedSpeed;

        // TODO all this does look like it may cause a snowballing floating point error. Mathematically simplify this?
        // Or just use if-else?

        const lastSilenceSpeedLastsForRealtime = eventTime - lastScheduledStretcherDelayReset.newSpeedStartInputTime;
        const lastSilenceSpeedLastsForVideoTime = lastSilenceSpeedLastsForRealtime * this.settings.silenceSpeed;

        const marginBeforePartAtSilenceSpeedVideoTimeDuration = Math.min(
          lastSilenceSpeedLastsForVideoTime,
          this.settings.marginBefore
        );
        const marginBeforePartAlreadyAtSoundedSpeedVideoTimeDuration =
          this.settings.marginBefore - marginBeforePartAtSilenceSpeedVideoTimeDuration;
        const marginBeforePartAtSilenceSpeedRealTimeDuration =
          marginBeforePartAtSilenceSpeedVideoTimeDuration / this.settings.silenceSpeed;
        const marginBeforePartAlreadyAtSoundedSpeedRealTimeDuration =
          marginBeforePartAlreadyAtSoundedSpeedVideoTimeDuration / this.settings.soundedSpeed;
        // The time at which the moment from which the speed of the video needs to be slow has been on the input.
        const marginBeforeStartInputTime =
          eventTime
          - marginBeforePartAtSilenceSpeedRealTimeDuration
          - marginBeforePartAlreadyAtSoundedSpeedRealTimeDuration;
        // Same, but when it's going to be on the output.
        const marginBeforeStartOutputTime = getMomentOutputTime(
          marginBeforeStartInputTime,
          lookahead.delayTime.value,
          lastScheduledStretcherDelayReset
        );
        const marginBeforeStartOutputTimeTotalDelay = marginBeforeStartOutputTime - marginBeforeStartInputTime;
        const marginBeforeStartOutputTimeStretcherDelay =
          marginBeforeStartOutputTimeTotalDelay - lookahead.delayTime.value;

        // As you remember, silence on the input must last for some time before we speed up the video.
        // We then speed up these sections by reducing the stretcher delay.
        // And sometimes we may stumble upon a silence period long enough to make us speed up the video, but short
        // enough for us to not be done with speeding up that last part, so the margin before and that last part
        // overlap, and we end up in a situation where we only need to stretch the last part of the margin before
        // snippet, because the first one is already at required (sounded) speed, due to that delay before we speed up
        // the video after some silence.
        // This is also the reason why `getMomentOutputTime` function is so long.
        // Let's find this breakpoint.

        if (marginBeforeStartOutputTime < lastScheduledStretcherDelayReset.endTime) {
          // Cancel the complete delay reset, and instead stop decreasing it at `marginBeforeStartOutputTime`.
          stretcher.interruptLastScheduledStretch(
            // A.k.a. `lastScheduledStretcherDelayReset.startTime`
            marginBeforeStartOutputTimeStretcherDelay,
            marginBeforeStartOutputTime
          );
          if (logging) {
            log({
              type: 'pauseReset',
              value: marginBeforeStartOutputTimeStretcherDelay,
              time: marginBeforeStartOutputTime,
            });
          }
        }

        const marginBeforePartAtSilenceSpeedStartOutputTime =
          marginBeforeStartOutputTime + marginBeforePartAlreadyAtSoundedSpeedRealTimeDuration
        // const silenceSpeedPartStretchedDuration = getNewSnippetDuration(
        //   marginBeforePartAtSilenceSpeedRealTimeDuration,
        //   this.settings.silenceSpeed,
        //   this.settings.soundedSpeed
        // );
        const stretcherDelayIncrease = getStretcherDelayChange(
          marginBeforePartAtSilenceSpeedRealTimeDuration,
          this.settings.silenceSpeed,
          this.settings.soundedSpeed
        );
        // I think currently it should always be equal to the max delay.
        const finalStretcherDelay = marginBeforeStartOutputTimeStretcherDelay + stretcherDelayIncrease;
        stretcher.stretch(
          marginBeforeStartOutputTimeStretcherDelay,
          finalStretcherDelay,
          marginBeforePartAtSilenceSpeedStartOutputTime,
          // A.k.a. `marginBeforePartAtSilenceSpeedStartOutputTime + silenceSpeedPartStretchedDuration`
          eventTime + getTotalDelay(lookahead.delayTime.value, finalStretcherDelay)
        );
        if (logging) {
          log({
            type: 'stretch',
            startValue: marginBeforeStartOutputTimeStretcherDelay,
            endValue: finalStretcherDelay,
            startTime: marginBeforePartAtSilenceSpeedStartOutputTime,
            endTime: eventTime + getTotalDelay(lookahead.delayTime.value, finalStretcherDelay)
          });
        }
      } else {
        // (Almost) same calculations as obove.
        this.element.playbackRate = this.settings.silenceSpeed;

        const oldRealtimeMargin = getRealtimeMargin(this.settings.marginBefore, this.settings.soundedSpeed);
        // When the time comes to increase the video speed, the stretcher's delay is always at its max value.
        const stretcherDelayStartValue =
          getStretcherSoundedDelay(this.settings.marginBefore, this.settings.soundedSpeed, this.settings.silenceSpeed);
        const startIn = getTotalDelay(lookahead.delayTime.value, stretcherDelayStartValue) - oldRealtimeMargin;

        const speedUpBy = this.settings.silenceSpeed / this.settings.soundedSpeed;

        const originalRealtimeSpeed = 1;
        const delayDecreaseSpeed = speedUpBy - originalRealtimeSpeed;
        const snippetNewDuration = stretcherDelayStartValue / delayDecreaseSpeed;
        const startTime = eventTime + startIn;
        const endTime = startTime + snippetNewDuration;
        stretcher.stretch(
          stretcherDelayStartValue,
          0,
          startTime,
          endTime
        );
        lastScheduledStretcherDelayReset = {
          newSpeedStartInputTime: eventTime,
          startTime,
          startValue: stretcherDelayStartValue,
          endTime,
          endValue: 0,
        };

        if (logging) {
          log({
            type: 'reset',
            startValue: stretcherDelayStartValue,
            startTime: startTime,
            endTime: endTime,
            lastScheduledStretcherDelayReset,
          });
        }
      }
    }
    if (logging) {
      setInterval(() => {
        log();
      }, 1);
    }

    return this;
  }

  /**
   * Can be called either when initializing or when updating settings.
   * TODO It's more performant to only update the things that rely on settings that changed, in a reactive way, but for
   * now it's like this so its harder to forget to update something.
   * @param {Settings} newSettings
   * @param {Settings | null} oldSettings - better to provide this so the current state can be reconstructed and
   * respected (e.g. if a silent part is currently playing it wont change speed to sounded speed as it would if the
   * parameter is omitted).
   * TODO maybe it's better to just store the state on the class instance?
   */
  _setStateAccordingToSettings(newSettings, oldSettings = null) {
    if (!oldSettings) {
      this.element.playbackRate = this.settings.soundedSpeed;
    } else {
      const currSpeedName = ['silenceSpeed', 'soundedSpeed'].find(
        speedSettingName => this.element.playbackRate === oldSettings[speedSettingName]
      );
      if (currSpeedName) {
        this.element.playbackRate = newSettings[currSpeedName];
      }
    }

    this._silenceDetectorNode.parameters.get('volumeThreshold').value = newSettings.volumeThreshold;
    this._silenceDetectorNode.parameters.get('durationThreshold').value =
      Controller._getSilenceDetectorNodeDurationThreshold(newSettings.marginBefore, newSettings.soundedSpeed);
    this._lookahead.delayTime.value = getNewLookaheadDelay(
      newSettings.marginBefore,
      newSettings.soundedSpeed,
      newSettings.silenceSpeed
    );
    this._stretcher.setDelay(
      getStretcherSoundedDelay(this.settings.marginBefore, this.settings.soundedSpeed, this.settings.silenceSpeed)
    );
  }

  /**
   * Can be called before the instance has been initialized.
   * @param {Partial<Settings>} newChangedSettings
   */
  updateSettings(newChangedSettings) {
    const oldSettings = this.settings;
    /**
     * @type {Settings} For me intellisense sets `this.settings` to `any` if I remove this. Time to move to TypeScript.
     */
    const newSettings = {
      ...this.settings,
      ...newChangedSettings,
    };

    this._setStateAccordingToSettings(newSettings, oldSettings);

    this.settings = newSettings;
  }

  static _getSilenceDetectorNodeDurationThreshold(marginBefore, soundedSpeed) {
    return getRealtimeMargin(marginBefore, soundedSpeed);
  }
}
