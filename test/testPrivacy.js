"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("mocha");
const proxyquire = require("proxyquire").noCallThru();

describe("Error reporting opt-out", () => {
    it("disables Sentry before initializing the integration-test harness", () => {
        const previous = process.env.CI;
        delete process.env.CI;
        let initialized = false;
        try {
            proxyquire("./integration", {
                "@iobroker/testing": {
                    tests: {
                        integration() {
                            assert.equal(process.env.CI, "true");
                            initialized = true;
                        },
                    },
                },
            });
            assert.equal(initialized, true);
        } finally {
            if (previous === undefined) {
                delete process.env.CI;
            } else {
                process.env.CI = previous;
            }
        }
    });

    it("ships no Sentry dependency/plugin and explicitly disables adapter reporting", () => {
        const manifest = require("../io-package.json");
        const pkg = require("../package.json");
        assert.equal(manifest.common.disableDataReporting, true);
        assert.ok(!Object.hasOwn(manifest.common, "plugins"));
        for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
            assert.ok(!name.toLowerCase().includes("sentry"));
        }
    });
});
