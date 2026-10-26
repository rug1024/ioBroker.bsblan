"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { once, EventEmitter } = require("node:events");
const { describe, it, afterEach } = require("mocha");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();
const BSB = require("../lib/bsb");

const deferred = () => {
    /** @type {(value?: any) => void} */
    let resolve = () => {};
    const promise = new Promise(r => (resolve = r));
    return { promise, resolve };
};

function client(request, options = {}) {
    const Client = proxyquire("../lib/bsb", { "promise-request-retry": request });
    return new Client("device", "user", "secret", options);
}

class FakeAdapter extends EventEmitter {
    constructor() {
        super();
        this.config = { host: "device", values: "8740", interval: "10" };
        this.log = { info: sinon.spy(), debug: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
        this.setState = sinon.spy();
        this.setStateAsync = sinon.stub().resolves();
        this.setObjectAsync = sinon.stub().resolves();
        this.setObjectNotExistsAsync = sinon.stub().resolves();
        this.extendObjectAsync = sinon.stub().resolves();
        this.getAdapterObjectsAsync = sinon.stub().resolves({});
        this.getObjectAsync = sinon.stub().resolves();
    }
}

function adapter() {
    return proxyquire("../main", {
        "@iobroker/adapter-core": { Adapter: FakeAdapter },
        "./lib/bsb": BSB,
        "./lib/config": require("../lib/config"),
        "./lib/bsb_utils": require("../lib/bsb_utils"),
    })();
}

afterEach(() => sinon.restore());

describe("BSB request reliability", () => {
    it("serializes real HTTP reads, batched reads and writes", async () => {
        let active = 0;
        let peak = 0;
        const paths = [];
        const server = http.createServer((req, res) => {
            paths.push(req.url);
            peak = Math.max(peak, ++active);
            res.on("close", () => active--);
            req.resume();
            setTimeout(() => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(req.url === "/JS" ? { 8740: { status: 1 } } : {}));
            }, 10);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const bsb = new BSB(`127.0.0.1:${address.port}`, "", "", { batchSize: 2 });
        try {
            await Promise.all([
                bsb.queryInfo(),
                bsb.getParameter([1, 2, 3, 4, 5]),
                bsb.write("8740", 21, 0),
                bsb.getParameterDefinitionAsync([6, 7, 8]),
            ]);
            assert.equal(peak, 1);
            assert.deepEqual(paths, ["/JI", "/JQ=1,2", "/JQ=3,4", "/JQ=5", "/JS", "/JC=6,7", "/JC=8"]);
        } finally {
            bsb.close();
            await new Promise(resolve => server.close(resolve));
        }
    });

    it("does not request an empty parameter list", async () => {
        const request = sinon.stub().resolves({});
        const bsb = client(request);
        assert.deepEqual(await bsb.getParameter([]), {});
        sinon.assert.notCalled(request);
    });

    it("recovers the queue after an HTTP failure and reports endpoint and duration", async () => {
        const request = sinon.stub();
        request.onFirstCall().rejects({ code: "ETIMEDOUT", message: "secret" });
        request.onSecondCall().resolves({});
        const bsb = client(request, { requestTimeout: 42 });
        const failed = bsb.getParameter([8740]);
        const next = bsb.queryInfo();
        await assert.rejects(failed, error => {
            assert.ok(error instanceof Error);
            assert.equal(error.name, "BSBRequestError");
            assert.match(error.message, /GET \/JQ=8740 failed after \d+ ms/);
            assert.match(error.message, /ETIMEDOUT; timeout 42000 ms/);
            assert.ok(!error.message.includes("secret"));
            return true;
        });
        assert.deepEqual(await next, {});
        assert.equal(request.firstCall.args[0].timeout, 42000);
    });

    it("honors real HTTP timeouts and subsequently recovers", async function () {
        this.timeout(10000);
        let requests = 0;
        const server = http.createServer((req, res) => {
            requests++;
            if (req.url === "/JI") {
                res.setHeader("Content-Type", "application/json");
                res.end("{}");
            }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const bsb = new BSB(`127.0.0.1:${address.port}`, "", "", { requestTimeout: 1 });
        try {
            await assert.rejects(bsb.getParameter([8740]), { name: "BSBRequestError" });
            assert.deepEqual(await bsb.queryInfo(), {});
            assert.equal(requests, 3); // Two read attempts, then a successful info request.
        } finally {
            bsb.close();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });

    it("rejects malformed responses without classifying them as transport failures", async () => {
        const bsb = client(sinon.stub().resolves("<html>error</html>"));
        await assert.rejects(bsb.queryInfo(), error => {
            assert.ok(error instanceof Error);
            assert.notEqual(error.name, "BSBRequestError");
            assert.match(error.message, /Invalid JSON object/);
            return true;
        });
    });

    it("uses safe defaults for invalid settings and accepts UI string values", async () => {
        const bsb = client(async () => ({}), { requestTimeout: "42", batchSize: "7", metadataCacheSeconds: "0" });
        assert.equal(bsb.timeout, 42000);
        assert.equal(bsb.batchSize, 7);
        assert.equal(bsb.cacheTtl, 0);
        const invalid = client(async () => ({}), { requestTimeout: -1, batchSize: 31, metadataCacheSeconds: "no" });
        assert.equal(invalid.timeout, 15000);
        assert.equal(invalid.batchSize, 30);
        assert.equal(invalid.cacheTtl, 300000);
    });

    it("does not retry writes and keeps the configured destination", async () => {
        const request = sinon.stub().resolves({ 8740: { status: 1 } });
        await client(request).write("8740!6", 21, 0);
        assert.equal(request.firstCall.args[0].retry, 1);
        assert.equal(request.firstCall.args[0].body.Parameter, "8740!6");
    });

    it("rejects unknown write statuses explicitly", async () => {
        await assert.rejects(client(async () => ({})).write("8740", 21, 0), { name: "BSBWriteError" });
    });

    it("does not start queued requests after closing", async () => {
        const started = deferred();
        const pending = deferred();
        const request = sinon.stub().callsFake(() => {
            started.resolve();
            return pending.promise;
        });
        const bsb = client(request);
        const running = bsb.queryInfo();
        await started.promise;
        const queued = bsb.getParameter([8740]);
        bsb.close();
        pending.resolve({});
        await running;
        await assert.rejects(queued, { name: "BSBStoppedError" });
        sinon.assert.calledOnce(request);
    });

    it("does not block a separate adapter client", async () => {
        const pending = deferred();
        const first = client(() => pending.promise).queryInfo();
        await client(async () => ({})).queryInfo();
        pending.resolve({});
        await first;
    });
});

describe("BSB metadata and values", () => {
    for (const [value, count] of [
        ["", 0],
        ["8700", 1],
        ["8700, 8740,8830,", 3],
    ]) {
        it(`counts average parameters in ${JSON.stringify(value)}`, async () => {
            const request = sinon.stub().resolves({ list: { parameter: 13, value } });
            const bsb = client(request);
            assert.equal(await bsb.query24AverageCount(), count);
        });
    }

    it("does not query average parameters when no averages are configured", async () => {
        const request = sinon.stub().resolves({});
        const bsb = client(request);
        assert.deepEqual(await bsb.query24AveragesV2(), {});
        sinon.assert.calledOnce(request);
        assert.ok(request.firstCall.args[0].uri.endsWith("/JL"));
    });

    it("caches successful metadata, deduplicates concurrent lookups and refreshes on expiry", async () => {
        const now = sinon.stub(Date, "now").returns(1000);
        const request = sinon.stub().resolves({ api_version: "2.0" });
        const bsb = client(request, { metadataCacheSeconds: 5 });
        assert.deepEqual(await Promise.all([bsb.queryVersion(), bsb.queryVersion()]), ["2.0", "2.0"]);
        await bsb.queryVersion();
        sinon.assert.calledOnce(request);
        now.returns(6001);
        await bsb.queryVersion();
        sinon.assert.calledTwice(request);
    });

    it("does not cache failed metadata lookups", async () => {
        const request = sinon.stub();
        request.onFirstCall().rejects({ code: "ETIMEDOUT" });
        request.onSecondCall().resolves({ api_version: "2.0" });
        const bsb = client(request);
        await assert.rejects(bsb.queryVersion());
        assert.equal(await bsb.queryVersion(), "2.0");
        sinon.assert.calledTwice(request);
    });

    it("refreshes average configuration after cache expiry", async () => {
        const now = sinon.stub(Date, "now").returns(0);
        const request = sinon.stub();
        request.onFirstCall().resolves({ a: { parameter: 13, value: "8700" } });
        request.onSecondCall().resolves({ a: { parameter: 13, value: "8700,8740" } });
        const bsb = client(request, { metadataCacheSeconds: 1 });
        assert.equal(await bsb.query24AverageCount(), 1);
        assert.equal(await bsb.query24AverageCount(), 1);
        now.returns(1001);
        assert.equal(await bsb.query24AverageCount(), 2);
    });

    it("retains firmware v1 average endpoint support", async () => {
        const request = sinon.stub();
        request.onFirstCall().resolves({});
        request.onSecondCall().resolves({});
        await client(request).query24hAverages();
        assert.ok(request.secondCall.args[0].uri.endsWith("/JA"));
    });

    it("honors explicitly read-only legacy parameters", () => {
        const bsb = new BSB("device");
        assert.equal(bsb.isReadWrite("8700"), false);
        assert.equal(bsb.isReadWrite("700"), true);
    });

    it("marks unavailable numeric values as null/error and preserves real zero", async () => {
        const a = adapter();
        for (const value of ["---", "", "invalid", "12invalid", null, undefined, "Infinity"]) {
            assert.deepEqual(a.parameterState({ value, dataType: 0 }), { val: null, ack: true, q: 1 });
        }
        assert.deepEqual(a.parameterState({ value: "0", dataType: 0 }), { val: 0, ack: true, q: 0 });
        await a.setStates({ 8740: { name: "Temperature", value: "---", dataType: 0 } });
        await a.setStates({ 8740: { name: "Temperature", value: "21.5", dataType: 0 } });
        assert.equal(a.setStateAsync.firstCall.args[1].q, 1);
        assert.deepEqual(a.setStateAsync.secondCall.args[1], { val: 21.5, ack: true, q: 0 });
    });

    it("updates metadata for valid IDs and keeps averages read-only", async () => {
        const a = adapter();
        const obj = {
            _id: "bsblan.0.Temperature_(8740)",
            native: { id: "8740", bsb: { name: "Temperature", dataType: 0 } },
            common: { write: false, type: "number" },
        };
        a.getAdapterObjectsAsync.resolves({ value: obj });
        a.bsb = new BSB("device");
        sinon.stub(a.bsb, "getParameterDefinitionAsync").resolves({ 8740: { readonly: 0, dataType: 0 } });
        await a.updateNativeData();
        sinon.assert.calledOnce(a.setObjectAsync);
        assert.equal(obj.common.write, true);
        assert.equal(obj.native.bsb.name, "Temperature");
        const avg = { _id: "average", native: { id: "20050", avg: "24h", bsb: {} }, common: { write: true } };
        a.fixReadWrite(avg);
        assert.equal(avg.common.write, false);
    });

    it("keeps destination suffixes during object detection", async () => {
        const a = adapter();
        assert.deepEqual([...(await a.detectNewObjects(["8740!6"]))], ["8740!6"]);
        a.getAdapterObjectsAsync.resolves({ value: { native: { id: "8740", bsb: {} } } });
        assert.deepEqual([...(await a.detectNewObjects(["8740!6"]))], []);
    });
});

describe("Adapter polling and connection state", () => {
    it("initializes offline silently before the first request", async () => {
        const a = adapter();
        a.subscribeStates = sinon.spy();
        sinon.stub(a, "migrateExistingObjects").resolves();
        sinon.stub(a, "updateNativeData").resolves();
        sinon.stub(a, "setupDefaultObjects").resolves();
        sinon.stub(a, "update").resolves();
        await a.onReady();
        assert.deepEqual(a.setState.args, [["info.connection", false, true]]);
        sinon.assert.notCalled(a.log.error);
        a.connectionHandler(true);
        assert.deepEqual(a.setState.lastCall.args, ["info.connection", true, true]);
    });

    function pollingAdapter() {
        const a = adapter();
        a.values = ["8740"];
        a.bsb = new BSB("device");
        sinon.stub(a, "updateDefaultStates").resolves();
        sinon.stub(a, "detectNewObjects").resolves(new Set());
        sinon.stub(a, "initializeParameters").resolves();
        sinon.stub(a, "refreshTimer");
        sinon.stub(a.bsb, "getParameter").resolves({});
        sinon.stub(a.bsb, "query24hAverages").resolves({});
        return a;
    }

    it("never reports connection success before a failed parameter request", async () => {
        const a = pollingAdapter();
        a.bsb.getParameter.rejects(Object.assign(new Error("timeout"), { name: "BSBRequestError" }));
        await a.update();
        assert.deepEqual(a.setState.args, [["info.connection", false, true]]);
        sinon.assert.calledOnce(a.refreshTimer);
    });

    it("reports connection success only after a response arrives", async () => {
        const a = pollingAdapter();
        const started = deferred();
        const pending = deferred();
        a.bsb.getParameter.callsFake(() => {
            started.resolve();
            return pending.promise;
        });
        const update = a.update();
        await started.promise;
        sinon.assert.notCalled(a.setState);
        pending.resolve({});
        await update;
        assert.deepEqual(a.setState.args, [["info.connection", true, true]]);
    });

    it("does not disconnect for a local processing error or rejected write", () => {
        const a = adapter();
        a.errorHandler(new Error("database unavailable"));
        a.errorHandler(Object.assign(new Error("read only"), { name: "BSBWriteError" }));
        sinon.assert.notCalled(a.setState);
        a.errorHandler(Object.assign(new Error("timeout"), { name: "BSBRequestError" }));
        assert.deepEqual(a.setState.args, [["info.connection", false, true]]);
    });

    it("prevents overlapping polling and schedules one successor after an info failure", async () => {
        const a = pollingAdapter();
        const pending = deferred();
        a.updateDefaultStates.callsFake(() => pending.promise);
        const first = a.update();
        await a.update();
        sinon.assert.calledOnce(a.updateDefaultStates);
        pending.resolve();
        await first;
        sinon.assert.calledOnce(a.refreshTimer);
        a.refreshTimer.resetHistory();
        a.updateDefaultStates.rejects(new Error("info failure"));
        await a.update();
        sinon.assert.calledOnce(a.refreshTimer);
    });

    it("does not restart polling or write late states after unload", async () => {
        const a = adapter();
        a.interval = 10000;
        a.bsb = new BSB("device");
        a.refreshTimer();
        const callback = sinon.spy();
        a.onUnload(callback);
        sinon.assert.calledOnce(callback);
        assert.equal(a.bsb.closed, true);
        a.refreshTimer();
        assert.ok(!a.timer || a.timer._destroyed);
        a.connectionHandler(true);
        await a.setStates({ 8740: { name: "Temperature", value: "21", dataType: 0 } });
        sinon.assert.notCalled(a.setState);
        sinon.assert.notCalled(a.setStateAsync);
    });

    it("preserves destination on writes and readback", async () => {
        const a = adapter();
        a.values = ["8740!6"];
        a.bsb = new BSB("device");
        sinon.stub(a.bsb, "write").resolves({ 8740: { status: 1 } });
        sinon.stub(a.bsb, "getParameter").resolves({});
        a.getObjectAsync.resolves({ native: { id: "8740", bsb: { dataType: 0 } }, common: { write: true } });
        await a.onStateChange("temperature", { ack: false, val: 21 });
        sinon.assert.calledWith(a.bsb.write, "8740!6", 21, 0);
        sinon.assert.calledWith(a.bsb.getParameter, ["8740!6"]);
    });
});
