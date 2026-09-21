/**
 * Test-environment patches shared by every suite (guarded so the node-only
 * suites pay nothing).
 *
 * happy-dom ≥ 20 makes `Animation.cancel()` reject the animation's finished
 * promise with an AbortError. motion-dom cancels animations during cleanup
 * without awaiting that promise, so the rejection escapes as an unhandled
 * error and fails the whole vitest run — even though every assertion passed.
 * Browsers surface the same cancellation through `oncancel`, which motion-dom
 * does handle. Cancel silently here: these suites assert on DOM structure and
 * classes, never on animation promises.
 */
if (typeof globalThis.Animation !== "undefined") {
	globalThis.Animation.prototype.cancel = function cancel() {};
}
