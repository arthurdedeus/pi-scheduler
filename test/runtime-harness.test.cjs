"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { dirname, resolve } = require("node:path");
const { createRequire } = require("node:module");
const { harness, until } = require("./helpers/runtime-harness.cjs");

const ROOT = resolve(__dirname, "..");
const localRequire = createRequire(resolve(ROOT, "extensions/scheduler/index.ts"));

for (const kind of ["task", "wake", "refresh"]) {
	test(`harness close drains in-flight ${kind} work before removing state`, async (t) => {
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		let active = 0;
		let started = false;
		let refresh;
		const overrides = {
			require(id) {
				const module = localRequire(id);
				if (id === "./task-store.cjs" && kind === "wake") {
					return { createTaskStore(options) {
						const store = module.createTaskStore(options);
						return { ...store, transact: mutator => store.transact(async tasks => {
							const result = await mutator(tasks);
							if (tasks[0]?.history?.[0]?.wakeDisposition === "delivered") {
								started = true;
								await gate;
							}
							return result;
						}) };
					} };
				}
				if (id !== "./scheduler-coordination.cjs") return module;
				return {
					...module,
					runInBackground(...args) {
						active++;
						return module.runInBackground(...args).finally(() => { active--; });
					},
					createRefreshLoop(options) {
						return module.createRefreshLoop({ ...options, run: async (...args) => {
							active++;
							started = true;
							try { await gate; return await options.run(...args); }
							finally { active--; }
						} });
					},
				};
			},
			setInterval(callback) { refresh = callback; return { unref() {} }; },
			clearInterval() {},
		};
		const h = await harness(ROOT, async () => {
			if (kind === "task") { started = true; await gate; }
			return { code: 0, stdout: "done", stderr: "" };
		}, overrides);
		const remove = fs.rm;
		try {
			await h.start();
			if (kind !== "refresh") {
				await h.call("schedule_task", { action: "shell", command: "check", schedule: "0.01s", wakeOn: "always" });
			} else {
				void refresh();
			}
			await until(() => started, `${kind} started`);
			// Observe cleanup directly: don't depend on how long fs.rm takes to race a writer.
			t.mock.method(fs, "rm", async (...args) => {
				assert.equal(active, 0, "state must outlive all background work");
				return remove(...args);
			});
			const closing = h.close();
			setImmediate(release);
			await assert.doesNotReject(closing);
			await assert.rejects(fs.stat(dirname(h.stateFile)), { code: "ENOENT" });
		} finally {
			release();
			await until(() => active === 0, "background work settled");
			await remove(dirname(h.stateFile), { recursive: true, force: true });
		}
	});
}
