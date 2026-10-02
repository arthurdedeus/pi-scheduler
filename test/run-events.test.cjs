"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { harness, until } = require("./helpers/runtime-harness.cjs");

const ROOT = resolve(__dirname, "..");

function runMessages(h) {
	return h.messages.filter(({ message }) => message.details?.run);
}

async function runOnce(exec, configure = () => {}, args = {}) {
	const h = await harness(ROOT, exec);
	configure(h);
	await h.start();
	await h.call("schedule_task", { action: "shell", type: "once", schedule: "0.02s", command: "check", ...args });
	await until(async () => (await h.tasks())[0]?.runCount === 1, "run completed");
	return h;
}

test("a shell run sends a hidden start and an end on the result message, sharing one attempt id", async () => {
	const h = await runOnce(async () => ({ code: 0, stdout: "ok", stderr: "" }), () => {}, { timeoutMs: 1234 });
	try {
		const [start, end] = runMessages(h);
		assert.equal(runMessages(h).length, 2);
		assert.equal(start.message.customType, "scheduled-task");
		assert.equal(start.message.display, false);
		assert.equal(start.options.triggerTurn, false);
		assert.equal(start.message.details.run.phase, "start");
		assert.equal(start.message.details.run.version, 1);
		assert.equal(start.message.details.run.timeoutMs, 1234);
		assert.ok(Number.isFinite(Date.parse(start.message.details.run.startedAt)));
		assert.equal(start.message.details.run.notice, undefined, "no notice without a UI");
		assert.equal(start.message.details.task.action, "shell");

		assert.equal(end.message.display, true);
		assert.match(end.message.content, /finished with exit code 0/);
		assert.equal(end.message.details.result.stdout, "ok");
		assert.deepEqual(end.message.details.run, { version: 1, phase: "end", attemptId: start.message.details.run.attemptId, outcome: "success" });
		const [task] = await h.tasks();
		assert.equal(task.history[0].attemptId, start.message.details.run.attemptId);
	} finally { await h.close(); }
});

test("the start names the exact notification it duplicates", async () => {
	const notices = [];
	const h = await runOnce(async () => ({ code: 0, stdout: "", stderr: "" }), (runtime) => {
		runtime.context.hasUI = true;
		runtime.context.ui = { notify: (text, kind) => notices.push({ text, kind }), setStatus() {}, setWidget() {} };
	});
	try {
		const [start] = runMessages(h);
		const running = notices.find(({ text }) => text.startsWith("Running scheduled command"));
		assert.ok(running);
		assert.equal(start.message.details.run.notice, running.text);
	} finally { await h.close(); }
});

test("failed, killed, and thrown runs end with an error outcome", async () => {
	for (const exec of [
		async () => ({ code: 3, stdout: "", stderr: "bad" }),
		async () => ({ code: 0, stdout: "", stderr: "", killed: true }),
		async () => { throw new Error("cannot execute"); },
	]) {
		const h = await runOnce(exec);
		try {
			const [start, end] = runMessages(h);
			assert.equal(runMessages(h).length, 2);
			assert.equal(end.message.details.run.phase, "end");
			assert.equal(end.message.details.run.outcome, "error");
			assert.equal(end.message.details.run.attemptId, start.message.details.run.attemptId);
		} finally { await h.close(); }
	}
});

test("separate runs of a recurring task get separate attempt ids", async () => {
	const h = await harness(ROOT, async () => ({ code: 0, stdout: "", stderr: "" }));
	try {
		await h.start();
		await h.call("schedule_task", { action: "shell", type: "interval", schedule: "0.05s", command: "check", maxRuns: 2 });
		await until(async () => (await h.tasks())[0]?.runCount === 2, "two runs");
		const events = runMessages(h).map(({ message }) => message.details.run);
		assert.deepEqual(events.map((event) => event.phase), ["start", "end", "start", "end"]);
		assert.equal(events[0].attemptId, events[1].attemptId);
		assert.equal(events[2].attemptId, events[3].attemptId);
		assert.notEqual(events[0].attemptId, events[2].attemptId);
	} finally { await h.close(); }
});

test("non-shell actions send no run events", async () => {
	const h = await harness(ROOT, async () => ({ code: 0, stdout: "", stderr: "" }));
	try {
		await h.start();
		await h.call("schedule_task", { action: "notify", type: "once", schedule: "0.02s", message: "hi" });
		await until(async () => (await h.tasks())[0]?.runCount === 1, "notify ran");
		assert.equal(runMessages(h).length, 0);
		assert.ok(h.messages.some(({ message }) => message.content === "🔔 hi"));
	} finally { await h.close(); }
});

test("start events stay out of model context", async () => {
	const h = await runOnce(async () => ({ code: 0, stdout: "", stderr: "" }));
	try {
		const [start, end] = runMessages(h).map(({ message }) => ({ role: "custom", ...message }));
		const user = { role: "user", content: "hi" };
		assert.deepEqual(h.events.context({ messages: [user, start, end] }).messages, [user, end]);
		assert.equal(h.events.context({ messages: [user, end] }), undefined);
	} finally { await h.close(); }
});
