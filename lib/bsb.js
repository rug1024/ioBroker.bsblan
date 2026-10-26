const rp = require("promise-request-retry");
const config = require("./config");

module.exports = class BSB {
    constructor(host, user, password, options = {}) {
        this.host = host;
        this.queue = import("p-queue").then(({ default: PQueue }) => new PQueue({ concurrency: 1 }));
        this.closed = false;
        this.timeout = this.boundedInteger(options.requestTimeout, 15, 1, 300) * 1000;
        this.batchSize = this.boundedInteger(options.batchSize, 30, 1, 30);
        this.cacheTtl = this.boundedInteger(options.metadataCacheSeconds, 300, 0, 86400) * 1000;
        this.cache = new Map();
        if (user && password) {
            this.auth = {
                Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
            };
        } else {
            this.auth = {};
        }
        this.id_regex = /^(\d+)(\.\d+)?(!\d+)?$/;
    }

    validateParameterId(id) {
        return this.id_regex.test(id);
    }

    getId(id) {
        // returns the id without the address "20200.0!6" => "20200.0"
        // because the key in the response object is not having the address !6
        const match = this.id_regex.exec(id);
        let result = "";
        if (match != null) {
            result += match[1];
            if (match[2]) {
                result += match[2];
            }
        } else {
            throw {
                name: "Get ID Error",
                message: `Parameter "${id}" is invalid. Can not extract id.`,
            };
        }
        return result;
    }

    getBaseId(id) {
        // returns the integer of a parameter "20200.0!6" => "20200"
        // because the category only knows full integers
        const match = this.id_regex.exec(id);
        if (match != null) {
            return match[1];
        }
        throw {
            name: "Base ID Error",
            message: `Parameter "${id}" is invalid. Can not extract base id.`,
        };
    }

    trimParameterId(id) {
        // the api does not return the .0 in the id field. Only >0 is available in the api.
        // So do we
        return id.replace(/\.0/g, "");
    }

    valueInCategory(id, category) {
        // use base number of the id - it can be 20100.0!6 => 20100 is relevant
        const baseId = this.getBaseId(id);
        return baseId >= category["min"] && baseId <= category["max"];
    }

    boundedInteger(value, fallback, min, max) {
        if (value === undefined || value === null || value === "") {
            return fallback;
        }
        const number = Number(value);
        return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
    }

    close() {
        this.closed = true;
        this.cache.clear();
    }

    async request(endpoint, extra = {}) {
        return (await this.queue).add(() => this.executeRequest(endpoint, extra));
    }

    async executeRequest(endpoint, extra = {}) {
        if (this.closed) {
            throw Object.assign(new Error("BSB client is stopping"), { name: "BSBStoppedError" });
        }
        const options = { ...this.options(`http://${this.host}${endpoint}`), ...extra };
        const started = Date.now();
        let response;
        try {
            response = await rp(options);
        } catch (error) {
            // Do not log request objects/headers: they can contain credentials.
            const code = String(error.code || error.cause?.code || error.statusCode || "request error");
            throw Object.assign(
                new Error(
                    `${extra.method || "GET"} ${endpoint} failed after ${Date.now() - started} ms ` +
                        `(${code}; timeout ${this.timeout} ms per attempt)`,
                ),
                { name: "BSBRequestError" },
            );
        }
        if (!response || typeof response !== "object" || Array.isArray(response)) {
            throw new Error(`Invalid JSON object received from ${endpoint}`);
        }
        return response;
    }

    async cached(key, fetchValue) {
        const existing = this.cache.get(key);
        if (existing && existing.expires > Date.now()) {
            return existing.promise;
        }
        const entry = { expires: Infinity, promise: Promise.resolve().then(fetchValue) };
        this.cache.set(key, entry);
        try {
            const value = await entry.promise;
            entry.expires = Date.now() + this.cacheTtl;
            return value;
        } catch (error) {
            if (this.cache.get(key) === entry) {
                this.cache.delete(key);
            }
            throw error;
        }
    }

    async query(values, endpoint) {
        const valuesArray = [...values];
        if (valuesArray.length === 0) {
            return {};
        }
        // Construct and start requests only after the queue grants this task a slot.
        return (await this.queue).add(async () => {
            const results = {};
            for (let index = 0; index < valuesArray.length; index += this.batchSize) {
                const slice = valuesArray.slice(index, index + this.batchSize);
                Object.assign(results, await this.executeRequest(`${endpoint}=${slice.join(",")}`));
            }
            return results;
        });
    }

    async query24hAverages() {
        const version = await this.queryVersion();
        switch (version) {
            case "1.0":
                return await this.query24hAveragesV1();
            default:
                return await this.query24AveragesV2();
        }
    }

    // bsb_lan v1 only
    async query24hAveragesV1() {
        return this.request("/JA");
    }

    // since bsb_lan v2
    async query24AveragesV2() {
        // 24h values are stored in 20050-20099 since bsb_lan v2
        const count = await this.query24AverageCount();

        // create the parameter array starting from 20050
        const parameters = this.range(count, 20050);
        return await this.getParameter(parameters);
    }

    async query24AverageCount() {
        return this.cached("averageCount", async () => {
            const response = await this.queryConfiguration();
            const entry = Object.values(response).find(p => p && Number(p.parameter) === 13);
            if (!entry || entry.value === "" || entry.value == null) {
                return 0;
            }
            const parameters = String(entry.value)
                .split(",")
                .map(value => value.trim())
                .filter(value => value.length > 0);
            // Firmware reserves 20050..20099 for averages.
            return Math.min(parameters.length, 50);
        });
    }

    async queryVersion() {
        return this.cached("version", async () => {
            const response = await this.request("/JV");
            return String(response.api_version ?? "1.0");
        });
    }

    async queryConfiguration() {
        return this.request("/JL");
    }

    async categories() {
        return this.request("/JK=ALL");
    }

    async category(id) {
        return this.request(`/JK=${id}`);
    }

    async write(id, value, type) {
        const response = await this.request("/JS", {
            method: "POST",
            body: {
                Parameter: id,
                Value: this.convertToBsb(value, type),
                Type: `${this.getWriteType(this.getId(id))}`,
            },
            // A timed-out write may already have reached the heating controller.
            retry: 1,
        });
        return this.handleJSResponse(this.getId(id), response);
    }

    // since bsb_lan 2.x
    async queryInfo() {
        return this.request("/JI");
    }

    // since bsb_lan 2.x
    async getParameterDefinitionAsync(values) {
        return await this.query(values, "/JC");
    }

    async getParameter(values) {
        return await this.query(values, "/JQ");
    }

    getWriteType(id) {
        if (id in config.staticV1Config) {
            return config.staticV1Config[id].writeType;
        }
        // 1 is default
        return 1;
    }

    isReadWrite(id) {
        return id in config.staticV1Config ? config.staticV1Config[id].rw : true;
    }

    handleJSResponse(id, response) {
        const object = response[id];
        if (!object || ![0, 1, 2].includes(object.status)) {
            throw Object.assign(new Error(`Invalid write response for parameter "${id}"`), { name: "BSBWriteError" });
        }
        switch (object.status) {
            case 0:
                // error
                throw {
                    name: "BSBWriteError",
                    message: `Could not set value: "${JSON.stringify(response)}"`,
                };
            case 1:
                // OK
                return response;
            case 2:
                // readonly
                throw {
                    name: "BSBWriteError",
                    message: `Parameter "${id}" is read-only. Can not be set or BSB_Lan firwmare was not compiled with write-flag for this parameter. ${JSON.stringify(response)}`,
                };
        }
    }

    convertToBsb(value, type) {
        switch (type) {
            case 0: // VALS
                return value;
            case 1: // ENUM
                return value;
            case 2: // BITS
                return value;
            case 3: // WDAY, (not used)
                return value;
            case 4: // HHMM, hr:mm => hr.mm
                return value.replace(":", ".");
            case 5: // DTTM, Date and time ("09.01.2021 12:42:02"), must be set as "09.01.2021_12:42:02"
                return value.replace(" ", "_");
            case 6: // DDMM, Day and month ("25.10."), no special handling
                return value;
            case 7: // STRN
                return value;
            case 8: // DWHM, PPS time (day of week, hour:minute)
                return value;
            case 9: // TMPR, Time program "1. 04:00 - 21:00 2. --:-- - --:-- 3. --:-- - --:--" => "04:00-21:00_xx:xx-xx:xx_xx:xx-xx:x"
                return value
                    .replace("1. ", "")
                    .replace(" 2. ", "_")
                    .replace(" 3. ", "_")
                    .replace(/--/g, "xx")
                    .replace(/ - /g, "-");
        }
    }

    options(uri) {
        return {
            uri: uri,
            headers: this.auth,
            json: true,
            timeout: this.timeout,
            retry: 2,
            delay: 1000,
            verbose_logging: false,
        };
    }

    range(size, startAt = 0) {
        return [...Array(size).keys()].map(i => i + startAt);
    }
};
