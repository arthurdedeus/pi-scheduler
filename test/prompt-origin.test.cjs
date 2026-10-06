"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { harness, until } = require("./helpers/runtime-harness.cjs");
const core = require("../extensions/scheduler/scheduler-core.cjs");

const ROOT = resolve(__dirname, "..");
const ok = async () => ({ code: 0, stdout: "out", stderr: "" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function harnessWithSession() {
	const h = await harness(ROOT, ok);
	h.sessionEntries = [];
	h.context.sessionManager.getEntries = () => h.sessionEntries;
	return h;
}

// Mirrors Pi: message_end handlers see the message object, then Pi persists that same object.
async function deliver(h, text, { source = "extension", timestamp = Date.now(), persist = true } = {}) {
	h.events.input({ type: "input", text, source }, h.context);
	const message = { role: "user", content: [{ type: "text", text }], timestamp };
	h.events.message_end({ type: "message_end", message }, h.context);
	const id = `entry-${h.sessionEntries.length + 1}`;
	if (persist) h.sessionEntries.push({ type: "message", id, message });
	await tick();
	return { message, id };
}

async function firePrompt(args = {}) {
	const h = await harnessWithSession();
	await h.start();
	await h.call("schedule_task", { action: "prompt", type: "once", schedule: "0.02s", name: "Check CI", prompt: "Look at CI.\n- step one\n```\ncode\n```", ...args });
	await until(async () => h.wakes.length === 1, "prompt delivered");
	return h;
}

test("a delivered scheduled prompt records one origin entry naming its own session entry", async () => {
	const h = await firePrompt();
	try {
		const [wake] = h.wakes;
		assert.match(wake.text, /^\[Scheduled task \S+ fired\]\nName: Check CI\n/);
		assert.ok(wake.text.endsWith("Look at CI. - step one ``` code ```"), "the prompt keeps the scheduler's existing whitespace compaction");
		assert.equal(wake.options, undefined, "idle delivery is unchanged");
		const { id } = await deliver(h, wake.text);
		assert.equal(h.entries.length, 1);
		const [{ customType, data }] = h.entries;
		assert.equal(customType, "scheduled-prompt");
		const [task] = await h.tasks();
		assert.deepEqual({ ...data }, { version: 2, kind: "prompt", taskId: task.id, attemptId: task.history[0].attemptId, name: "Check CI", messageEntryId: id });
		assert.ok(!JSON.stringify(data).includes("Look at CI"), "the entry does not repeat the prompt");
		assert.equal(h.messages.length, 0, "no model-visible message is added");
	} finally { await h.close(); }
});

test("a human message with identical text and timestamp keeps its own entry unclaimed", async () => {
	for (const order of ["human first", "scheduler first"]) {
		const h = await firePrompt();
		try {
			const { text } = h.wakes[0];
			const timestamp = 500;
			const human = order === "human first" ? await deliver(h, text, { source: "interactive", timestamp }) : null;
			const machine = await deliver(h, text, { timestamp });
			const lateHuman = order === "scheduler first" ? await deliver(h, text, { source: "interactive", timestamp }) : null;
			assert.equal(h.entries.length, 1, order);
			assert.equal(h.entries[0].data.messageEntryId, machine.id, order);
			assert.notEqual(h.entries[0].data.messageEntryId, (human ?? lateHuman).id, order);
		} finally { await h.close(); }
	}
});

test("the entry waits until Pi has persisted the message, and is written once", async () => {
	const h = await firePrompt();
	try {
		const { message } = await deliver(h, h.wakes[0].text, { persist: false });
		assert.equal(h.entries.length, 0);
		h.sessionEntries.push({ type: "message", id: "late", message: { ...message } });
		h.events.turn_end({ type: "turn_end" }, h.context);
		assert.equal(h.entries.length, 0, "a copy with the same content is not the message");
		h.sessionEntries.push({ type: "message", id: "real", message });
		h.events.turn_end({ type: "turn_end" }, h.context);
		h.events.agent_end({ type: "agent_end" }, h.context);
		assert.deepEqual(h.entries.map(({ data }) => data.messageEntryId), ["real"]);
	} finally { await h.close(); }
});

test("busy delivery still queues the prompt as a follow-up", async () => {
	const h = await harnessWithSession();
	try {
		h.context.isIdle = () => false;
		await h.start();
		await h.call("schedule_task", { action: "prompt", type: "once", schedule: "0.02s", prompt: "hi" });
		await until(async () => h.wakes.length === 1, "prompt queued");
		assert.equal(h.wakes[0].options.deliverAs, "followUp");
		await deliver(h, h.wakes[0].text);
		assert.equal(h.entries.length, 1);
		assert.equal(h.entries[0].data.name, undefined, "an unnamed task has no name");
	} finally { await h.close(); }
});

test("identical text typed by a person is never claimed", async () => {
	const h = await firePrompt();
	try {
		for (const source of ["interactive", "rpc"]) await deliver(h, h.wakes[0].text, { source });
		assert.equal(h.entries.length, 0);
	} finally { await h.close(); }
});

test("a message seen without the scheduler's input event is not claimed", async () => {
	const h = await firePrompt();
	try {
		const message = { role: "user", content: h.wakes[0].text, timestamp: 1 };
		h.events.message_end({ type: "message_end", message }, h.context);
		h.sessionEntries.push({ type: "message", id: "x", message });
		await tick();
		assert.equal(h.entries.length, 0);
	} finally { await h.close(); }
});

test("text rewritten by another extension stays unclaimed", async () => {
	const h = await firePrompt();
	try {
		h.events.input({ type: "input", text: h.wakes[0].text, source: "extension" }, h.context);
		const message = { role: "user", content: [{ type: "text", text: "rewritten" }], timestamp: 1 };
		h.events.message_end({ type: "message_end", message }, h.context);
		h.sessionEntries.push({ type: "message", id: "x", message });
		await tick();
		assert.equal(h.entries.length, 0);
	} finally { await h.close(); }
});

test("each run of a recurring prompt is a separate attempt with its own message entry", async () => {
	const h = await harnessWithSession();
	try {
		await h.start();
		await h.call("schedule_task", { action: "prompt", type: "interval", schedule: "0.05s", prompt: "poll", maxRuns: 2 });
		await until(async () => h.wakes.length === 2, "two prompts");
		const delivered = [];
		for (const wake of h.wakes) delivered.push(await deliver(h, wake.text, { timestamp: 100 }));
		const [first, second] = h.entries.map(({ data }) => data);
		assert.equal(h.entries.length, 2);
		assert.notEqual(first.attemptId, second.attemptId);
		assert.deepEqual([first.messageEntryId, second.messageEntryId], delivered.map(({ id }) => id));
		await deliver(h, h.wakes[0].text, { timestamp: 100 });
		assert.equal(h.entries.length, 2, "a third identical message is not claimed");
	} finally { await h.close(); }
});

test("a shell wake follow-up is recorded with the shell run's attempt", async () => {
	const h = await harnessWithSession();
	try {
		await h.start();
		await h.call("schedule_task", { action: "shell", type: "once", schedule: "0.02s", name: "Build", command: "check", wakeOn: "always", followUpPrompt: "Report it" });
		await until(async () => h.wakes.length === 1, "follow-up delivered");
		assert.match(h.wakes[0].text, /Follow-up instruction:\nReport it$/);
		await deliver(h, h.wakes[0].text);
		const run = h.messages.find(({ message }) => message.details?.run?.phase === "start").message.details.run;
		assert.equal(h.entries[0].data.kind, "followUp");
		assert.equal(h.entries[0].data.name, "Build");
		assert.equal(h.entries[0].data.attemptId, run.attemptId);
	} finally { await h.close(); }
});

test("a session change forgets prompts that never landed or were never persisted", async () => {
	const h = await firePrompt();
	try {
		const { text } = h.wakes[0];
		const { message } = await deliver(h, text, { persist: false });
		await h.events.session_shutdown({}, h.context);
		await h.start();
		h.sessionEntries.push({ type: "message", id: "after", message });
		h.events.agent_end({ type: "agent_end" }, h.context);
		await deliver(h, text);
		assert.equal(h.entries.length, 0);
	} finally { await h.close(); }
});

test("the tracker ignores non-user messages and drops old overflow", () => {
	const tracker = core.createPromptOriginTracker(2);
	const origin = { kind: "prompt", taskId: "t", attemptId: "a" };
	for (const text of ["one", "two", "three"]) {
		tracker.expect(text, origin);
		tracker.accept(text, "extension");
	}
	assert.equal(tracker.claim({ role: "user", content: "one" }), false, "overflow dropped the oldest");
	assert.equal(tracker.claim({ role: "custom", content: "two" }), false);
	const message = { role: "user", content: "two" };
	assert.equal(tracker.claim(message), true);
	assert.deepEqual(tracker.listOriginEntries([{ type: "message", id: "m", message }]), [{ version: 2, kind: "prompt", taskId: "t", attemptId: "a", messageEntryId: "m" }]);
	assert.deepEqual(tracker.listOriginEntries([{ type: "message", id: "m", message }]), [], "written once");
});
