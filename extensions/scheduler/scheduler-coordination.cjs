"use strict";

function reconcileSnapshot(snapshot, currentRevision, install, reconcile) {
	if (snapshot.revision <= currentRevision) return false;
	install(snapshot.tasks, snapshot.revision);
	reconcile();
	return true;
}

function needsInterruptedRunRecovery(tasks, isOwnerActive) {
	return tasks.some((task) => task.status === "running" && !isOwnerActive(task.runOwner));
}

async function refreshSchedulerState(options) {
	let snapshot = await options.store.read();
	if (needsInterruptedRunRecovery(snapshot.tasks, options.isOwnerActive)) {
		const transaction = await options.store.transact((tasks) =>
			options.recoverInterrupted(tasks, options.now(), { isOwnerActive: options.isOwnerActive }),
		);
		snapshot = transaction;
	}
	return reconcileSnapshot(snapshot, options.currentRevision(), options.install, options.reconcile);
}

// Timers have no caller to consume a rejected promise. Keep both the work and
// its error reporter inside the boundary (a stale UI can fail while reporting).
async function runInBackground(run, onError) {
	try {
		await run();
	} catch (error) {
		try {
			await onError?.(error);
		} catch {
			// Never turn an error-reporting failure into an unhandled rejection.
		}
	}
}

function createRefreshLoop(options) {
	let handle;
	let inFlight = false;

	async function tick(generation) {
		if (inFlight) return;
		inFlight = true;
		try {
			await runInBackground(() => options.run(generation), options.onError);
		} finally {
			inFlight = false;
		}
	}

	function stop() {
		if (handle !== undefined) options.clearInterval(handle);
		handle = undefined;
	}

	function start(generation) {
		stop();
		handle = options.setInterval(() => tick(generation), options.intervalMs);
		handle?.unref?.();
	}

	return { start, stop, tick };
}

module.exports = { createRefreshLoop, reconcileSnapshot, refreshSchedulerState, runInBackground };
