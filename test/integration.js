// The controller's Sentry plugin checks CI before loading its SDK.
// Set this before loading the harness so npm setup and every child process
// inherit it, including when integration tests are run locally.
process.env.CI = "true";

const path = require("path");
const { tests } = require("@iobroker/testing");

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."));
