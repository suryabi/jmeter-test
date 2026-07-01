#!/usr/bin/env node

const { execSync } = require("child_process");
const path = require("path");
const { runValidation } = require("./validate");

const root = path.join(__dirname, "..");
const uiDir = path.join(root, "ui");

function run(label, command, cwd = root) {
  console.log(`\n==> ${label}`);
  execSync(command, { cwd, stdio: "inherit" });
}

console.log("BriefingIQ JMeter Runner — setup\n");

run("Installing API dependencies", "npm install", root);
run("Installing UI dependencies", "npm install", uiDir);

console.log("\n==> Installing JMeter JSON plugins (jpgc-json)");
try {
  execSync("node scripts/install-jmeter-plugins.js", { cwd: root, stdio: "inherit" });
} catch {
  console.warn("\n⚠  JMeter plugin install skipped or failed — run: npm run install:jmeter-plugins");
}

console.log("\n==> Validating prerequisites");
const result = runValidation();

if (!result.ok) {
  console.log("\nSetup installed dependencies, but validation failed.");
  console.log("Resolve the errors above, then re-run: npm run validate\n");
  process.exit(1);
}

console.log("\nSetup complete.");
console.log("Start both servers with: npm run dev");
console.log("  API: http://localhost:5050");
console.log("  UI:  http://localhost:4200\n");
