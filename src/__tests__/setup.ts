/**
 * Test-environment patches shared by every suite (guarded so the node-only
 * suites pay nothing).
 *
 * happy-dom ≥ 20 rejects an animation's `finished` promise with an AbortError
 * when it is cancelled. motion-dom cancels animations during cleanup without
 * awaiting that promise, so the rejection escapes as an unhandled error and
 * fails the whole vitest run — even when every assertion passed. Attach the
 * handler at the cancel call, BEFORE the real cancel rejects: the genuine
 * cancel still runs (timer cleanup, playState reset, cancel event), so no
 * dangling timer survives into the next test. Browsers surface this
 * cancellation through `oncancel`, which motion-dom does handle.
 */
if (typeof globalThis.Animation !== "undefined") {
	const originalCancel = globalThis.Animation.prototype.cancel;
	globalThis.Animation.prototype.cancel = function cancelPatched(this: Animation) {
		this.finished?.catch?.(() => {});
		return originalCancel.call(this);
	};
}
