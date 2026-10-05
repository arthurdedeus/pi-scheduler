"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { harness, until } = require("./helpers/runtime-harness.cjs");
const core = require("../extensions/scheduler/scheduler-core.cjs");

const ROOT = resolve(__dirname, "..");
const ok = async () => ({ code: 0, stdout: "out", stderr: "" });

function deliver(h, text, { source = "extension", timestamp = Date.now(), content } = {}) {
	h.events.input({ type: "input", text, source }, h.context);
	const message = { role: "user", content: content ?? [{ type: "text", text }], timestamp };
	h.events.message_end({ type: "message_end", message }, h.context);
	return message;
}

async function firePrompt(args = {}) {
	const h = await harness(ROOT, ok);
	await h.start();
	await h.call("schedule_task", { action: "prompt", type: "once", schedule: "0.02s", name: "Check CI", prompt: "Look at CI.\n- step one\n```\ncode\n```", ...args });
	await until(async () => h.wakes.length === 1, "prompt delivered");
	return h;
}

test("a delivered scheduled prompt records one origin entry linked by timestamp and length", async () => {
	const h = await firePrompt();
	try {
		const [wake] = h.wakes;
		assert.match(wake.text, /^\[Scheduled task \S+ fired\]\nName: Check CI\n/);
		assert.equal(wake.options, undefined, "idle delivery is unchanged");
		const message = deliver(h, wake.text, { timestamp: 1234 });
		assert.equal(h.entries.length, 1);
		const [{ customType, data }] = h.entries;
		assert.equal(customType, "scheduled-prompt");
		const [task] = await h.tasks();
		assert.deepEqual(data, {
			version: 1,
			kind: "prompt",
			taskId: task.id,
			attemptId: task.history[0].attemptId,
			name: "Check CI",
			message: { timestamp: message.timestamp, textLength: wake.text.length },
		});
		assert.ok(!JSON.stringify(data).includes("Look at CI"), "the entry does not repeat the prompt");
		assert.equal(h.messages.length, 0, "no model-visible message is added");
	} finally { await h.close(); }
});

test("busy delivery still queues the prompt as a follow-up", async () => {
	const h = await harness(ROOT, ok);
	try {
		h.context.isIdle = () => false;
		await h.start();
		await h.call("schedule_task", { action: "prompt", type: "once", schedule: "0.02s", prompt: "hi" });
		await until(async () => h.wakes.length === 1, "prompt queued");
		assert.equal(h.wakes[0].options.deliverAs, "followUp");
		deliver(h, h.wakes[0].text);
		assert.equal(h.entries.length, 1);
		assert.equal(h.entries[0].data.name, undefined, "an unnamed task has no name");
	} finally { await h.close(); }
});

test("identical text typed by a person is never claimed", async () => {
	const h = await firePrompt();
	try {
		for (const source of ["interactive", "rpc"]) deliver(h, h.wakes[0].text, { source });
		assert.equal(h.entries.length, 0);
	} finally { await h.close(); }
});

test("a message seen without the scheduler's input event is not claimed", async () => {
	const h = await firePrompt();
	try {
		h.events.message_end({ type: "message_end", message: { role: "user", content: h.wakes[0].text, timestamp: 1 } }, h.context);
		assert.equal(h.entries.length, 0);
	} finally { await h.close(); }
});

test("text rewritten by another extension stays unclaimed", async () => {
	const h = await firePrompt();
	try {
		h.events.input({ type: "input", text: h.wakes[0].text, source: "extension" }, h.context);
		h.events.message_end({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "rewritten" }], timestamp: 1 } }, h.context);
		assert.equal(h.entries.length, 0);
	} finally { await h.close(); }
});

test("each run of a recurring prompt is a separate attempt", async () => {
	const h = await harness(ROOT, ok);
	try {
		await h.start();
		await h.call("schedule_task", { action: "prompt", type: "interval", schedule: "0.05s", prompt: "poll", maxRuns: 2 });
		await until(async () => h.wakes.length === 2, "two prompts");
		h.wakes.forEach((wake, index) => deliver(h, wake.text, { timestamp: 100 + index }));
		const [first, second] = h.entries.map(({ data }) => data);
		assert.equal(h.entries.length, 2);
		assert.notEqual(first.attemptId, second.attemptId);
		assert.deepEqual([first.message.timestamp, second.message.timestamp], [100, 101]);
		deliver(h, h.wakes[0].text, { timestamp: 200 });
		assert.equal(h.entries.length, 2, "a redelivered message is not claimed twice");
	} finally { await h.close(); }
});

test("a shell wake follow-up is recorded with the shell run's attempt", async () => {
	const h = await harness(ROOT, ok);
	try {
		await h.start();
		await h.call("schedule_task", { action: "shell", type: "once", schedule: "0.02s", name: "Build", command: "check", wakeOn: "always", followUpPrompt: "Report it" });
		await until(async () => h.wakes.length === 1, "follow-up delivered");
		assert.match(h.wakes[0].text, /Follow-up instruction:\nReport it$/);
		deliver(h, h.wakes[0].text);
		const run = h.messages.find(({ message }) => message.details?.run?.phase === "start").message.details.run;
		assert.equal(h.entries[0].data.kind, "followUp");
		assert.equal(h.entries[0].data.name, "Build");
		assert.equal(h.entries[0].data.attemptId, run.attemptId);
	} finally { await h.close(); }
});

test("a session change forgets prompts that never landed", async () => {
	const h = await firePrompt();
	try {
		const { text } = h.wakes[0];
		h.events.input({ type: "input", text, source: "extension" }, h.context);
		await h.events.session_shutdown({}, h.context);
		await h.start();
		h.events.message_end({ type: "message_end", message: { role: "user", content: text, timestamp: 1 } }, h.context);
		assert.equal(h.entries.length, 0);
	} finally { await h.close(); }
});

test("the tracker ignores non-user messages, missing timestamps, and old overflow", () => {
	const tracker = core.createPromptOriginTracker(2);
	const origin = { kind: "prompt", taskId: "t", attemptId: "a" };
	for (const text of ["one", "two", "three"]) {
		tracker.expect(text, origin);
		tracker.accept(text, "extension");
	}
	assert.equal(tracker.claim({ role: "user", content: "one", timestamp: 1 }), undefined, "overflow dropped the oldest");
	assert.equal(tracker.claim({ role: "custom", content: "two", timestamp: 1 }), undefined);
	assert.equal(tracker.claim({ role: "user", content: "two" }), undefined);
	assert.deepEqual(tracker.claim({ role: "user", content: "two", timestamp: 5 }).message, { timestamp: 5, textLength: 3 });
});
